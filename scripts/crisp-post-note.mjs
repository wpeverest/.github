#!/usr/bin/env node
// Posts a private note into a Crisp conversation. Called by the Stage 2
// agent so support gets a signal even when no issue was filed.
//
// A conversation investigated more than once can get the same "matched/
// created issue #N" note posted repeatedly. Skip only if EVERY issue URL in
// the new note is already mentioned in an existing note -- a note can
// reference two issues, and one being new is reason enough to still post.
// Keyed on the URL, not wording. A note with no issue URL isn't deduped.
import { readFile } from "node:fs/promises";
import { postNote, fetchRawMessages } from "./crisp-client.mjs";

const [sessionId, noteArg] = process.argv.slice(2);
if (!sessionId || !noteArg) {
  console.error('Usage: crisp-post-note.mjs <session_id> "<note text>"  (or: crisp-post-note.mjs <session_id> @<path-to-note-file>)');
  process.exit(1);
}

// `@path` (curl's convention) reads the note from a file instead of the
// argument -- a multi-line note as a shell argument is fragile (bash
// doesn't interpret literal `\n` inside double quotes).
const rawNote = noteArg.startsWith("@") ? await readFile(noteArg.slice(1), "utf8") : noteArg;

// Safety net: normalize literal \n / \r\n sequences to real newlines in case any made it through.
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
