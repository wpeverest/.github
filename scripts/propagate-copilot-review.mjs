#!/usr/bin/env node
// Ensures every repo listed in config/copilot-review-repos.json has the
// Copilot-review-on-comment caller workflow. Safe to re-run indefinitely:
// a repo that already has the file is skipped, so onboarding a new repo is
// just adding its name to the config -- the next scheduled run opens the PR.
//
// Deliberately opt-in via an explicit list, not "every repo in the org":
// most repos in both orgs are docs/marketing/tooling, not products that
// need PR-review automation, and there's no reliable automatic way to tell
// those apart -- a human still decides once per repo, but only by adding a
// name to a list, not by hand-authoring a workflow file.
import { readFile } from "node:fs/promises";

const CALLER_WORKFLOW_PATH = ".github/workflows/copilot-review-on-comment.yml";

// The deployed file, not the docs/copilot-review-on-comment.caller.yml
// template verbatim -- that one carries a "TEMPLATE, copy this" comment
// meant for a human doing this by hand, which doesn't belong in a file this
// script deploys itself.
const CALLER_WORKFLOW_CONTENT = `name: Copilot review on comment

on:
  issue_comment:
    types: [created]

jobs:
  review:
    uses: wpeverest/.github/.github/workflows/copilot-review-on-comment.yml@master
    secrets: inherit
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

async function fileExists(org, repo) {
  const res = await gh(org, `/repos/${org}/${repo}/contents/${CALLER_WORKFLOW_PATH}`);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`Unexpected status checking ${org}/${repo}: ${res.status} ${await res.text()}`);
}

async function openPrAddingWorkflow(org, repo) {
  const repoRes = await gh(org, `/repos/${org}/${repo}`);
  if (!repoRes.ok) throw new Error(`Failed to fetch ${org}/${repo}: ${repoRes.status} ${await repoRes.text()}`);
  const { default_branch: baseBranch } = await repoRes.json();

  const refRes = await gh(org, `/repos/${org}/${repo}/git/ref/heads/${baseBranch}`);
  if (!refRes.ok) throw new Error(`Failed to read ${baseBranch} ref for ${org}/${repo}: ${refRes.status} ${await refRes.text()}`);
  const { object: { sha: baseSha } } = await refRes.json();

  const branchName = "tg-autopilot/add-copilot-review-on-comment";
  const createRefRes = await gh(org, `/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  // 422 means the branch already exists -- a previous run's PR is likely
  // still open. Reuse it rather than failing.
  if (!createRefRes.ok && createRefRes.status !== 422) {
    throw new Error(`Failed to create branch on ${org}/${repo}: ${createRefRes.status} ${await createRefRes.text()}`);
  }

  const putRes = await gh(org, `/repos/${org}/${repo}/contents/${CALLER_WORKFLOW_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Add Copilot review on comment",
      content: Buffer.from(CALLER_WORKFLOW_CONTENT).toString("base64"),
      branch: branchName,
    }),
  });
  if (!putRes.ok) throw new Error(`Failed to write file on ${org}/${repo}: ${putRes.status} ${await putRes.text()}`);

  const prRes = await gh(org, `/repos/${org}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Add Copilot review on comment",
      head: branchName,
      base: baseBranch,
      body: "Adds the reusable Copilot-review-on-comment workflow, called from wpeverest/.github. Commenting `@tg-autopilot review` on a PR (from an account with write access or higher) requests a Copilot code review through tg-autopilot's seat.",
    }),
  });
  // 422 here typically means a PR from this branch already exists.
  if (!prRes.ok && prRes.status !== 422) {
    throw new Error(`Failed to open PR on ${org}/${repo}: ${prRes.status} ${await prRes.text()}`);
  }
  if (prRes.ok) {
    const pr = await prRes.json();
    return pr.html_url;
  }
  return "(branch/PR already existed)";
}

async function main() {
  const config = JSON.parse(await readFile("config/copilot-review-repos.json", "utf8"));
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const [org, repos] of Object.entries(config)) {
    for (const repo of repos) {
      try {
        const exists = await fileExists(org, repo);
        if (exists) {
          console.log(`[${org}/${repo}] already has the workflow -- skipping`);
          skipped++;
          continue;
        }
        const url = await openPrAddingWorkflow(org, repo);
        console.log(`[${org}/${repo}] opened PR: ${url}`);
        added++;
      } catch (err) {
        console.error(`[${org}/${repo}] failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone. PRs opened: ${added} · already present: ${skipped} · failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
