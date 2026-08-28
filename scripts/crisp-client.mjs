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

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries on 429 with exponential backoff (honoring Retry-After if Crisp
// sends one). Confirmed for real: crisp-dedupe-active.mjs's per-conversation
// loop has no throttling and hit Crisp's per-route rate limit once active
// conversation volume across both accounts reached ~800 -- a fixed,
// deterministic failure every run until the burst above the limit is worn
// down by backoff, not just a one-off flake.
async function crispFetch(path, options, method) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${CRISP_BASE}${path}`, options);
    if (res.status !== 429) {
      if (!res.ok) throw new Error(`Crisp ${method} ${path} failed: ${res.status} ${await res.text()}`);
      return res.json();
    }
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Crisp ${method} ${path} failed: 429 ${await res.text()} (gave up after ${MAX_RETRIES} retries)`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : BASE_RETRY_DELAY_MS * 2 ** attempt);
  }
}

// Website Tokens (what we use) require X-Crisp-Tier: website, not "plugin".
export async function crispGet(creds, path) {
  return crispFetch(path, { headers: { Authorization: authHeader(creds), "X-Crisp-Tier": "website" } }, "GET");
}

export async function crispPost(creds, path, body) {
  return crispFetch(
    path,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "X-Crisp-Tier": "website",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    "POST"
  );
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

// Fetch every currently-active (not-yet-resolved) conversation, capped at 10
// pages (~200) so cost stays bounded regardless of open-ticket volume.
// Halved from 20 pages (~400) after onboarding a second Crisp account pushed
// combined per-run volume in crisp-dedupe-active.mjs to ~800 requests and hit
// Crisp's per-route rate limit for real.
//
// order_date_updated=1 sorts most-recently-updated first, so the cap only
// drops the least-recently-touched conversations rather than arbitrary ones.
// This is NOT enough on its own to guarantee a manual trigger note survives
// the cap, though -- confirmed for real on a high-volume account (THEMEGRILL,
// which itself exceeds the cap): if 200+ *other* conversations get touched
// between runs, a manually-noted conversation can still fall outside the
// window despite being freshly updated. See searchConversationsForManualTrigger
// below for how manual triggers avoid depending on this cap at all.
export async function fetchActiveConversations(creds) {
  const conversations = [];
  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams({ filter_not_resolved: "true", order_date_updated: "1" });
    const { data } = await crispGet(creds, `/website/${creds.websiteId}/conversations/${page}?${params}`);
    if (!data || data.length === 0) break;
    conversations.push(...data);
    if (data.length < 20) break;
  }
  return conversations;
}

// Finds active conversations containing `phrase` anywhere in their content
// (including private notes -- Crisp's search doesn't distinguish note text
// from regular messages), via Crisp's own search rather than paginating the
// full active list. A manual trigger note should never depend on
// fetchActiveConversations' page cap or its most-recently-updated ordering --
// the phrase match here is authoritative regardless of how many other
// conversations were touched more recently. Small page cap is enough since
// genuine matches for a specific trigger phrase should be rare.
export async function searchConversationsForManualTrigger(creds, phrase) {
  const conversations = [];
  for (let page = 1; page <= 5; page++) {
    const params = new URLSearchParams({
      filter_not_resolved: "true",
      search_type: "text",
      search_query: phrase,
    });
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
export function countManualTriggerNotes(messages, phrase = "!tg-autopilot investigate") {
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
