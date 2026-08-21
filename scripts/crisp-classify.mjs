#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline.
//
// Fetches conversations resolved since the last run, maps each to a repo via
// config/inbox-to-repo.json, and classifies each with a single cheap,
// tool-less model call -- this is the step that keeps cost down, since most
// support conversations are not actionable at all and stop here. Writes:
//   - matrix.json: actionable conversations for Stage 2 to investigate
//   - state/cursor.json: advanced to this run's start time
//
// Provider: OpenAI (swap freely -- Robert's team at ThemeIsle runs a mix and
// switches per cost/quality, we started here only because an OpenAI key
// existed before an Anthropic one did). CLASSIFY_MODEL is intentionally
// required, not defaulted silently: verify the exact model id against your
// OpenAI account (platform.openai.com/docs/models) before relying on it --
// some names floating around as of writing (e.g. "GPT-5.6 Terra/Luna") come
// from low-quality pricing-aggregator sites, not confirmed OpenAI docs.
import { readFile, writeFile } from "node:fs/promises";
import { fetchResolvedConversationsSince, getInboxKey, fetchTranscript } from "./crisp-client.mjs";

const { OPENAI_API_KEY, CLASSIFY_MODEL, GITHUB_STEP_SUMMARY } = process.env;
for (const [name, value] of Object.entries({ OPENAI_API_KEY, CLASSIFY_MODEL })) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

async function classify(transcript) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You triage customer support transcripts for a WordPress plugin company. " +
            "Given a transcript, decide if it describes an actionable software " +
            "defect (bug) or a genuine feature request -- as opposed to a billing " +
            "question, how-to question, client-side misconfiguration, or anything " +
            "that isn't a product code issue. Respond with ONLY a JSON object: " +
            '{"actionable": boolean, "kind": "bug" | "feature" | "none"}. ' +
            "Be conservative: when genuinely unsure whether it's a real product " +
            'defect, prefer {"actionable": false, "kind": "none"} -- the next ' +
            "stage is expensive, so false positives cost real money and false " +
            "negatives just wait for a clearer report.",
        },
        { role: "user", content: transcript },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI classify failed: ${res.status} ${await res.text()}`);
  }
  const { choices } = await res.json();
  const text = choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    console.error(`Unparseable classification response, treating as non-actionable: ${text}`);
    return { actionable: false, kind: "none" };
  }
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const cursor = JSON.parse(await readFile("state/cursor.json", "utf8"));
  const inboxMap = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).inboxes;

  const conversations = await fetchResolvedConversationsSince(cursor.last_checked);
  console.log(`Fetched ${conversations.length} resolved conversations since ${cursor.last_checked}`);

  const matrix = [];
  const skippedUnmapped = [];

  for (const conversation of conversations) {
    const inboxKey = getInboxKey(conversation);
    const mapping = inboxKey && inboxMap[inboxKey];
    if (!mapping) {
      skippedUnmapped.push({ session_id: conversation.session_id, inboxKey });
      continue;
    }

    const transcript = await fetchTranscript(conversation.session_id);
    if (!transcript.trim()) continue;

    const { actionable, kind } = await classify(transcript);
    console.log(`${conversation.session_id}: actionable=${actionable} kind=${kind}`);

    if (actionable && kind !== "none") {
      matrix.push({ session_id: conversation.session_id, repo: mapping.repo, kind });
    }
  }

  await writeFile("matrix.json", JSON.stringify(matrix));
  await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched: ${conversations.length} · Actionable: ${matrix.length} · Unmapped (skipped): ${skippedUnmapped.length}`,
    ];
    if (skippedUnmapped.length) {
      lines.push(``, `Unmapped inbox keys seen (add these to config/inbox-to-repo.json if real):`);
      for (const s of skippedUnmapped) lines.push(`- \`${s.inboxKey}\` (session ${s.session_id})`);
    }
    await writeFile(GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
