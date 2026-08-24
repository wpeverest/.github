#!/usr/bin/env node
// Re-fetches the transcript for Stage 2 rather than passing Stage 1's copy
// through the job matrix, keeping matrix.json small.
import { fetchTranscript } from "./crisp-client.mjs";

const [sessionId] = process.argv.slice(2);
if (!sessionId) {
  console.error("Usage: crisp-fetch-transcript.mjs <session_id>");
  process.exit(1);
}

const creds = {
  identifier: process.env.CRISP_IDENTIFIER,
  key: process.env.CRISP_KEY,
  websiteId: process.env.CRISP_WEBSITE_ID,
};

const transcript = await fetchTranscript(creds, sessionId);
process.stdout.write(transcript);
