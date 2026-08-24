#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent so support gets a signal even when no issue was filed.
//
// A conversation investigated more than once (repeat auto-escalation, or a
// fresh manual note) can get the same "matched/created issue #N" note
// posted repeatedly. Skip if an existing note already contains the same
// issue URL -- keyed on the URL, not exact wording, since the agent
// free-writes each note. A note with no issue URL isn't deduped this way.
import { postNote, fetchRawMessages } from "./crisp-client.mjs";

const [sessionId, note] = process.argv.slice(2);
if (!sessionId || !note) {
  console.error('Usage: crisp-post-note.mjs <session_id> "<note text>"');
  process.exit(1);
}

const creds = {
  identifier: process.env.CRISP_IDENTIFIER,
  key: process.env.CRISP_KEY,
  websiteId: process.env.CRISP_WEBSITE_ID,
};

const issueUrlMatch = note.match(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/);

async function main() {
  if (issueUrlMatch) {
    const messages = await fetchRawMessages(creds, sessionId);
    const alreadyNoted = messages.some(
      (m) => m.type === "note" && (m.content ?? "").includes(issueUrlMatch[0])
    );
    if (alreadyNoted) {
      console.log(`Skipping note -- ${issueUrlMatch[0]} already mentioned in an existing note on conversation ${sessionId}`);
      return;
    }
  }
  await postNote(creds, sessionId, note);
  console.log(`Note posted to conversation ${sessionId}`);
}

main().catch((err) => {
  console.error(`Failed to post Crisp note: ${err.message}`);
  process.exit(1);
});
