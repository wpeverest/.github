#!/usr/bin/env node
// Fills the Stage 2 prompt template's placeholders and prints the result.
import { readFile } from "node:fs/promises";

const [templatePath, repo, kind, sessionId, conversationUrl, transcriptPath] = process.argv.slice(2);
if (!templatePath || !repo || !kind || !sessionId || !conversationUrl || !transcriptPath) {
  console.error(
    "Usage: build-prompt.mjs <template.md> <repo> <kind> <session_id> <conversation_url> <transcript.txt>"
  );
  process.exit(1);
}

const [rawTemplate, transcript] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(transcriptPath, "utf8"),
]);

// Strip the leading HTML doc-comment -- it's for humans, not the model.
const template = rawTemplate.replace(/^<!--[\s\S]*?-->\n*/, "");

const filled = template
  .replaceAll("{{REPO}}", repo)
  .replaceAll("{{KIND}}", kind)
  .replaceAll("{{SESSION_ID}}", sessionId)
  .replaceAll("{{CONVERSATION_URL}}", conversationUrl)
  .replaceAll("{{TRANSCRIPT}}", transcript);

process.stdout.write(filled);
