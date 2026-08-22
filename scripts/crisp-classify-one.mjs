#!/usr/bin/env node
// On-demand path: investigate exactly ONE conversation right now, by
// session_id, bypassing the hourly scan of every open/resolved conversation
// entirely. Triggered via workflow_dispatch's session_id input.
//
// Like the manual "@tg-autopilot investigate" note, this is a deliberate
// human decision -- skips the cheap actionable/kind classifier the same way,
// since someone already decided this specific conversation is worth a look.
//
// Deliberately does NOT touch state/cursor.json, state/active-notified.json,
// or state/escalated.json: this mode doesn't do a scan, so there's no
// scan-progress bookkeeping to advance.
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { fetchTranscript, credsForAccount } from "./crisp-client.mjs";

const { TARGET_SESSION_ID, GITHUB_STEP_SUMMARY } = process.env;
if (!TARGET_SESSION_ID) {
  console.error("Missing required env var: TARGET_SESSION_ID");
  process.exit(1);
}

// Duplicated from crisp-classify.mjs rather than imported: that file's
// classifyAndRoute also needs the OpenAI classifier wired up, which this
// script intentionally skips (skipClassifier semantics) -- keeping this
// standalone avoids importing machinery this path never uses.
async function resolveRepo(accountConfig, transcript, productModelCall) {
  if (accountConfig.repo) return { repo: accountConfig.repo, kind: "bug" };
  if (accountConfig.products) {
    const productNames = Object.keys(accountConfig.products);
    const result = await productModelCall(transcript, productNames);
    const mapping = accountConfig.products[result.product];
    if (!mapping) return { repo: null, unmappedKey: `product:${result.product}` };
    const repo = result.edition === "pro" && mapping.pro ? mapping.pro : mapping.free;
    return { repo, kind: result.kind === "feature" ? "feature" : "bug" };
  }
  // `inboxes`-mode accounts need the conversation's own inbox/segment data,
  // which this path doesn't fetch (only the transcript) -- none of our
  // current accounts use this mode, so this is a documented gap, not a
  // silent one: it fails clearly rather than guessing.
  return { repo: null, unmappedKey: "inboxes-mode account not supported via direct session_id lookup" };
}

async function main() {
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  const { chatJSON } = await import("./openai-client.mjs");

  const classifyWithProduct = (transcript, productNames) =>
    chatJSON(
      "Given a customer support transcript, name which ONE product from this " +
        `exact list it is about: ${productNames.join(", ")}. Never invent a name ` +
        'not in this list -- if you cannot tell, use "unknown". Also note whether ' +
        "it indicates the PRO/premium edition (license, purchase, Pro-only " +
        'features) or free (default). Respond with ONLY a JSON object: ' +
        '{"product": "<name>" | "unknown", "kind": "bug" | "feature", "edition": "free" | "pro"}.',
      transcript,
      { product: "unknown", kind: "bug", edition: "free" }
    );

  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch {
      continue; // this account isn't credentialed yet -- can't be the source
    }

    const transcript = await fetchTranscript(creds, TARGET_SESSION_ID);
    if (!transcript.trim()) continue; // not this account's conversation (or genuinely empty)

    console.log(`[${accountKey}] found ${TARGET_SESSION_ID}, resolving repo...`);
    const { repo, kind, unmappedKey } = await resolveRepo(accountConfig, transcript, classifyWithProduct);

    if (!repo) {
      console.error(`Could not resolve a repo: ${unmappedKey}`);
      await writeFile("matrix.json", "[]");
      if (GITHUB_STEP_SUMMARY) {
        await writeFile(GITHUB_STEP_SUMMARY, `### Crisp triage — direct session lookup\n\nFound in account [${accountKey}], but could not resolve a repo: \`${unmappedKey}\`\n`, { flag: "a" });
      }
      return;
    }

    console.log(`[${accountKey}] ${TARGET_SESSION_ID} -> escalated to ${repo}`);
    await writeFile("matrix.json", JSON.stringify([{ session_id: TARGET_SESSION_ID, repo, kind, account: accountKey }]));
    if (GITHUB_STEP_SUMMARY) {
      await writeFile(GITHUB_STEP_SUMMARY, `### Crisp triage — direct session lookup\n\n[${accountKey}] ${TARGET_SESSION_ID} -> \`${repo}\`\n`, { flag: "a" });
    }
    return;
  }

  console.error(`Session ${TARGET_SESSION_ID} not found in any configured Crisp account.`);
  await writeFile("matrix.json", "[]");
  if (GITHUB_STEP_SUMMARY) {
    await writeFile(GITHUB_STEP_SUMMARY, `### Crisp triage — direct session lookup\n\nNot found in any configured account: \`${TARGET_SESSION_ID}\`\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
