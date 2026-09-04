#!/usr/bin/env node
// Lightweight dedupe check for currently-ACTIVE (not yet resolved) Crisp
// conversations. Deliberately narrow: never files a new issue, only checks
// for a match against an already-open one and notifies both sides -- safe
// to run on an incomplete conversation, unlike full investigation (see
// prompts/crisp-triage-agent.md for why new-issue filing waits for resolve).
import { readFile, writeFile } from "node:fs/promises";
import {
  fetchActiveConversations,
  getInboxKey,
  fetchTranscript,
  postNote,
  credsForAccount,
  conversationUrl,
} from "./crisp-client.mjs";
import { chatJSON } from "./openai-client.mjs";
import { listOpenIssues, listIssueComments, commentOnIssue } from "./github-client.mjs";

const { GITHUB_STEP_SUMMARY } = process.env;

// Reuses the account's routing config to resolve one repo per conversation,
// without needing the full actionable/kind decision this path never uses.
async function resolveRepo(accountConfig, transcript, conversation) {
  if (accountConfig.repo) return accountConfig.repo;

  if (accountConfig.products) {
    const productNames = Object.keys(accountConfig.products);
    const { product, edition } = await chatJSON(
      "Given a customer support transcript, name which ONE product from this " +
        `exact list it is about: ${productNames.join(", ")}. Never invent a name ` +
        'not in this list -- if you cannot tell, use "unknown". Also note whether ' +
        "it indicates the PRO/premium edition (license, purchase, Pro-only " +
        'features) or free (default). Respond with ONLY a JSON object: ' +
        '{"product": "<name>" | "unknown", "edition": "free" | "pro"}.',
      transcript,
      { product: "unknown", edition: "free" }
    );
    const mapping = accountConfig.products[product];
    if (!mapping) return null;
    return edition === "pro" && mapping.pro ? mapping.pro : mapping.free;
  }

  const inboxKey = getInboxKey(conversation);
  return (inboxKey && accountConfig.inboxes?.[inboxKey]?.repo) || null;
}

// Title alone is not enough context to match on -- two issues can share a
// surface phrase ("charged twice") while describing entirely different
// problems (a one-off billing complaint about buying a license on
// wpeverest.com vs. a product code defect in the plugin's own payment
// gateway on a customer's site). A short body excerpt lets the model
// actually compare what happened, not just how it was titled.
function issueSummary(issue) {
  const excerpt = (issue.body ?? "").slice(0, 500).replace(/\n+/g, " ").trim();
  return `#${issue.number}: ${issue.title}\n${excerpt}`;
}

async function findMatchingIssue(transcript, issues) {
  if (issues.length === 0) return null;
  const list = issues.map(issueSummary).join("\n\n");
  const { matchedNumber } = await chatJSON(
    "You check whether a customer support transcript describes the SAME " +
      "underlying problem as one of these already-tracked GitHub issues " +
      "(title + a short excerpt of each):\n\n" +
      `${list}\n\nA match requires the same actual problem, not just similar ` +
      "wording -- e.g. a customer asking for a refund because their OWN " +
      "purchase/license was billed twice on wpeverest.com is NOT the same " +
      "issue as a product defect where the plugin's payment code double-" +
      "charges END USERS on a customer's own site, even though both could " +
      'be described as "charged twice." Likewise, a general question about ' +
      "how a feature/setting works, or a request for a feature that doesn't " +
      "exist yet, is never a match for a tracked bug. " +
      'Respond with ONLY a JSON object: {"matchedNumber": <issue number>} ' +
      'if there is a genuine match, or {"matchedNumber": null} if none clearly match or ' +
      "you're unsure. Be conservative -- a wrong match creates noise on someone " +
      "else's issue, so only match when the described problem is really the same.",
    transcript,
    { matchedNumber: null }
  );
  return issues.find((i) => i.number === matchedNumber) ?? null;
}

async function main() {
  const accounts = JSON.parse(await readFile("config/inbox-to-repo.json", "utf8")).accounts;
  const notified = new Set(JSON.parse(await readFile("state/active-notified.json", "utf8").catch(() => "[]")));
  // Skip anything crisp-classify.mjs already escalated into matrix.json this
  // run, so it doesn't also get this lighter dedupe-only treatment.
  const escalatedThisRun = new Set(
    JSON.parse(await readFile("matrix.json", "utf8").catch(() => "[]")).map((m) => m.session_id)
  );

  let checked = 0;
  let matched = 0;

  for (const [accountKey, accountConfig] of Object.entries(accounts)) {
    let creds;
    try {
      creds = credsForAccount(accountKey);
    } catch (err) {
      console.warn(`[${accountKey}] skipping: ${err.message}`);
      continue;
    }

    const conversations = await fetchActiveConversations(creds);
    console.log(`[${accountKey}] ${conversations.length} active conversations`);

    for (const conversation of conversations) {
      if (notified.has(conversation.session_id)) continue;
      if (escalatedThisRun.has(conversation.session_id)) continue;
      checked++;

      const transcript = await fetchTranscript(creds, conversation.session_id);
      if (!transcript.trim()) continue;

      const repo = await resolveRepo(accountConfig, transcript, conversation);
      if (!repo) continue;

      const issues = await listOpenIssues(repo);
      const match = await findMatchingIssue(transcript, issues);
      if (!match) continue;

      // Skip if the matched issue is the one THIS conversation itself
      // caused -- otherwise it matches back to its own issue every rescan.
      if ((match.body ?? "").includes(conversation.session_id)) {
        notified.add(conversation.session_id);
        console.log(`[${accountKey}] ${conversation.session_id}: matched ${repo}#${match.number} but it's the issue's own source -- skipping`);
        continue;
      }

      // state/active-notified.json can lose a recent entry to a racy git
      // rebase (crisp-triage.yml's state commit uses `-X ours`) -- guard
      // against GitHub's own comment history instead, which has no such race.
      const existingComments = await listIssueComments(repo, match.number);
      const alreadyCommented = existingComments.some((c) =>
        (c.body ?? "").includes(conversation.session_id)
      );
      if (alreadyCommented) {
        notified.add(conversation.session_id);
        console.log(`[${accountKey}] ${conversation.session_id}: already commented on ${repo}#${match.number} -- skipping duplicate comment`);
        continue;
      }

      matched++;
      const issueUrl = `https://github.com/${repo}/issues/${match.number}`;
      await commentOnIssue(
        repo,
        match.number,
        `Another user appears to be hitting this same issue.\n\nSource: [Crisp conversation](${conversationUrl(creds, conversation.session_id)})`
      );
      await postNote(
        creds,
        conversation.session_id,
        `This looks like a known tracked issue: ${issueUrl}`
      );
      notified.add(conversation.session_id);
      console.log(`[${accountKey}] ${conversation.session_id}: matched ${repo}#${match.number}`);
    }
  }

  // Bound growth: keep only the most recent 2000 entries. A conversation
  // that resolves moves into the full pipeline via its own cursor, so it
  // doesn't need to stay in this list forever.
  const trimmed = [...notified].slice(-2000);
  await writeFile("state/active-notified.json", JSON.stringify(trimmed));

  if (GITHUB_STEP_SUMMARY) {
    await writeFile(
      GITHUB_STEP_SUMMARY,
      `### Crisp triage — active-conversation dedupe check\n\nChecked: ${checked} · Matched: ${matched}\n`,
      { flag: "a" }
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
