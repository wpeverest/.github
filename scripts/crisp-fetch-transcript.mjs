#!/usr/bin/env node
// Re-fetches one conversation's transcript for Stage 2. Stage 1 already
// fetched it once during classification, but that result isn't passed
// through the job matrix (keeps matrix.json small) -- re-fetching is one
// cheap Crisp call, not worth plumbing through job outputs to avoid.
import { fetchTranscript } from "./crisp-client.mjs";

const [sessionId] = process.argv.slice(2);
if (!sessionId) {
  console.error("Usage: crisp-fetch-transcript.mjs <session_id>");
  process.exit(1);
}

const transcript = await fetchTranscript(sessionId);
process.stdout.write(transcript);
