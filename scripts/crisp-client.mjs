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

// VERIFY: this assumes a conversation exposes its inbox as either `inbox_id`
// at the top level, or as one of `meta.segments`. Log a real conversation
// object and confirm/adjust before trusting the mapping.
export function getInboxKey(conversation) {
  if (conversation.inbox_id) return conversation.inbox_id;
  const segments = conversation.meta?.segments ?? [];
  return segments[0] ?? null;
}

// VERIFY: exact path per Crisp's REST API v1 conversation-messages endpoint.
export async function fetchTranscript(creds, sessionId) {
  const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversation/${sessionId}/messages`);
  return (data ?? [])
    .filter((m) => m.type === "text")
    .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");
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
