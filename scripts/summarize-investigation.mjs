#!/usr/bin/env node
// Turns opencode's raw NDJSON event stream into a readable GitHub Actions
// step summary. The full stream is still saved separately (for actual
// debugging -- this is what we've been manually grep-ing through all day)
// but it's unreadable as a step summary: hundreds of tool-call events with
// full file contents and grep output. What a human actually wants there is
// the agent's own final report, which the prompt already requires it to
// produce as a structured "Investigation report:" note (see
// prompts/crisp-triage-agent.md) -- the last "text" event in the stream.
import { readFile } from "node:fs/promises";

const [inputPath] = process.argv.slice(2);
if (!inputPath) {
  console.error("Usage: summarize-investigation.mjs <opencode-output.json>");
  process.exit(1);
}

async function main() {
  const raw = await readFile(inputPath, "utf8");
  let lastText = null;
  let totalCost = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // not every line is a clean JSON event -- skip silently
    }
    if (event.type === "text" && event.part?.text) {
      lastText = event.part.text;
    }
    if (event.type === "step_finish" && typeof event.part?.cost === "number") {
      totalCost += event.part.cost;
    }
  }

  const lines = ["### Investigation"];
  lines.push(
    lastText ? lastText : "_The agent produced no final report -- check the raw log for what happened._"
  );
  if (totalCost > 0) {
    lines.push("", `_Cost: $${totalCost.toFixed(4)}_`);
  }
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
