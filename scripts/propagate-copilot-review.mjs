#!/usr/bin/env node
// Ensures every repo listed in config/copilot-review-repos.json has the
// Copilot-review-on-comment caller workflow, with the CORRECT content --
// not just present. Safe to re-run indefinitely: a repo whose file already
// matches the canonical content is skipped; a repo missing it, or with
// stale/wrong content (e.g. a fix like this one), gets a PR.
//
// Deliberately opt-in via an explicit list, not "every repo in the org":
// most repos in both orgs are docs/marketing/tooling, not products that
// need PR-review automation, and there's no reliable automatic way to tell
// those apart -- a human still decides once per repo, but only by adding a
// name to a list, not by hand-authoring a workflow file.
import { readFile } from "node:fs/promises";

const CALLER_WORKFLOW_PATH = ".github/workflows/copilot-review-on-comment.yml";
const BRANCH_NAME = "tg-autopilot/add-copilot-review-on-comment";

// The deployed file, not the docs/copilot-review-on-comment.caller.yml
// template verbatim -- that one carries a "TEMPLATE, copy this" comment
// meant for a human doing this by hand, which doesn't belong in a file this
// script deploys itself.
//
// `secrets: BOT_TOKEN: ...` explicitly, not `secrets: inherit` -- inherit
// only works when the caller and the reusable workflow are in the SAME
// organization. wpeverest/.github lives in wpeverest, so a themegrill
// caller needs the secret passed by name to work across the org boundary.
// Confirmed for real: every themegrill repo failed identically ("Secret
// BOT_TOKEN is required, but not provided while calling") with `inherit`.
const CALLER_WORKFLOW_CONTENT = `name: Copilot review on comment

on:
  issue_comment:
    types: [created]

jobs:
  review:
    uses: wpeverest/.github/.github/workflows/copilot-review-on-comment.yml@master
    secrets:
      BOT_TOKEN: \${{ secrets.BOT_TOKEN }}
`;

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

// Returns null if the file doesn't exist, otherwise its decoded content.
async function getExistingContent(org, repo) {
  const res = await gh(org, `/repos/${org}/${repo}/contents/${CALLER_WORKFLOW_PATH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Unexpected status checking ${org}/${repo}: ${res.status} ${await res.text()}`);
  const { content } = await res.json();
  return Buffer.from(content, "base64").toString("utf8");
}

async function syncWorkflow(org, repo) {
  const repoRes = await gh(org, `/repos/${org}/${repo}`);
  if (!repoRes.ok) throw new Error(`Failed to fetch ${org}/${repo}: ${repoRes.status} ${await repoRes.text()}`);
  const { default_branch: baseBranch } = await repoRes.json();

  const refRes = await gh(org, `/repos/${org}/${repo}/git/ref/heads/${baseBranch}`);
  if (!refRes.ok) throw new Error(`Failed to read ${baseBranch} ref for ${org}/${repo}: ${refRes.status} ${await refRes.text()}`);
  const { object: { sha: baseSha } } = await refRes.json();

  const createRefRes = await gh(org, `/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH_NAME}`, sha: baseSha }),
  });
  // 422 means the branch already exists -- a previous run's PR is likely
  // still open. Reuse it rather than failing. If it's stale (pointing at an
  // old base commit), that's fine here since we still read the file's sha
  // fresh from that same branch just below.
  if (!createRefRes.ok && createRefRes.status !== 422) {
    throw new Error(`Failed to create branch on ${org}/${repo}: ${createRefRes.status} ${await createRefRes.text()}`);
  }

  // The Contents API requires the current blob sha to UPDATE an existing
  // file (omit it and GitHub rejects the write); a brand-new file has none.
  const onBranchRes = await gh(org, `/repos/${org}/${repo}/contents/${CALLER_WORKFLOW_PATH}?ref=${BRANCH_NAME}`);
  const existingSha = onBranchRes.status === 200 ? (await onBranchRes.json()).sha : undefined;

  const putRes = await gh(org, `/repos/${org}/${repo}/contents/${CALLER_WORKFLOW_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: existingSha ? "Fix Copilot review on comment (secrets.BOT_TOKEN, not inherit)" : "Add Copilot review on comment",
      content: Buffer.from(CALLER_WORKFLOW_CONTENT).toString("base64"),
      branch: BRANCH_NAME,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`Failed to write file on ${org}/${repo}: ${putRes.status} ${await putRes.text()}`);

  const prRes = await gh(org, `/repos/${org}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Add Copilot review on comment",
      head: BRANCH_NAME,
      base: baseBranch,
      body: "Adds the reusable Copilot-review-on-comment workflow, called from wpeverest/.github. Commenting `@tg-autopilot review` on a PR (from an account with write access or higher) requests a Copilot code review through tg-autopilot's seat.",
    }),
  });
  // 422 here typically means a PR from this branch already exists -- the
  // commit we just pushed to that branch still updates it either way.
  if (!prRes.ok && prRes.status !== 422) {
    throw new Error(`Failed to open PR on ${org}/${repo}: ${prRes.status} ${await prRes.text()}`);
  }
  if (prRes.ok) {
    const pr = await prRes.json();
    return pr.html_url;
  }
  return "(updated existing PR/branch)";
}

async function main() {
  const config = JSON.parse(await readFile("config/copilot-review-repos.json", "utf8"));
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const [org, repos] of Object.entries(config)) {
    for (const repo of repos) {
      try {
        const existing = await getExistingContent(org, repo);
        if (existing === CALLER_WORKFLOW_CONTENT) {
          console.log(`[${org}/${repo}] already up to date -- skipping`);
          skipped++;
          continue;
        }
        const url = await syncWorkflow(org, repo);
        console.log(`[${org}/${repo}] ${existing === null ? "opened PR" : "fixed via PR"}: ${url}`);
        added++;
      } catch (err) {
        console.error(`[${org}/${repo}] failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone. PRs opened/updated: ${added} · already up to date: ${skipped} · failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
