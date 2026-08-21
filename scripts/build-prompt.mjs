#!/usr/bin/env node
// Substitutes {{REPO}}, {{KIND}}, {{SESSION_ID}}, {{TRANSCRIPT}} into the
// Stage 2 prompt template and prints the result to stdout.
import { readFile } from "node:fs/promises";

const [templatePath, repo, kind, sessionId, transcriptPath] = process.argv.slice(2);
if (!templatePath || !repo || !kind || !sessionId || !transcriptPath) {
  console.error(
    "Usage: build-prompt.mjs <template.md> <repo> <kind> <session_id> <transcript.txt>"
  );
  process.exit(1);
}

const [rawTemplate, transcript] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(transcriptPath, "utf8"),
]);

// The leading HTML comment is documentation for humans editing the template;
// strip it so it isn't sent to the model as part of its instructions.
const template = rawTemplate.replace(/^<!--[\s\S]*?-->\n*/, "");

const filled = template
  .replaceAll("{{REPO}}", repo)
  .replaceAll("{{KIND}}", kind)
  .replaceAll("{{SESSION_ID}}", sessionId)
  .replaceAll("{{TRANSCRIPT}}", transcript);

process.stdout.write(filled);
