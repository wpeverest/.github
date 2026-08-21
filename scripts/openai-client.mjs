// Shared cheap-classification call, used by both the resolved-conversation
// classifier and the active-conversation dedupe check -- factored out so the
// fetch/parse boilerplate exists in exactly one place.
const { OPENAI_API_KEY, CLASSIFY_MODEL } = process.env;

export async function chatJSON(systemPrompt, userContent, fallback) {
  if (!OPENAI_API_KEY || !CLASSIFY_MODEL) {
    throw new Error("Missing required env var: OPENAI_API_KEY or CLASSIFY_MODEL");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI call failed: ${res.status} ${await res.text()}`);
  }
  const { choices } = await res.json();
  const text = choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    console.error(`Unparseable model response, using fallback: ${text}`);
    return fallback;
  }
}
