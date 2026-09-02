#!/usr/bin/env node
// Stage 1 of the Crisp -> AI -> GitHub issue pipeline.
//
// Fetches conversations resolved since the last run, maps each to a repo,
// and classifies each with one cheap, tool-less model call -- most support
// conversations aren't actionable and stop here.
//
// Also escalates a still-open conversation straight to full investigation,
// without waiting for it to resolve, in two cases:
//   - a private note asks for it explicitly: "!tg-autopilot investigate"
//     (found via Crisp's own text search, not the active-conversation page
//     cap below -- a manual trigger should never depend on how many other
//     conversations were touched more recently)
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
  searchConversationsForManualTrigger,
  fetchRawMessages,
  countManualTriggerNotes,
  credsForAccount,
} from "./crisp-client.mjs";
import { classifyAndRoute } from "./crisp-classifier.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;
const AUTO_ESCALATE_HOURS = 12;
const AUTO_ESCALATE_MAX_HOURS = 24 * 30; // 30 days -- past this, only a manual note escalates it

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
  // session_ids already fully investigated once (any path). Prevents a
  // resolve -> reopen -> resolve cycle from reinvestigating (and re-noting)
  // the same conversation every time -- confirmed for real, 6x in 3 days.
  // Not checked on the manual-note path; that's an intentional re-trigger.
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

      // Fetch raw messages (not just the transcript) so a manual note can be
      // counted below without a second Crisp call.
      const messages = await fetchRawMessages(creds, conversation.session_id);
      const transcript = messages
        .filter((m) => m.type === "text")
        .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
        .join("\n");
      if (!transcript.trim()) continue;

      // A manual "!tg-autopilot investigate" note always overrides the cheap
      // classifier and the investigated guard, same as the active-conversation
      // manual path below -- needed here too, since a conversation reaching
      // this loop has already resolved and so would otherwise never be
      // checked for the note at all (confirmed for real: a note added while
      // still open was invisible here once the conversation resolved before
      // this loop next ran, silently falling back to the cheap classifier's
      // own verdict instead of the human's explicit request).
      const record = escalated[conversation.session_id] ?? { autoEscalated: false, manualNoteCount: 0 };
      const manualNoteCount = countManualTriggerNotes(messages);
      const hasNewManualNote = manualNoteCount > record.manualNoteCount;

      if (hasNewManualNote) {
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        record.manualNoteCount = manualNoteCount;
        escalated[conversation.session_id] = record;
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          manualEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: manual "!tg-autopilot investigate" note -> escalated to ${result.repo}`);
        } else {
          skippedUnmapped.push({ account: accountKey, session_id: conversation.session_id, inboxKey: result.unmappedKey });
        }
        continue;
      }

      if (investigated.has(conversation.session_id)) {
        alreadyInvestigated++;
        continue;
      }

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

    // fetchActiveConversations' page cap can bury a manually-noted
    // conversation on a high-volume account (confirmed for real on
    // THEMEGRILL) -- search directly for the trigger phrase so a manual note
    // is never missed regardless of the cap or how many other conversations
    // were touched more recently. Anything found only here (not already in
    // activeConversations) is appended and always checked this run.
    const seenSessionIds = new Set(activeConversations.map((c) => c.session_id));
    const manualTriggerHits = await searchConversationsForManualTrigger(creds, "!tg-autopilot investigate");
    for (const hit of manualTriggerHits) {
      if (seenSessionIds.has(hit.session_id)) continue;
      hit._checkManualNote = true;
      activeConversations.push(hit);
      seenSessionIds.add(hit.session_id);
    }

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
        // No investigated guard -- a manual re-trigger should always go through.
        const result = await classifyAndRoute(accountConfig, conversation, transcript, { skipClassifier: true });
        record.manualNoteCount = manualNoteCount;
        if (result.repo) {
          matrix.push({ session_id: conversation.session_id, repo: result.repo, kind: result.kind, account: accountKey });
          investigated.add(conversation.session_id);
          manualEscalations++;
          console.log(`[${accountKey}] ${conversation.session_id}: manual "!tg-autopilot investigate" note -> escalated to ${result.repo}`);
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
  // Bound growth, same as active-notified.json.
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
