// Shared Crisp REST API v1 client. Every script that talks to Crisp imports
// from here, so the auth header and endpoint paths exist in exactly one
// place -- duplicating this across scripts is exactly the kind of drift that
// bit us in Phase 1 (see pr-build-zip.yml's history).
//
// Credentials are passed explicitly as a `creds = { identifier, key,
// websiteId }` object, not read implicitly from fixed env vars: Stage 1
// juggles multiple Crisp ACCOUNTS (separate logins, e.g. one for
// user-registration, one for themegrill) in a single process, so there is no
// single "the" set of Crisp env vars to read globally.
const CRISP_BASE = "https://api.crisp.chat/v1";

// Confirmed working against a real conversation.
export function conversationUrl(creds, sessionId) {
  return `https://app.crisp.chat/website/${creds.websiteId}/inbox/${sessionId}/`;
}

function authHeader(creds) {
  if (!creds?.identifier || !creds?.key) {
    throw new Error("Crisp credentials missing identifier/key");
  }
  return "Basic " + Buffer.from(`${creds.identifier}:${creds.key}`).toString("base64");
}

// Website Tokens (what we use -- generated directly in Settings > Workspace
// Settings > Advanced configuration, no Marketplace account or approval
// needed, unlike Plugin Tokens) require X-Crisp-Tier: website, not "plugin".
export async function crispGet(creds, path) {
  const res = await fetch(`${CRISP_BASE}${path}`, {
    headers: { Authorization: authHeader(creds), "X-Crisp-Tier": "website" },
  });
  if (!res.ok) throw new Error(`Crisp GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function crispPost(creds, path, body) {
  const res = await fetch(`${CRISP_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(creds),
      "X-Crisp-Tier": "website",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Crisp POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Fetch every resolved conversation updated since `sinceIso`, across pages.
export async function fetchResolvedConversationsSince(creds, sinceIso) {
  const conversations = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({ filter_resolved: "true", filter_date_start: sinceIso });
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversations/${page}?${params}`);
    if (!data || data.length === 0) break;
    conversations.push(...data);
    if (data.length < 20) break; // last page (Crisp's default page size)
  }
  return conversations;
}

// Fetch every currently-active (not yet resolved) conversation, across
// pages, capped at 20 pages (~400 conversations) -- bounds cost regardless
// of how many tickets happen to be open at once. Used for the lightweight
// dedupe-only check on active conversations, and for the manual/time-based
// escalation checks in crisp-classify.mjs.
//
// order_date_updated=1 sorts most-recently-updated first. This matters for
// real correctness, not just tidiness: a support agent adding a manual
// trigger note UPDATES the conversation, and with 100+ conversations
// routinely active in this account (confirmed for real -- every run without
// this hit the old 5-page cap), a freshly-noted conversation could land past
// page 5 and never get fetched at all if sorted some other way. Confirmed
// missing exactly this way once already: a manual-trigger note went
// undetected because its conversation was never in the fetched pages.
// VERIFY: Crisp's docs describe filter_resolved and filter_not_resolved as
// two separate params (not one true/false toggle) -- using the latter here.
// Confirm against a real response before trusting this excludes resolved
// conversations correctly.
export async function fetchActiveConversations(creds) {
  const conversations = [];
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ filter_not_resolved: "true", order_date_updated: "1" });
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversations/${page}?${params}`);
    if (!data || data.length === 0) break;
    conversations.push(...data);
    if (data.length < 20) break;
  }
  return conversations;
}

// VERIFY: this assumes a conversation exposes its inbox as either `inbox_id`
// at the top level, or as one of `meta.segments`. Log a real conversation
// object and confirm/adjust before trusting the mapping.
export function getInboxKey(conversation) {
  if (conversation.inbox_id) return conversation.inbox_id;
  const segments = conversation.meta?.segments ?? [];
  return segments[0] ?? null;
}

// VERIFY: exact path per Crisp's REST API v1 conversation-messages endpoint.
export async function fetchRawMessages(creds, sessionId) {
  const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${sessionId}/messages`);
  return data ?? [];
}

export async function fetchTranscript(creds, sessionId) {
  const messages = await fetchRawMessages(creds, sessionId);
  return messages
    .filter((m) => m.type === "text")
    .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");
}

// Counts private notes containing this phrase -- support explicitly asking
// for a full investigation right now, regardless of resolved status or what
// a cheap classifier would say. Deliberately a count, not an attempt to
// identify "which" note: no message field is confirmed to reliably
// distinguish two notes with identical text (support could plausibly post
// the exact same trigger phrase twice), so counting sidesteps needing one.
// Callers store the count they last actioned per session; a HIGHER count on
// a later check means a genuinely new note was added since, even if its
// text is identical to one already actioned.
export function countManualTriggerNotes(messages, phrase = "@tg-autopilot investigate") {
  return messages.filter(
    (m) => m.type === "note" && (m.content ?? "").toLowerCase().includes(phrase.toLowerCase())
  ).length;
}

// VERIFY: exact path/shape for adding a private note to a conversation.
export async function postNote(creds, sessionId, note) {
  return crispPost(creds, `/website/${creds.websiteId}/conversation/${sessionId}/message`, {
    type: "note",
    from: "operator",
    origin: "chat",
    content: note,
  });
}

// Builds a creds object from this account's env vars, given the account key
// (e.g. "USER_REGISTRATION" -> CRISP_USER_REGISTRATION_IDENTIFIER/_KEY/_WEBSITE_ID).
export function credsForAccount(accountKey) {
  const identifier = process.env[`CRISP_${accountKey}_IDENTIFIER`];
  const key = process.env[`CRISP_${accountKey}_KEY`];
  const websiteId = process.env[`CRISP_${accountKey}_WEBSITE_ID`];
  if (!identifier || !key || !websiteId) {
    throw new Error(
      `Missing Crisp env vars for account "${accountKey}": expected CRISP_${accountKey}_IDENTIFIER, ` +
        `CRISP_${accountKey}_KEY, CRISP_${accountKey}_WEBSITE_ID`
    );
  }
  return { identifier, key, websiteId };
}
