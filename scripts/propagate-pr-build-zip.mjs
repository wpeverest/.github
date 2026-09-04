#!/usr/bin/env node
// One-shot bootstrap: for every repo in config/copilot-review-repos.json,
// detects that repo's build tooling (package.json/Gruntfile.js/gulpfile.js/
// composer.json) and opens a PR adding a generated pr-build-zip.yml caller.
// Never touches a repo that already has one -- a human may have hand-tuned
// it. See the onboard-pr-build-zip-repo skill for the detection heuristics
// and how to fix a wrong guess.
import { readFile } from "node:fs/promises";

const CONFIG_PATH = "config/copilot-review-repos.json";
const WORKFLOW_PATH = ".github/workflows/pr-build-zip.yml";
const REUSABLE_WORKFLOW_REF = "themegrill/.github/.github/workflows/pr-build-zip.yml";
const BRANCH_NAME = "tg-autopilot/add-pr-build-zip";

// Shared bucket for both orgs, copied verbatim into every generated file.
const ARTIFACTS_BUCKET = "themegrill-pr-artifacts";
const PUBLIC_BASE_URL = "https://themegrill-pr-artifacts.s3.amazonaws.com";
const S3_REGION = "us-east-1";

function tokenForOrg(org) {
  return org === "themegrill" ? process.env.BOT_TOKEN_THEMEGRILL : process.env.BOT_TOKEN;
}

async function gh(org, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenForOrg(org)}`,
      Accept: "application/vnd.github+json",
      ...options.headers,
    },
  });
  return res;
}

// Decoded text content of a repo file, or null if it doesn't exist.
async function getFile(org, repo, path) {
  const res = await gh(org, `/repos/${org}/${repo}/contents/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ${path} on ${org}/${repo}: ${res.status} ${await res.text()}`);
  const { content } = await res.json();
  return Buffer.from(content, "base64").toString("utf8");
}

// engines.node / composer's require.php often declare an ancient minimum
// (">=0.8.0", ">=5.6.20") left over from old boilerplate -- not a version
// anyone builds with today. Taking it literally breaks the build (e.g. it
// has produced literal Node 0.x). Only trust the declared number when it's
// at or above a sane modern floor; otherwise use the default.
function nodeVersionFromEngines(engines) {
  const raw = engines?.node;
  const DEFAULT = "20.x";
  if (!raw) return DEFAULT;
  const match = raw.match(/(\d+)/);
  if (!match) return DEFAULT;
  const major = Number(match[1]);
  return major >= 16 ? `${major}.x` : DEFAULT;
}

function phpVersionFromComposer(composerJson) {
  const raw = composerJson?.require?.php;
  const DEFAULT = "7.4";
  if (!raw) return DEFAULT;
  const match = raw.match(/(\d+\.\d+)/);
  if (!match) return DEFAULT;
  return Number(match[1]) >= 7.4 ? match[1] : DEFAULT;
}

// packageManager field, e.g. "pnpm@8.6.0" or "yarn@1.22.19" -> "pnpm"/"yarn".
function packageManagerFromField(field) {
  if (!field) return null;
  const match = field.match(/^(npm|yarn|pnpm)@/);
  return match ? match[1] : null;
}

// Finds a script that shells out to grunt/gulp with a task name (e.g.
// "grunt release:dev"). Returns what comes after the tool name, or null.
function extractToolInvocation(scriptBody, tool) {
  const match = scriptBody.match(new RegExp(`${tool}\\s+([\\w:.-]+)`));
  return match ? match[1] : null;
}

// Core detection logic: turns one repo's raw file contents into a build
// config, or null if nothing safe to auto-generate (skip, flag for a human).
function detectBuildConfig({ packageJsonRaw, composerJsonRaw, gruntfileRaw, gulpfileRaw, lockfiles, distignoreExists, repoName }) {
  const packageJson = packageJsonRaw ? JSON.parse(packageJsonRaw) : null;
  const composerJson = composerJsonRaw ? JSON.parse(composerJsonRaw) : null;

  // --- package manager ---------------------------------------------------
  // Priority: explicit "packageManager" field > lockfile presence > yarn as
  // a last-resort default.
  let packageManager = packageManagerFromField(packageJson?.packageManager);
  // Without a "packageManager" field, pnpm/action-setup can't auto-detect a
  // version and fails outright ("No pnpm version is specified") -- pin a
  // fallback in that case. Not needed for npm/yarn.
  const hasPackageManagerField = Boolean(packageManager);
  if (!packageManager) {
    if (lockfiles.pnpm) packageManager = "pnpm";
    else if (lockfiles.yarn) packageManager = "yarn";
    else if (lockfiles.npm) packageManager = "npm";
    else packageManager = "yarn";
  }
  const pnpmVersion = packageManager === "pnpm" && !hasPackageManagerField ? "9" : null;

  // --- node / php versions ------------------------------------------------
  const nodeVersion = nodeVersionFromEngines(packageJson?.engines);
  const phpVersion = phpVersionFromComposer(composerJson);

  // --- build command -------------------------------------------------------
  // Prefer a script named "release" over "build" -- "release" is the more
  // intentional name for "package a distributable"; "build" often just
  // means "compile assets" in these repos.
  const scripts = packageJson?.scripts || {};
  let buildCommand = null;
  let composerInstall = Boolean(composerJson);
  let zipGlob = "release/*.zip";

  for (const scriptName of ["release", "build"]) {
    const body = scripts[scriptName];
    if (!body) continue;

    // If the script shells out to grunt/gulp with a real task name, run
    // that task directly via the package manager rather than indirecting
    // through "run <scriptName>" -- keeps the generated command legible.
    const gruntTask = gruntfileRaw ? extractToolInvocation(body, "grunt") : null;
    const gulpTask = gulpfileRaw ? extractToolInvocation(body, "gulp") : null;

    // Whether buildCommand already packages a zip itself (a grunt/gulp
    // release task) vs. is just an asset-compile script with no packaging
    // step -- decides whether the .distignore fallback below is needed.
    let packagesItself = false;

    if (gruntTask) {
      buildCommand = `${packageManager} exec grunt ${gruntTask}`;
      packagesItself = true;
      // If the Gruntfile itself already runs composer (seen in the wild),
      // don't duplicate that in composer-install.
      if (gruntfileRaw && /composer\s+install/i.test(gruntfileRaw)) {
        composerInstall = false;
      }
    } else if (gulpTask) {
      // Keep the full script body (e.g. "yarn build && gulp release") --
      // anything chained before the gulp call is part of the pipeline.
      buildCommand = body;
      packagesItself = true;
    } else {
      // No grunt/gulp indirection -- likely just an asset-compile script
      // (wp-scripts build, webpack, ...) with no packaging step of its own.
      // See the .distignore fallback below for the one structural signal
      // reliable enough to act on automatically.
      buildCommand = `${packageManager} run ${scriptName}`;
    }

    // Neither grunt nor gulp packages it, but a .distignore exists: rsync
    // the repo into a folder named after itself excluding those patterns,
    // then zip that folder -- a real convention seen across several repos.
    if (!packagesItself && distignoreExists) {
      buildCommand = `${buildCommand} && mkdir -p ${repoName} && rsync -rc --exclude-from=.distignore ./ ./${repoName} --delete --delete-excluded && zip -r ${repoName}.zip ${repoName}`;
      zipGlob = `${repoName}.zip`;
    }
    break;
  }

  // Last resort: a script with "zip" or "dist" in its name or body -- weaker
  // evidence than an exact "release"/"build" match, but still real evidence.
  if (!buildCommand) {
    const candidate = Object.entries(scripts).find(
      ([name, body]) => /zip|dist/i.test(name) || /zip|dist/i.test(body)
    );
    if (candidate) {
      buildCommand = `${packageManager} run ${candidate[0]}`;
    }
  }

  // Nothing usable found -- skip rather than guess blindly.
  if (!buildCommand) return null;

  // --- zip glob -------------------------------------------------------------
  // Only deviate from the default when the repo's own script/Gruntfile/
  // gulpfile references a "dist" output path. Skipped if .distignore above
  // already set zipGlob explicitly.
  const combinedSource = [scripts.release, scripts.build, gruntfileRaw, gulpfileRaw].filter(Boolean).join("\n");
  if (zipGlob === "release/*.zip" && /dist\/.*\.zip/.test(combinedSource) && !/release\/.*\.zip/.test(combinedSource)) {
    zipGlob = "dist/*.zip";
  }

  return { packageManager, nodeVersion, phpVersion, buildCommand, composerInstall, zipGlob, pnpmVersion };
}

function renderSecretsBlock(org) {
  if (org === "wpeverest") return "    secrets: inherit\n";
  // secrets: inherit doesn't cross orgs -- themegrill callers must name each secret.
  return [
    "    secrets:",
    "      BOT_TOKEN: ${{ secrets.BOT_TOKEN }}",
    "      ARTIFACTS_KEY: ${{ secrets.ARTIFACTS_KEY }}",
    "      ARTIFACTS_SECRET: ${{ secrets.ARTIFACTS_SECRET }}",
    "",
  ].join("\n");
}

function renderWorkflow({ defaultBranch, org, config }) {
  const { packageManager, nodeVersion, phpVersion, buildCommand, composerInstall, zipGlob, pnpmVersion } = config;
  const pnpmVersionLine = pnpmVersion ? `      pnpm-version: '${pnpmVersion}'\n` : "";
  return `name: Build Testable ZIP

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [${defaultBranch}]
  workflow_dispatch:

jobs:
  zip:
    uses: ${REUSABLE_WORKFLOW_REF}@master
    with:
      node-version: '${nodeVersion}'
      php-version: '${phpVersion}'
      package-manager: ${packageManager}
${pnpmVersionLine}      composer-install: ${composerInstall}
      build-command: ${buildCommand}
      zip-glob: '${zipGlob}'
      artifacts-bucket: ${ARTIFACTS_BUCKET}
      public-base-url: ${PUBLIC_BASE_URL}
      s3-region: ${S3_REGION}
${renderSecretsBlock(org)}`;
}

async function processRepo(org, repo) {
  // Skip if a caller workflow already exists -- never overwrite a human's tuning.
  const existing = await getFile(org, repo, WORKFLOW_PATH);
  if (existing !== null && existing.includes(`uses: ${REUSABLE_WORKFLOW_REF}`)) {
    return { status: "skipped-existing" };
  }

  const repoRes = await gh(org, `/repos/${org}/${repo}`);
  if (!repoRes.ok) throw new Error(`Failed to fetch ${org}/${repo}: ${repoRes.status} ${await repoRes.text()}`);
  const { default_branch: defaultBranch } = await repoRes.json();

  const [packageJsonRaw, composerJsonRaw, gruntfileRaw, gulpfileRaw, pnpmLock, yarnLock, npmLock, distignoreRaw] = await Promise.all([
    getFile(org, repo, "package.json"),
    getFile(org, repo, "composer.json"),
    getFile(org, repo, "Gruntfile.js"),
    getFile(org, repo, "gulpfile.js").then((v) => v ?? getFile(org, repo, "gulpfile.babel.js")),
    getFile(org, repo, "pnpm-lock.yaml"),
    getFile(org, repo, "yarn.lock"),
    getFile(org, repo, "package-lock.json"),
    getFile(org, repo, ".distignore"),
  ]);

  const config = detectBuildConfig({
    packageJsonRaw,
    composerJsonRaw,
    gruntfileRaw,
    gulpfileRaw,
    lockfiles: { pnpm: pnpmLock !== null, yarn: yarnLock !== null, npm: npmLock !== null },
    distignoreExists: distignoreRaw !== null,
    repoName: repo,
  });

  if (config === null) {
    return { status: "skipped-undetected" };
  }

  const workflowContent = renderWorkflow({ defaultBranch, org, config });

  // --- branch/PR mechanics (same pattern as propagate-copilot-review.mjs) --
  const refRes = await gh(org, `/repos/${org}/${repo}/git/ref/heads/${defaultBranch}`);
  if (!refRes.ok) throw new Error(`Failed to read ${defaultBranch} ref for ${org}/${repo}: ${refRes.status} ${await refRes.text()}`);
  const { object: { sha: baseSha } } = await refRes.json();

  const createRefRes = await gh(org, `/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH_NAME}`, sha: baseSha }),
  });
  // 422 means the branch already exists (a previous run's PR is likely still open) -- reuse it.
  if (!createRefRes.ok && createRefRes.status !== 422) {
    throw new Error(`Failed to create branch on ${org}/${repo}: ${createRefRes.status} ${await createRefRes.text()}`);
  }

  const onBranchRes = await gh(org, `/repos/${org}/${repo}/contents/${WORKFLOW_PATH}?ref=${BRANCH_NAME}`);
  const existingShaOnBranch = onBranchRes.status === 200 ? (await onBranchRes.json()).sha : undefined;

  const putRes = await gh(org, `/repos/${org}/${repo}/contents/${WORKFLOW_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Add PR build ZIP workflow",
      content: Buffer.from(workflowContent).toString("base64"),
      branch: BRANCH_NAME,
      ...(existingShaOnBranch ? { sha: existingShaOnBranch } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`Failed to write file on ${org}/${repo}: ${putRes.status} ${await putRes.text()}`);

  const prBody = [
    "Adds a caller workflow for the reusable `pr-build-zip.yml` in themegrill/.github.",
    "",
    "On every PR (opened/synced/reopened/ready-for-review) this builds an installable plugin/theme ZIP and posts a download link as a PR comment, so a real ZIP is one click away from the code diff.",
    "",
    "**The `build-command`, `package-manager`, and `zip-glob` below were auto-detected** from this repo's package.json/Gruntfile.js/gulpfile.js by an automated rollout script, not hand-written for this repo specifically. The first real PR opened against this branch is the actual test of whether the detected command produces a working ZIP in the expected place -- please double-check the `with:` block matches how this repo is actually packaged for release before relying on it, and adjust if the build fails.",
  ].join("\n");

  const prRes = await gh(org, `/repos/${org}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Add PR build ZIP workflow",
      head: BRANCH_NAME,
      base: defaultBranch,
      body: prBody,
    }),
  });
  // 422 usually means a PR from this branch already exists; our commit still updated it.
  if (!prRes.ok && prRes.status !== 422) {
    throw new Error(`Failed to open PR on ${org}/${repo}: ${prRes.status} ${await prRes.text()}`);
  }
  if (prRes.ok) {
    const pr = await prRes.json();
    return { status: "opened", url: pr.html_url };
  }
  return { status: "opened", url: "(updated existing PR/branch)" };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  let opened = 0;
  let skippedExisting = 0;
  let skippedUndetected = 0;
  let failed = 0;
  const needsAttention = [];

  for (const [org, repos] of Object.entries(config)) {
    for (const repo of repos) {
      try {
        const result = await processRepo(org, repo);
        if (result.status === "opened") {
          console.log(`[${org}/${repo}] opened PR: ${result.url}`);
          opened++;
        } else if (result.status === "skipped-existing") {
          console.log(`[${org}/${repo}] already has a pr-build-zip workflow -- skipping`);
          skippedExisting++;
        } else {
          console.log(`[${org}/${repo}] could not confidently detect a build command -- skipping, needs manual setup`);
          skippedUndetected++;
          needsAttention.push(`${org}/${repo}`);
        }
      } catch (err) {
        console.error(`[${org}/${repo}] failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(
    `\nDone. PRs opened: ${opened} · already had a workflow: ${skippedExisting} · ` +
      `undetected (needs manual setup): ${skippedUndetected} · failed: ${failed}`
  );
  if (needsAttention.length > 0) {
    console.log(`\nRepos needing manual attention:\n${needsAttention.map((r) => `  - ${r}`).join("\n")}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
