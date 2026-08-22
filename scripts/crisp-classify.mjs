#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline.
//
// Fetches conversations resolved since the last run, maps each to a repo via
// config/inbox-to-repo.json, and classifies each with a single cheap,
// tool-less model call -- this is the step that keeps cost down, since most
// support conversations are not actionable at all and stop here.
//
// Also escalates a still-open (active) conversation straight to full
// investigation in two cases, without waiting for it to resolve:
//   - a private note asks for it explicitly: "@tg-autopilot investigate"
//   - it's been open more than AUTO_ESCALATE_HOURS and the cheap classifier
//     agrees it looks like a real bug/feature -- fires at most ONCE per
//     conversation automatically; a fresh manual note can always re-trigger,
//     but the time-based rule never repeats on its own (real investigation
//     cost, not worth re-spending hourly on the same still-open ticket).
//
// Writes:
//   - matrix.json: actionable conversations for Stage 2 to investigate
//   - state/cursor.json: advanced to this run's start time
//   - state/escalated.json: which active conversations were already
//     auto-escalated (time-based) or which manual-note count was last
//     actioned per session, so neither path repeats itself needlessly
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
  fetchActiveConversations,
  getInboxKey,
  fetchTranscript,
  fetchRawMessages,
  countManualTriggerNotes,
  credsForAccount,
} from "./crisp-client.mjs";
import { chatJSON } from "./openai-client.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;
const AUTO_ESCALATE_HOURS = 12;

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

// Shared by the resolved-conversation loop and the manual/time escalation
// checks: three routing modes, checked in order. A single-product account
// maps everything to one repo directly (no lookup at all); an `inboxes` map
// is for when Crisp itself structurally tags which product an inbox serves;
// `products` is for an account with many products and no such signal, where
// the classifier itself has to name which one.
//
// `skipClassifier: true` (used for a manual-trigger note) always returns
// actionable=true -- the whole point of a human tagging it is that they've
// already made the call, so a cheap classifier shouldn't get to override
// that judgment. It still runs classifyWithProduct for a `products` account
// purely to resolve which repo, ignoring that call's own actionable verdict.
async function classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier = false } = {}) {
  if (accountConfig.repo) {
    const { actionable, kind } = skipClassifier
      ? { actionable: true, kind: "bug" }
      : await classify(transcript);
    return { repo: accountConfig.repo, actionable, kind };
  }

  if (accountConfig.products) {
    const productNames = Object.keys(accountConfig.products);
    const result = await classifyWithProduct(transcript, productNames);
    const mapping = accountConfig.products[result.product];
    if (!mapping) return { repo: null, unmappedKey: `product:${result.product}` };
    const repo = result.edition === "pro" && mapping.pro ? mapping.pro : mapping.free;
    return skipClassifier
      ? { repo, actionable: true, kind: result.kind === "feature" ? "feature" : "bug" }
      : { repo, actionable: result.actionable, kind: result.kind };
  }

  const inboxKey = getInboxKey(conversation);
  const mapping = inboxKey && accountConfig.inboxes?.[inboxKey];
  if (!mapping) return { repo: null, unmappedKey: inboxKey };
  const { actionable, kind } = skipClassifier
    ? { actionable: true, kind: "bug" }
    : await classify(transcript);
  return { repo: mapping.repo, actionable, kind };
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const cursor = JSON.parse(await readFile("state/cursor.json", "utf8"));
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  // If the active-conversation dedupe check already matched this session to
  // a tracked issue while it was still open, running it through the full
  // pipeline again just produces a second, redundant "recurrence" comment on
  // the same issue -- observed for real on themegrill/colormag#291.
  const activeNotified = new Set(
    JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]"))
  );
  // Per-session bookkeeping for the two active-conversation escalation
  // paths: { [session_id]: { autoEscalated: bool, manualNoteCount: number } }
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));

  const matrix = [];
  const skippedUnmapped = [];
  let alreadyHandled = 0;
  let totalFetched = 0;
  let manualEscalations = 0;
  let autoEscalations = 0;

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

    // ---- Resolved conversations: the full pipeline, as before ----
    const conversations = await fetchResolvedConversationsSince(creds, cursor.last_checked);
    totalFetched += conversations.length;
    console.log(`[${accountKey}] fetched ${conversations.length} resolved conversations since ${cursor.last_checked}`);

    for (const conversation of conversations) {
      if (activeNotified.has(conversation.session_id)) {
        alreadyHandled++;
        continue;
      }

      const transcript = await fetchTranscript(creds, conversation.session_id);
      if (!transcript.trim()) continue;

      const result = await classifyAndRoute(accountConfig, conversation, transcript);
      if (!result.repo) {
        skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
        continue;
      }

      console.log(`[${accountKey}] ${conversation.session_id}: actionable=${result.actionable} kind=${result.kind} repo=${result.repo}`);

      if (result.actionable && result.kind !== "none") {
        matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
      }
    }

    // ---- Active conversations: manual-note and time-based escalation ----
    // Deliberately independent of the lightweight dedupe-only check in
    // crisp-dedupe-active.mjs, which skips anything that ends up in
    // matrix.json this run (see its own skip logic).
    const activeConversations = await fetchActiveConversations(creds);
    for (const conversation of activeConversations) {
      const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
      const messages = await fetchRawMessages(creds, conversation.session_id);
      const manualNoteCount = countManualTriggerNotes(messages);
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      const ageHours = (Date.now() - conversation.created_at) / (1000 * 60 * 60);
      const eligibleForAutoEscalate = !record.autoEscalated && ageHours >= AUTO_ESCALATE_HOURS;

      if (!hasNewManualNote && !eligibleForAutoEscalate) continue;

      const transcript = messages
        .filter((m) => m.type === "text")
        .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
        .join("\n");
      if (!transcript.trim()) continue;

      if (hasNewManualNote) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        record.manualNoteCount = manualNoteCount;
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          manualEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: manual "@tg-autopilot investigate" note -> escalated to ${result.repo}`);
        } else {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
        }
      } else if (eligibleForAutoEscalate) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript);
        record.autoEscalated = true; // fires at most once, whether actionable or not
        if (result.repo && result.actionable && result.kind !== "none") {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          autoEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: open ${ageHours.toFixed(1)}h, classifier agrees -> escalated to ${result.repo}`);
        }
      }

      escalated[conversation.session_id] = record;
    }
  }

  await writeFile("matrix.json", JSON.stringify(matrix));
  await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");
  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched: ${totalFetched} · Actionable: ${matrix.length} · Unmapped (skipped): ${skippedUnmapped.length} · Already handled while active (skipped): ${alreadyHandled}`,
      `Escalated from active: ${manualEscalations} manual, ${autoEscalations} auto (open ${AUTO_ESCALATE_HOURS}h+)`,
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
