// Shared Crisp REST API v1 client -- one place for auth/endpoints.
//
// Credentials are passed explicitly as a `creds` object, not read from fixed
// env vars: Stage 1 juggles multiple Crisp accounts in one process.
const CRISP_BASE = "https://api.crisp.chat/v1";

export function conversationUrl(creds, sessionId) {
  return `https://app.crisp.chat/website/${creds.websiteId}/inbox/${sessionId}/`;
}

function authHeader(creds) {
  if (!creds?.identifier || !creds?.key) {
    throw new Error("Crisp credentials missing identifier/key");
  }
  return "Basic " + Buffer.from(`${creds.identifier}:${creds.key}`).toString("base64");
}

// Website Tokens (what we use) require X-Crisp-Tier: website, not "plugin".
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

// Fetch every currently-active (not-yet-resolved) conversation, capped at 20
// pages (~400) so cost stays bounded regardless of open-ticket volume.
//
// order_date_updated=1 sorts most-recently-updated first -- a manual
// trigger note updates the conversation, so this guarantees a fresh note
// surfaces near the top instead of getting buried past the page cap
// (confirmed missing once already, before this sort was added).
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

export function getInboxKey(conversation) {
  if (conversation.inbox_id) return conversation.inbox_id;
  const segments = conversation.meta?.segments ?? [];
  return segments[0] ?? null;
}

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

// A count, not an attempt to identify "which" note -- two notes can have
// identical text, so callers track the count they last actioned per session
// and treat a higher count as a genuinely new note.
export function countManualTriggerNotes(messages, phrase = "@tg-autopilot investigate") {
  return messages.filter(
    (m) => m.type === "note" && (m.content ?? "").toLowerCase().includes(phrase.toLowerCase())
  ).length;
}

export async function postNote(creds, sessionId, note) {
  return crispPost(creds, `/website/${creds.websiteId}/conversation/${sessionId}/message`, {
    type: "note",
    from: "operator",
    origin: "chat",
    content: note,
  });
}

// Builds a creds object from this account's env vars (e.g.
// "USER_REGISTRATION" -> CRISP_USER_REGISTRATION_IDENTIFIER/_KEY/_WEBSITE_ID).
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
