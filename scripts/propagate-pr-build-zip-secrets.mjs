#!/usr/bin/env node
// Copies ARTIFACTS_KEY and ARTIFACTS_SECRET -- the shared S3 bucket
// credentials pr-build-zip.yml uploads to -- down as REPO-LEVEL secrets on
// every repo in config/copilot-review-repos.json, both orgs.
//
// Originally this only covered themegrill, on the assumption that wpeverest
// repos would get these fine via `secrets: inherit` (same org as the
// reusable workflow). Confirmed wrong for real: wpeverest is ALSO on
// GitHub's Free plan, which silently blocks an org secret from reaching any
// PRIVATE repo -- and 45 of wpeverest's 48 target repos are private. Only
// the org's few public repos (where this was first tested) ever actually
// got the secret via inherit. Exactly the same failure mode already fixed
// for BOT_TOKEN in the Copilot-review rollout, just not yet applied to
// these two secrets on this org.
//
// Simplest fix: give every repo in both orgs its own repo-level copy,
// unconditionally. A repo-level secret always wins over an org one and has
// no plan/visibility restriction, and `secrets: inherit` already includes
// repo-level secrets -- so wpeverest callers don't need to change from
// `inherit` to naming secrets explicitly, they just start working once the
// repo-level copy exists. Setting it on the handful of already-working
// public repos too is harmless and keeps this script simple.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const sodium = createRequire(import.meta.url)("libsodium-wrappers");

const SECRET_NAMES = ["ARTIFACTS_KEY", "ARTIFACTS_SECRET"];

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

async function setRepoSecret(org, repo, name, value) {
  const keyRes = await gh(org, `/repos/${org}/${repo}/actions/secrets/public-key`);
  if (!keyRes.ok) throw new Error(`Failed to fetch public key for ${org}/${repo}: ${keyRes.status} ${await keyRes.text()}`);
  const { key, key_id } = await keyRes.json();

  await sodium.ready;
  const encryptedBytes = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
  const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await gh(org, `/repos/${org}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
  });
  if (!putRes.ok) throw new Error(`Failed to set ${name} on ${org}/${repo}: ${putRes.status} ${await putRes.text()}`);
}

async function main() {
  const config = JSON.parse(await readFile("config/copilot-review-repos.json", "utf8"));

  const values = {
    ARTIFACTS_KEY: process.env.ARTIFACTS_KEY,
    ARTIFACTS_SECRET: process.env.ARTIFACTS_SECRET,
  };
  for (const name of SECRET_NAMES) {
    if (!values[name]) throw new Error(`Missing required env var ${name}`);
  }

  let ok = 0;
  let failed = 0;
  for (const [org, repos] of Object.entries(config)) {
    for (const repo of repos) {
      try {
        for (const name of SECRET_NAMES) {
          await setRepoSecret(org, repo, name, values[name]);
        }
        console.log(`[${org}/${repo}] set ${SECRET_NAMES.join(", ")}`);
        ok++;
      } catch (err) {
        console.error(`[${org}/${repo}] failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone. Repos updated: ${ok} · failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
