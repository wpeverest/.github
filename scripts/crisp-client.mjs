// Shared Crisp REST API v1 client. Every script that talks to Crisp imports
// from here, so the auth header and endpoint paths exist in exactly one
// place -- duplicating this across scripts is exactly the kind of drift that
// bit us in Phase 1 (see pr-build-zip.yml's history).
const CRISP_BASE = "https://api.crisp.chat/v1";

function authHeader() {
  const { CRISP_IDENTIFIER, CRISP_KEY } = process.env;
  if (!CRISP_IDENTIFIER || !CRISP_KEY) {
    throw new Error("CRISP_IDENTIFIER and CRISP_KEY must be set");
  }
  return "Basic " + Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString("base64");
}

function websiteId() {
  const { CRISP_WEBSITE_ID } = process.env;
  if (!CRISP_WEBSITE_ID) throw new Error("CRISP_WEBSITE_ID must be set");
  return CRISP_WEBSITE_ID;
}

export async function crispGet(path) {
  const res = await fetch(`${CRISP_BASE}${path}`, {
    headers: { Authorization: authHeader(), "X-Crisp-Tier": "plugin" },
  });
  if (!res.ok) throw new Error(`Crisp GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function crispPost(path, body) {
  const res = await fetch(`${CRISP_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "X-Crisp-Tier": "plugin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Crisp POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Fetch every resolved conversation updated since `sinceIso`, across pages.
export async function fetchResolvedConversationsSince(sinceIso) {
  const conversations = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({ filter_resolved: "true", filter_date_start: sinceIso });
    const { data } = await crispGet(`/website/${websiteId()}/conversations/${page}?${params}`);
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
export async function fetchTranscript(sessionId) {
  const { data } = await crispGet(`/website/${websiteId()}/conversation/${sessionId}/messages`);
  return (data ?? [])
    .filter((m) => m.type === "text")
    .map((m) => `${m.from === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");
}

// VERIFY: exact path/shape for adding a private note to a conversation.
export async function postNote(sessionId, note) {
  return crispPost(`/website/${websiteId()}/conversation/${sessionId}/message`, {
    type: "note",
    from: "operator",
    origin: "chat",
    content: note,
  });
}
