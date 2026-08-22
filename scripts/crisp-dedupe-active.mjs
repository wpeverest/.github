#!/usr/bin/env node
// Lightweight dedupe check for currently-ACTIVE (not yet resolved) Crisp
// conversations. Deliberately narrow: never files a new issue and never
// investigates code -- only checks whether a conversation matches an
// already-open GitHub issue, and if so notifies both sides. This is safe to
// run on an incomplete/still-open conversation in a way that full
// investigation is not (see prompts/crisp-triage-agent.md's reasoning for
// why new-issue filing waits for a conversation to resolve).
//
// No OpenCode, no repo checkout: matching against already-open issue titles
// is a plain cheap classification call, and posting a comment/note is a
// plain API call -- none of that needs an agent or a cloned repo.
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
import { listOpenIssues, commentOnIssue } from "./github-client.mjs";

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

async function findMatchingIssue(transcript, issues) {
  if (issues.length === 0) return null;
  const list = issues.map((i) => `#${i.number}: ${i.title}`).join("\n");
  const { matchedNumber } = await chatJSON(
    "You check whether a customer support transcript describes the SAME " +
      "underlying problem as one of these already-tracked GitHub issues:\n\n" +
      `${list}\n\nRespond with ONLY a JSON object: {"matchedNumber": <issue number>} ` +
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
  // crisp-classify.mjs runs before this step and may have already escalated
  // some of these same active conversations (manual note, or open 6h+) into
  // matrix.json for full investigation. Skip those here so a conversation
  // doesn't get both a full investigation AND this lighter dedupe-only
  // treatment in the same run.
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

      // The matched issue can be the one THIS same conversation originally
      // caused -- a still-open conversation gets re-scanned every hour and
      // will otherwise match back to its own issue, producing a false
      // "another user is hitting this" comment on a conversation that IS
      // the source. Confirmed for real: session_f118221b matched back to
      // colormag#293, which its own Source: line said it had filed.
      if ((match.body ?? "").includes(conversation.session_id)) {
        notified.add(conversation.session_id);
        console.log(`[${accountKey}] ${conversation.session_id}: matched ${repo}#${match.number} but it's the issue's own source -- skipping`);
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
