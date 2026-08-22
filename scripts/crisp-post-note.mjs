#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent (via `node /tg-autopilot/crisp-post-note.mjs <session_id> "<note>"`)
// when investigation concludes an issue is client-side / inconclusive, so
// support gets a signal instead of silence.
//
// Confirmed for real: the same still-open conversation can get investigated
// by more than one run (auto-escalation fires again, or a fresh manual note
// re-triggers it) before the underlying GitHub issue is actually resolved --
// each run's agent independently rediscovers the same already-filed issue
// and leaves its own "matched/created issue #N" note, piling up duplicates.
// Guard on the GitHub issue URL specifically (not the note's exact wording,
// which the agent free-writes and won't match verbatim run to run): skip
// posting if an existing note in this conversation already contains the
// same issue URL. A note with no issue URL (e.g. "not a real defect") isn't
// deduped this way -- there's no stable substring to key on, and that case
// is lower-stakes noise, not a repeated claim about the same tracked issue.
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
