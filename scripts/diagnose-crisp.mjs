import { crispGet, credsForAccount } from "./crisp-client.mjs";

const creds = credsForAccount("THEMEGRILL");

async function tryCall(label, params) {
  try {
    const data = await crispGet(creds, `/website/${creds.websiteId}/conversations/1?${params}`);
    console.log(`[${label}] OK - got ${data.data?.length ?? 0} conversations`);
  } catch (err) {
    console.log(`[${label}] FAILED - ${err.message}`);
  }
}

await tryCall("filter_not_resolved only", new URLSearchParams({ filter_not_resolved: "true" }));
await tryCall("filter_resolved only", new URLSearchParams({ filter_resolved: "true" }));
await tryCall("filter_resolved + date_start", new URLSearchParams({ filter_resolved: "true", filter_date_start: "2026-09-03T05:43:50.610Z" }));
await tryCall("filter_resolved + date_start (no ms)", new URLSearchParams({ filter_resolved: "true", filter_date_start: "2026-09-03T05:43:50Z" }));
await tryCall("no filter at all", new URLSearchParams({}));
