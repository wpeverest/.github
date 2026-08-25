#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline.
//
// Fetches conversations resolved since the last run, maps each to a repo,
// and classifies each with one cheap, tool-less model call -- most support
// conversations aren't actionable and stop here.
//
// Also escalates a still-open conversation straight to full investigation,
// without waiting for it to resolve, in two cases:
//   - a private note asks for it explicitly: "@tg-autopilot investigate"
//   - it's been open AUTO_ESCALATE_HOURS-AUTO_ESCALATE_MAX_HOURS and the
//     classifier agrees it looks real -- fires at most once automatically;
//     a fresh manual note can always re-trigger, the time-based rule can't.
//     The upper bound exists because this account has a genuine backlog of
//     conversations abandoned for 100+ days -- auto-escalating something
//     that stale blind is a bad default (confirmed for real once). Past the
//     ceiling, only a manual note escalates it.
//
// Writes matrix.json (actionable conversations for Stage 2), state/cursor
// .json (advanced to this run's start time), and state/escalated.json
// (per-session auto-escalation/manual-note bookkeeping so neither repeats).
//
// Provider: OpenAI, swappable freely. CLASSIFY_MODEL is required, not
// defaulted -- verify the model id against your account before relying on it.
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
const AUTO_ESCALATE_MAX_HOURS = 24 * 30; // 30 days -- past this, only a manual note escalates it

// Single-product (or Crisp-tagged-inbox) account: just actionable/kind.
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

// Multi-product account with no structured signal for which one: same
// actionable/kind decision plus product name (from the known list only) and
// free/pro edition. Unknown product is skipped and logged, not guessed at.
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

// Three routing modes: a single-product account maps to one repo directly;
// `inboxes` is for when Crisp structurally tags which product an inbox
// serves; `products` is for many products with no such signal, so the
// classifier names one itself.
//
// `skipClassifier: true` (manual-trigger note) always returns
// actionable=true -- a human already made the call. Still runs
// classifyWithProduct for a `products` account to resolve the repo, ignoring
// that call's own actionable verdict.
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
  // Skip anything the active-conversation dedupe check already matched to a
  // tracked issue -- otherwise this produces a second, redundant comment.
  const activeNotified = new Set(
    JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]"))
  );
  // { [session_id]: { autoEscalated: bool, manualNoteCount: number } }
  const escalated = JSON.parse(await readFile("state/escalated.json", "utf8").catch(() => "{}"));
  // Sessions that have already gone through a full Stage 2 investigation at
  // least once, from ANY path (resolved, auto-escalation, manual note).
  // Without this, a conversation that gets resolved, reopened by the
  // customer, and resolved again shows up as "newly resolved" every cycle --
  // fetchResolvedConversationsSince() has no memory of it, so it gets
  // reinvestigated in full each time. Since crisp-post-note.mjs only dedupes
  // a note against an existing one with the SAME issue URL, a repeated "not
  // a real defect" conclusion (no issue URL) isn't deduped at all -- the
  // customer accumulates one fresh note per resolve/reopen cycle, unbounded
  // (confirmed for real: one conversation got investigated 6 times over 3
  // days). Deliberately NOT checked on the manual-note path -- a human
  // asking "@tg-autopilot investigate" again is an intentional re-trigger,
  // same as the escalation prompt's own re-trigger rule.
  const investigated = new Set(
    JSON.parse(await readFile("state/investigated.json", "utf8").catch(() => "[]"))
  );

  const matrix = [];
  const skippedUnmapped = [];
  let alreadyHandled = 0;
  let alreadyInvestigated = 0;
  let totalFetched = 0;
  let manualEscalations = 0;
  let autoEscalations = 0;

  // Each Crisp account (different logins) is fetched and classified
  // independently; one not yet credentialed is skipped with a warning
  // rather than crashing the whole run.
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
      if (investigated.has(conversation.session_id)) {
        alreadyInvestigated++;
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
        investigated.add(conversation.session_id);
      }
    }

    // ---- Active conversations: manual-note and time-based escalation ----
    // Independent of crisp-dedupe-active.mjs, which skips anything that
    // ends up in matrix.json this run.
    //
    // Only fetch messages for a manual-note check on conversations touched
    // since cursor.last_checked (adding a note is itself an update) -- an
    // exact test, cheaper than fetching every active conversation's history.
    // The staleness check needs no message fetch at all.
    const lastCheckedMs = new Date(cursor.last_checked).getTime();
    const activeConversations = await fetchActiveConversations(creds);
    activeConversations.forEach((conversation) => {
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      conversation._checkManualNote = lastActiveAt > lastCheckedMs;
    });

    for (const conversation of activeConversations) {
      const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };

      // active.last, not created_at: a thread reopened weeks later by a
      // returning customer should get a fresh grace period, not read as
      // "50 days old." Pure conversation metadata -- no message fetch.
      const lastActiveAt = conversation.active?.last ?? conversation.created_at;
      const staleHours = (Date.now() - lastActiveAt) / (1000 * 60 * 60);
      const eligibleForAutoEscalate =
        !record.autoEscalated &&
        !investigated.has(conversation.session_id) &&
        staleHours >= AUTO_ESCALATE_HOURS &&
        staleHours <= AUTO_ESCALATE_MAX_HOURS;

      if (!conversation._checkManualNote && !eligibleForAutoEscalate) continue;

      const messages = await fetchRawMessages(creds, conversation.session_id);
      const manualNoteCount = conversation._checkManualNote ? countManualTriggerNotes(messages) : record.manualNoteCount;
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      if (!hasNewManualNote && !eligibleForAutoEscalate) continue;

      const transcript = messages
        .filter((m) => m.type === "text")
        .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
        .join("\n");
      if (!transcript.trim()) continue;

      if (hasNewManualNote) {
        // No investigated.has() guard here on purpose -- a human explicitly
        // asking to (re-)investigate should always go through, same as the
        // agent prompt's own "a fresh manual note can always re-trigger" rule.
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        record.manualNoteCount = manualNoteCount;
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
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
          investigated.add(conversation.session_id);
          autoEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: stale ${staleHours.toFixed(1)}h, classifier agrees -> escalated to ${result.repo}`);
        }
      }

      escalated[conversation.session_id] = record;
    }
  }

  // The resolved-conversations loop and the active-escalation loop can both
  // claim the same session_id in one run (confirmed for real: a manual note
  // reopens a just-resolved conversation, so both loops pick it up). Dedupe
  // once here, keeping the first entry seen per session_id.
  const seenSessionIds = new Set();
  const dedupedMatrix = matrix.filter((entry) => {
    if (seenSessionIds.has(entry.session_id)) return false;
    seenSessionIds.add(entry.session_id);
    return true;
  });
  const duplicatesRemoved = matrix.length - dedupedMatrix.length;

  await writeFile("matrix.json", JSON.stringify(dedupedMatrix));
  await writeFile("state/cursor.json", JSON.stringify({ last_checked: runStartedAt }, null, 2) + "\n");
  await writeFile("state/escalated.json", JSON.stringify(escalated, null, 2) + "\n");
  // Bound growth the same way as active-notified.json -- a session doesn't
  // need to stay in here forever, just long enough to survive its own
  // resolve/reopen cycles.
  await writeFile("state/investigated.json", JSON.stringify([...investigated].slice(-2000)));

  if (GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Crisp triage — Stage 1`,
      ``,
      `Fetched: ${totalFetched} · Actionable: ${dedupedMatrix.length} · Unmapped (skipped): ${skippedUnmapped.length} · Already handled while active (skipped): ${alreadyHandled} · Already fully investigated before (skipped): ${alreadyInvestigated}${duplicatesRemoved ? ` · Duplicate session_id across loops (deduped): ${duplicatesRemoved}` : ""}`,
      `Escalated from active: ${manualEscalations} manual, ${autoEscalations} auto (stale ${AUTO_ESCALATE_HOURS}h–${AUTO_ESCALATE_MAX_HOURS}h)`,
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
