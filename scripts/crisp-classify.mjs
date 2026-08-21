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
import {
  fetchResolvedConversationsSince,
  getInboxKey,
  fetchTranscript,
  credsForAccount,
} from "./crisp-client.mjs";
import { chatJSON } from "./openai-client.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;

// For a single-product (or Crisp-tagged-inbox) account: just actionable/kind.
async function classify(transcript) {
  return chatJSON(
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
    transcript,
    { actionable: false, kind: "none" }
  );
}

// For an account with many products and no structured Crisp signal for which
// one: same actionable/kind decision, plus which product (from the known
// list only -- never invent a name) and free/pro edition. Unknown product is
// the safe default: skipped and logged for a human to add, not guessed at.
async function classifyWithProduct(transcript, productNames) {
  return chatJSON(
    "You triage customer support transcripts for a WordPress theme/plugin company " +
      "with many products. Given a transcript, decide (1) if it describes an " +
      "actionable software defect (bug) or a genuine feature request -- as opposed " +
      "to a billing question, how-to question, client-side misconfiguration, or " +
      "anything that isn't a product code issue; (2) which ONE product from this " +
      `exact list it is about: ${productNames.join(", ")}. Never invent a name not ` +
      'in this list -- if you cannot tell, or it doesn\'t match any of these, use ' +
      '"unknown"; (3) whether the transcript indicates the PRO/premium edition ' +
      "(mentions of a license, purchase, or Pro-only features) or the free edition " +
      "(the default when unclear). Respond with ONLY a JSON object: " +
      '{"actionable": boolean, "kind": "bug" | "feature" | "none", ' +
      '"product": "<exact-name-from-list>" | "unknown", "edition": "free" | "pro"}. ' +
      "Be conservative on actionable/kind: when genuinely unsure whether it's a " +
      'real product defect, prefer {"actionable": false, "kind": "none"} -- the ' +
      "next stage is expensive, so false positives cost real money and false " +
      "negatives just wait for a clearer report.",
    transcript,
    { actionable: false, kind: "none", product: "unknown", edition: "free" }
  );
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const cursor = JSON.parse(await readFile("state/cursor.json", "utf8"));
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;

  const matrix = [];
  const skippedUnmapped = [];
  let totalFetched = 0;

  // Two separate Crisp ACCOUNTS (different logins), not just different
  // inboxes under one account -- each is fetched and classified independently.
  // An account not yet credentialed (e.g. still awaiting access) is skipped
  // with a warning rather than crashing the whole run.
  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch (err) {
      console.warn(`[${accountKey}] skipping: ${err.message}`);
      continue;
    }
    const conversations = await fetchResolvedConversationsSince(creds, cursor.last_checked);
    totalFetched += conversations.length;
    console.log(`[${accountKey}] fetched ${conversations.length} resolved conversations since ${cursor.last_checked}`);

    for (const conversation of conversations) {
      const transcript = await fetchTranscript(creds, conversation.session_id);
      if (!transcript.trim()) continue;

      // Three routing modes, checked in order: a single-product account maps
      // everything to one repo directly (no lookup at all); an `inboxes` map
      // is for when Crisp itself structurally tags which product an inbox
      // serves; `products` is for an account with many products and no such
      // signal, where the classifier itself has to name which one.
      let repo, actionable, kind;

      if (accountConfig.repo) {
        repo = accountConfig.repo;
        ({ actionable, kind } = await classify(transcript));
      } else if (accountConfig.products) {
        const productNames = Object.keys(accountConfig.products);
        const result = await classifyWithProduct(transcript, productNames);
        ({ actionable, kind } = result);
        const mapping = accountConfig.products[result.product];
        if (!mapping) {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: `product:${result.product}` });
          continue;
        }
        repo = result.edition === "pro" && mapping.pro ? mapping.pro : mapping.free;
      } else {
        const inboxKey = getInboxKey(conversation);
        const mapping = inboxKey && accountConfig.inboxes?.[inboxKey];
        if (!mapping) {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey });
          continue;
        }
        repo = mapping.repo;
        ({ actionable, kind } = await classify(transcript));
      }

      console.log(`[${accountKey}] ${conversation.session_id}: actionable=${actionable} kind=${kind} repo=${repo}`);

      if (actionable && kind !== "none") {
        matrix.push({ session_id: conversation.session_id, repo, kind, account: accountKey });
      }
    }
  }

  await writeFile("matrix.json", JSON.stringify(matrix));
  await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched: ${totalFetched} · Actionable: ${matrix.length} · Unmapped (skipped): ${skippedUnmapped.length}`,
    ];
    if (skippedUnmapped.length) {
      lines.push(``, `Unmapped inbox keys / unidentified products seen (add these to config/inbox-to-repo.json if real):`);
      for (const s of skippedUnmapped) lines.push(`- [${s.account}] \`${s.inboxKey}\` (session ${s.session_id})`);
    }
    await writeFile(GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
