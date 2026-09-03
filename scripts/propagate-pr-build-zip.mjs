#!/usr/bin/env node
// Ensures every repo listed in config/copilot-review-repos.json (same list
// as the Copilot-review rollout -- reused deliberately, see that script's
// comment on why it's an opt-in list, not "every repo in the org") has a
// caller workflow for the reusable wpeverest/.github pr-build-zip.yml, which
// builds a testable, installable ZIP on every PR and posts a download link.
//
// Unlike propagate-copilot-review.mjs, the content this script writes is NOT
// one canonical constant -- every repo's build tooling differs (grunt vs.
// gulp vs. plain scripts, yarn vs. pnpm vs. npm, PHP version, whether the
// build already runs composer internally...), so each repo gets its own
// generated file, detected from that repo's own package.json/Gruntfile.js/
// gulpfile.js/composer.json via the Contents API. See detectBuildConfig()
// for the detection heuristics and their reasoning.
//
// Also unlike the Copilot script, this one does NOT touch a repo that
// already has .github/workflows/pr-build-zip.yml with a
// `uses: wpeverest/.github/.github/workflows/pr-build-zip.yml` line in it --
// a human tuned that file by hand (like user-registration's), and our
// heuristics are not trusted to safely override deliberate human tuning.
// This is a one-shot bootstrap per repo, not an ongoing sync.
import { readFile } from "node:fs/promises";

const CONFIG_PATH = "config/copilot-review-repos.json";
const WORKFLOW_PATH = ".github/workflows/pr-build-zip.yml";
const REUSABLE_WORKFLOW_REF = "wpeverest/.github/.github/workflows/pr-build-zip.yml";
const BRANCH_NAME = "tg-autopilot/add-pr-build-zip";

// Shared bucket for both orgs -- copied verbatim into every generated file,
// per the rollout's secrets/auth model (see task background).
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

// Returns decoded text content of a repo file, or null if it doesn't exist.
// Used for every "does this file exist / what's in it" probe below.
async function getFile(org, repo, path) {
  const res = await gh(org, `/repos/${org}/${repo}/contents/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ${path} on ${org}/${repo}: ${res.status} ${await res.text()}`);
  const { content } = await res.json();
  return Buffer.from(content, "base64").toString("utf8");
}

// Node version ranges we know how to translate into a concrete
// actions/setup-node version string. Anything unrecognized falls through to
// the '20.x' default rather than guessing at a range we can't parse safely.
// `engines.node`/composer's `require.php` commonly declare an ancient
// minimum-support floor (">=0.8.0", ">=5.6.20") left over from years-old
// boilerplate -- that is NOT the version anyone actually wants to build
// with, and taking it literally breaks the build outright (confirmed for
// real: estore's ">=0.8.0" produced literal Node 0.x, which doesn't even
// have a working npm; user-registration-pro's ">=5.6.20" produced PHP 5.6,
// too old for its own composer dependencies). Both functions below only
// trust the declared number when it's at or above a sane modern floor --
// otherwise these fields are pure noise and the tool's own sensible
// default is more likely correct than anything parsed from them.
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

// Looks for a script that shells out to grunt/gulp with a real task name
// (e.g. "grunt release:dev", "gulp release"), matching the pattern seen in
// both known-working examples. Returns the task invocation string (what
// comes after the tool name) or null if the script doesn't call that tool.
function extractToolInvocation(scriptBody, tool) {
  const match = scriptBody.match(new RegExp(`${tool}\\s+([\\w:.-]+)`));
  return match ? match[1] : null;
}

// Core detection logic. Takes the raw file contents already fetched for one
// repo and returns either a build config object or null (meaning: nothing
// safe to auto-generate, skip and flag for a human).
function detectBuildConfig({ packageJsonRaw, composerJsonRaw, gruntfileRaw, gulpfileRaw, lockfiles, distignoreExists, repoName }) {
  const packageJson = packageJsonRaw ? JSON.parse(packageJsonRaw) : null;
  const composerJson = composerJsonRaw ? JSON.parse(composerJsonRaw) : null;

  // --- package manager ---------------------------------------------------
  // Priority: explicit "packageManager" field (Corepack's own source of
  // truth) > lockfile presence > yarn as a last-resort default. We only
  // reach the yarn default when NOTHING else indicates a choice, per the
  // task spec -- not used as a tie-breaker ahead of real evidence.
  let packageManager = packageManagerFromField(packageJson?.packageManager);
  // Whether pnpm/action-setup can auto-detect a version via corepack's
  // "packageManager" field -- if not, and we're using pnpm, the reusable
  // workflow needs an explicit pnpm-version or the setup step fails
  // outright with "No pnpm version is specified" (confirmed for real on
  // themegrill/colormag, which has no packageManager field). Only tracked
  // for pnpm specifically -- npm/yarn don't need action-setup at all.
  const hasPackageManagerField = Boolean(packageManager);
  if (!packageManager) {
    if (lockfiles.pnpm) packageManager = "pnpm";
    else if (lockfiles.yarn) packageManager = "yarn";
    else if (lockfiles.npm) packageManager = "npm";
    else packageManager = "yarn";
  }
  // A safe, currently-supported pnpm major version -- only used as a
  // fallback when the repo gives us nothing to auto-detect from. Never
  // overrides a repo's own declared version, which corepack already
  // handles fine (confirmed on user-registration/user-registration-pro,
  // both of which declare "packageManager": "pnpm@..." and work today
  // with no explicit pnpm-version passed).
  const pnpmVersion = packageManager === "pnpm" && !hasPackageManagerField ? "9" : null;

  // --- node / php versions ------------------------------------------------
  const nodeVersion = nodeVersionFromEngines(packageJson?.engines);
  const phpVersion = phpVersionFromComposer(composerJson);

  // --- build command -------------------------------------------------------
  // Prefer a script literally named "release", then "build" (per spec: if
  // both exist, "release" wins -- it's the more specific/intentional name
  // for "package a distributable", whereas "build" often just means
  // "compile assets" in a lot of these repos' package.json files).
  const scripts = packageJson?.scripts || {};
  let buildCommand = null;
  let composerInstall = Boolean(composerJson);
  let zipGlob = "release/*.zip";

  for (const scriptName of ["release", "build"]) {
    const body = scripts[scriptName];
    if (!body) continue;

    // If the script just shells out to grunt/gulp with a real task name we
    // can see, run that task directly via the package manager (matches the
    // known-working examples exactly: `pnpm exec grunt release:dev`,
    // `... && gulp release`) rather than indirecting through "run
    // <scriptName>" -- this keeps the generated command legible and lets us
    // reason about composer-install below by inspecting the SAME Gruntfile.
    const gruntTask = gruntfileRaw ? extractToolInvocation(body, "grunt") : null;
    const gulpTask = gulpfileRaw ? extractToolInvocation(body, "gulp") : null;

    // Tracks whether buildCommand already packages a zip itself (a grunt/gulp
    // release task, matching the known-working examples) vs. is just an
    // asset-compile script with no packaging step at all -- used below to
    // decide whether the .distignore fallback packaging needs appending.
    let packagesItself = false;

    if (gruntTask) {
      buildCommand = `${packageManager} exec grunt ${gruntTask}`;
      packagesItself = true;
      // Composer running inside the Grunt task itself is the exact situation
      // documented in user-registration's caller file: its Gruntfile.js runs
      // `composer install --no-dev` as part of the release task, so this
      // workflow's own composer-install step would just duplicate that work.
      // We can't run the task to observe this directly, so we grep the
      // Gruntfile source for evidence of it calling composer itself.
      if (gruntfileRaw && /composer\s+install/i.test(gruntfileRaw)) {
        composerInstall = false;
      }
    } else if (gulpTask) {
      // yarn build && yarn build:blocks && gulp release -- the known gulp
      // example chains its own script(s) ahead of the gulp task, so we keep
      // whatever came before the gulp invocation in the original script body
      // (that's part of the packaging pipeline, not an artifact of parsing).
      buildCommand = body;
      packagesItself = true;
    } else {
      // No recognizable grunt/gulp indirection -- this is very likely just an
      // asset-compile script (wp-scripts build, webpack, ...) with no
      // packaging step of its own. Confirmed for real across a wide sample
      // of repos after the pnpm/PHP-version fixes: dozens still failed with
      // "No ZIP matched 'release/*.zip'" because their "build" script
      // genuinely never produces a zip anywhere -- packaging happens
      // separately (a plugin's own custom release workflow, or nothing
      // automated yet). See the .distignore fallback below for the one
      // structural signal reliable enough to act on automatically.
      buildCommand = `${packageManager} run ${scriptName}`;
    }

    // Neither grunt nor gulp is doing the packaging, but the repo has a
    // .distignore -- the exact convention user-registration-pro's own
    // (manually written, pre-existing) release automation used: rsync the
    // repo into a folder named after itself excluding .distignore's
    // patterns, then zip that folder. This is a real structural signal
    // confirmed present on the majority of repos that otherwise had no
    // buildCommand producing a zip anywhere -- not a guess the way "assume
    // release/*.zip" was.
    if (!packagesItself && distignoreExists) {
      buildCommand = `${buildCommand} && mkdir -p ${repoName} && rsync -rc --exclude-from=.distignore ./ ./${repoName} --delete --delete-excluded && zip -r ${repoName}.zip ${repoName}`;
      zipGlob = `${repoName}.zip`;
    }
    break;
  }

  // Last resort: a script with "zip" or "dist" literally in its name or
  // body, since spec says to use best judgement from file contents rather
  // than inventing a command. Still real evidence, just weaker than an
  // exact "release"/"build" name match.
  if (!buildCommand) {
    const candidate = Object.entries(scripts).find(
      ([name, body]) => /zip|dist/i.test(name) || /zip|dist/i.test(body)
    );
    if (candidate) {
      buildCommand = `${packageManager} run ${candidate[0]}`;
    }
  }

  // Nothing usable found -- per spec, skip rather than guess blindly.
  if (!buildCommand) return null;

  // --- zip glob -------------------------------------------------------------
  // Only deviate from the shared default when we see explicit evidence (a
  // "dist" directory referenced in the same script body or Gruntfile/gulpfile)
  // that the repo's own tooling drops the zip somewhere else. Skipped when
  // the .distignore fallback above already set zipGlob explicitly.
  const combinedSource = [scripts.release, scripts.build, gruntfileRaw, gulpfileRaw].filter(Boolean).join("\n");
  if (zipGlob === "release/*.zip" && /dist\/.*\.zip/.test(combinedSource) && !/release\/.*\.zip/.test(combinedSource)) {
    zipGlob = "dist/*.zip";
  }

  return { packageManager, nodeVersion, phpVersion, buildCommand, composerInstall, zipGlob, pnpmVersion };
}

function renderSecretsBlock(org) {
  if (org === "wpeverest") return "    secrets: inherit\n";
  // Cross-org `secrets: inherit` does not work (confirmed on the Copilot
  // rollout) -- themegrill callers must name every secret explicitly.
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
  // Skip if a caller workflow already exists there -- a human already tuned
  // it (see file header). This is intentionally simpler than the Copilot
  // script's sha-diffing: existence alone is the bar, we never overwrite.
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

  // --- branch/PR mechanics, mirroring propagate-copilot-review.mjs --------
  const refRes = await gh(org, `/repos/${org}/${repo}/git/ref/heads/${defaultBranch}`);
  if (!refRes.ok) throw new Error(`Failed to read ${defaultBranch} ref for ${org}/${repo}: ${refRes.status} ${await refRes.text()}`);
  const { object: { sha: baseSha } } = await refRes.json();

  const createRefRes = await gh(org, `/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH_NAME}`, sha: baseSha }),
  });
  // 422 means the branch already exists -- a previous run's PR is likely
  // still open. Reuse it, same as the Copilot script does.
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
    "Adds a caller workflow for the reusable `pr-build-zip.yml` in wpeverest/.github.",
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
  // 422 typically means a PR from this branch already exists -- the commit
  // we just pushed still updates it either way.
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
