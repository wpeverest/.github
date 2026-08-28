#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent so support gets a signal even when no issue was filed.
//
// A conversation investigated more than once (repeat auto-escalation, or a
// fresh manual note) can get the same "matched/created issue #N" note
// posted repeatedly. Skip only if EVERY issue URL in the new note is already
// mentioned in an existing note -- a note can now reference two issues (a
// bug and a feature request found in the same conversation), and one of
// them being new information is enough reason to still post. Keyed on the
// URL, not exact wording, since the agent free-writes each note. A note
// with no issue URL at all isn't deduped this way.
import { readFile } from "node:fs/promises";
import { postNote, fetchRawMessages } from "./crisp-client.mjs";

const [sessionId, noteArg] = process.argv.slice(2);
if (!sessionId || !noteArg) {
  console.error('Usage: crisp-post-note.mjs <session_id> "<note text>"  (or: crisp-post-note.mjs <session_id> @<path-to-note-file>)');
  process.exit(1);
}

// `@path` (curl's own convention) reads the note from a file instead of the
// argument itself -- a real multi-line note surviving as a single shell
// argument is fragile (confirmed for real: the agent embedded literal `\n`
// text instead of actual newlines, since bash doesn't interpret `\n` inside
// double quotes). A file has no such quoting problem.
const rawNote = noteArg.startsWith("@") ? await readFile(noteArg.slice(1), "utf8") : noteArg;

// Safety net regardless of source: normalize literal backslash-n/backslash-
// r-n sequences to real newlines, in case they made it through anyway.
const note = rawNote.replace(/\\r\\n|\\n/g, "\n");

const creds = {
  identifier: process.env.CRISP_IDENTIFIER,
  key: process.env.CRISP_KEY,
  websiteId: process.env.CRISP_WEBSITE_ID,
};

const issueUrls = [...note.matchAll(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/g)].map((m) => m[0]);

async function main() {
  if (issueUrls.length > 0) {
    const messages = await fetchRawMessages(creds, sessionId);
    const existingNotes = messages.filter((m) => m.type === "note").map((m) => m.content ?? "");
    const allAlreadyNoted = issueUrls.every((url) => existingNotes.some((content) => content.includes(url)));
    if (allAlreadyNoted) {
      console.log(`Skipping note -- all referenced issue(s) (${issueUrls.join(", ")}) already mentioned in an existing note on conversation ${sessionId}`);
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
