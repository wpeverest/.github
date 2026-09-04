#!/usr/bin/env node
// One-off maintenance script: marks every currently-active conversation for
// one Crisp account as already auto-escalated, so a newly onboarded
// account's pre-existing backlog doesn't all fire in crisp-triage.yml's
// first run. Run via .github/workflows/seed-escalated.yml once per new
// account, before its first scheduled crisp-triage run.
//
// Only blocks the AUTO-escalation path -- doesn't touch the resolved-
// conversation loop (already forward-only via cursor.json) and doesn't
// block a manual "!tg-autopilot investigate" note, which never checks this.
import { readFile, writeFile } from "node:fs/promises";
import { fetchActiveConversations, credsForAccount } from "./crisp-client.mjs";

const [accountKey] = process.argv.slice(2);
if (!accountKey) {
  console.error("Usage: seed-escalated.mjs <ACCOUNT_KEY>");
  process.exit(1);
}

async function main() {
  const creds = credsForAccount(accountKey);
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  const conversations = await fetchActiveConversations(creds);

  let seeded = 0;
  for (const conversation of conversations) {
    const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
    if (!record.autoEscalated) {
      record.autoEscalated = true;
      escalated[conversation.session_id] = record;
      seeded++;
    }
  }

  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
  console.log(`[${accountKey}] seeded ${seeded} of ${conversations.length} active conversations as already-escalated (backlog skip).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
