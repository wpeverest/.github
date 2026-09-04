#!/usr/bin/env node
import { fetchRawMessages, credsForAccount } from "./crisp-client.mjs";

const [sessionId] = process.argv.slice(2);
const creds = credsForAccount("USER_REGISTRATION");
const messages = await fetchRawMessages(creds, sessionId);
for (const m of messages) {
  console.log(`--- [${m.type}] from=${m.from} ---`);
  console.log(m.content);
  console.log("");
}
