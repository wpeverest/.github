#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent (via `node /tg-autopilot/crisp-post-note.mjs <session_id> "<note>"`)
// when investigation concludes an issue is client-side / inconclusive, so
// support gets a signal instead of silence.
import { postNote } from "./crisp-client.mjs";

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

postNote(creds, sessionId, note)
  .then(() => console.log(`Note posted to conversation ${sessionId}`))
  .catch((err) => {
    console.error(`Failed to post Crisp note: ${err.message}`);
    process.exit(1);
  });
