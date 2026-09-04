#!/usr/bin/env node
// Instant single-session path: resolve exactly ONE Crisp conversation to a
// repo/kind right now (triggered externally via repository_dispatch, e.g. a
// webhook watching for a manual note) rather than waiting for the next scan.
//
// Mirrors crisp-classify.mjs's manual-note escalation path (skipClassifier:
// true) for one session_id instead of scanning every active conversation.
// Updates the same state files so the scheduled scan won't re-trigger this
// session later.
import { readFile, writeFile } from "node:fs/promises";
import { credsForAccount, fetchRawMessages, countManualTriggerNotes } from "./crisp-client.mjs";
import { classifyAndRoute } from "./crisp-classifier.mjs";

const { TARGET_SESSION_ID, GITHUB_STEP_SUMMARY } = process.env;
if (!TARGET_SESSION_ID) {
  console.error("Missing required env var: TARGET_SESSION_ID");
  process.exit(1);
}

async function summarize(text) {
  if (GITHUB_STEP_SUMMARY) {
    await writeFile(GITHUB_STEP_SUMMARY, `### Crisp instant trigger\n\n${text}\n`, { flag: "a" });
  }
}

async function main() {
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  const investigated = new Set(
    JSON.parse(await readFile("state/investigated.json", "utf8").catch(() => "[]"))
  );

  // The dispatch payload only carries session_id, not which account owns it
  // -- try each configured account until one returns a transcript.
  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch {
      continue; // not yet credentialed -- can't be the source
    }

    // A session belonging to a different account 404s (not an empty result),
    // which fetchRawMessages throws -- catch it and just try the next account.
    let messages;
    try {
      messages = await fetchRawMessages(creds, TARGET_SESSION_ID);
    } catch (err) {
      console.log(`[${accountKey}] not this account's conversation (${err.message})`);
      continue;
    }
    if (messages.length === 0) continue; // not this account's conversation

    const transcript = messages
      .filter((m) => m.type === "text")
      .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
      .join("\n");
    if (!transcript.trim()) {
      console.error(`[${accountKey}] found ${TARGET_SESSION_ID} but transcript is empty`);
      await writeFile("matrix.json", "[]");
      await summarize(`Found in [${accountKey}] but the transcript is empty -- nothing to investigate.`);
      return;
    }

    console.log(`[${accountKey}] found ${TARGET_SESSION_ID}, resolving repo...`);
    // { session_id } only, not the full conversation object -- an
    // `inboxes`-mode account would need meta.segments (not available here),
    // but no configured account uses that mode; an unmapped result below
    // fails loudly rather than guessing if one ever does.
    const result = await classifyAndRoute(accountConfig, { session_id: TARGET_SESSION_ID }, transcript, {
      skipClassifier: true,
    });

    if (!result.repo) {
      console.error(`[${accountKey}] could not resolve a repo: ${result.unmappedKey}`);
      await writeFile("matrix.json", "[]");
      await summarize(`Found in [${accountKey}], but could not resolve a repo: \`${result.unmappedKey}\`.`);
      return;
    }

    const record = escalated[TARGET_SESSION_ID] ?? { autoEscalated: false, manualNoteCount: 0 };
    record.manualNoteCount = countManualTriggerNotes(messages);
    escalated[TARGET_SESSION_ID] = record;
    investigated.add(TARGET_SESSION_ID);
    await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
    await writeFile("state/investigated.json", JSON.stringify([...investigated].slice(-2000)));

    await writeFile(
      "matrix.json",
      JSON.stringify([{ session_id: TARGET_SESSION_ID, repo: result.repo, kind: result.kind, account: accountKey }])
    );
    console.log(`[${accountKey}] ${TARGET_SESSION_ID} -> escalated to ${result.repo}`);
    await summarize(`[${accountKey}] \`${TARGET_SESSION_ID}\` -> \`${result.repo}\` (${result.kind})`);
    return;
  }

  console.error(`Session ${TARGET_SESSION_ID} not found in any configured Crisp account.`);
  await writeFile("matrix.json", "[]");
  await summarize(`Not found in any configured account: \`${TARGET_SESSION_ID}\`.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
