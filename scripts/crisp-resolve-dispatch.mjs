#!/usr/bin/env node
// Instant single-session path: resolve exactly ONE Crisp conversation to a
// repo/kind, right now, triggered externally (an n8n workflow watching
// Crisp's webhooks for a "!tg-autopilot investigate" note, calling this via
// repository_dispatch) rather than waiting for the next scheduled scan.
//
// Mirrors crisp-classify.mjs's manual-note escalation path exactly --
// skipClassifier: true, since a human already decided this is worth a
// look -- but for one specific session_id instead of scanning every active
// conversation for a note. Updates the SAME state files
// (state/escalated.json, state/investigated.json) so the scheduled scan's
// own manual-note detection won't redundantly re-trigger this session later.
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

  // Which account owns this session isn't known upfront (the dispatch
  // payload only carries session_id) -- try each configured account's
  // credentials until one actually returns a transcript for it.
  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch {
      continue; // not yet credentialed -- can't be the source
    }

    const messages = await fetchRawMessages(creds, TARGET_SESSION_ID);
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
    // { session_id } only, not the full Crisp conversation object -- an
    // `inboxes`-mode account needs meta.segments to resolve, which isn't
    // available here. Not a gap in practice: neither configured account
    // (USER_REGISTRATION is `repo`-mode, THEMEGRILL is `products`-mode)
    // needs it, and an unmapped result below fails loudly rather than
    // guessing if a future `inboxes`-mode account ever hits this path.
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
