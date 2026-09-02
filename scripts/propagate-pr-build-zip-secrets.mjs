#!/usr/bin/env node
// Copies ARTIFACTS_KEY and ARTIFACTS_SECRET -- the shared S3 bucket
// credentials pr-build-zip.yml uploads to -- down as REPO-LEVEL secrets on
// every themegrill repo in config/copilot-review-repos.json.
//
// wpeverest repos don't need this: they call the reusable workflow with
// `secrets: inherit`, and the org-level secrets already reach them fine.
// themegrill can't use that path: inherit only works same-org (the reusable
// workflow lives in wpeverest/.github), and an org secret of its own
// wouldn't help either -- themegrill's Free plan silently blocks org
// secrets from reaching private repos (confirmed for real with BOT_TOKEN).
// A repo-level secret sidesteps both problems.
//
// Both orgs share one bucket; this just gives every themegrill repo its own
// copy of the same two values, read from this script's own env (itself
// sourced from wpeverest's existing org secrets) -- never hardcoded.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const sodium = createRequire(import.meta.url)("libsodium-wrappers");

const SECRET_NAMES = ["ARTIFACTS_KEY", "ARTIFACTS_SECRET"];

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.BOT_TOKEN_THEMEGRILL}`,
      Accept: "application/vnd.github+json",
      ...options.headers,
    },
  });
  return res;
}

async function setRepoSecret(repo, name, value) {
  const keyRes = await gh(`/repos/themegrill/${repo}/actions/secrets/public-key`);
  if (!keyRes.ok) throw new Error(`Failed to fetch public key for themegrill/${repo}: ${keyRes.status} ${await keyRes.text()}`);
  const { key, key_id } = await keyRes.json();

  await sodium.ready;
  const encryptedBytes = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
  const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await gh(`/repos/themegrill/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
  });
  if (!putRes.ok) throw new Error(`Failed to set ${name} on themegrill/${repo}: ${putRes.status} ${await putRes.text()}`);
}

async function main() {
  const config = JSON.parse(await readFile("config/copilot-review-repos.json", "utf8"));
  const repos = config.themegrill ?? [];

  const values = {
    ARTIFACTS_KEY: process.env.ARTIFACTS_KEY,
    ARTIFACTS_SECRET: process.env.ARTIFACTS_SECRET,
  };
  for (const name of SECRET_NAMES) {
    if (!values[name]) throw new Error(`Missing required env var ${name}`);
  }

  let ok = 0;
  let failed = 0;
  for (const repo of repos) {
    try {
      for (const name of SECRET_NAMES) {
        await setRepoSecret(repo, name, values[name]);
      }
      console.log(`[themegrill/${repo}] set ${SECRET_NAMES.join(", ")}`);
      ok++;
    } catch (err) {
      console.error(`[themegrill/${repo}] failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Repos updated: ${ok} · failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
