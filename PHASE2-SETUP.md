# Phase 2 setup — Crisp → AI → GitHub issue

Files added for this phase, all in `wpeverest/.github`:

- `.github/workflows/crisp-triage.yml` — the hourly pipeline
- `scripts/crisp-client.mjs` — shared Crisp REST client (auth, fetch, post)
- `scripts/crisp-classify.mjs` — Stage 1: fetch + cheap classify
- `scripts/crisp-fetch-transcript.mjs`, `scripts/build-prompt.mjs`, `scripts/crisp-post-note.mjs` — Stage 2 helpers
- `prompts/crisp-triage-agent.md` — the agent's instructions
- `state/cursor.json` — persisted "last checked" timestamp
- `config/inbox-to-repo.json` — Crisp inbox → GitHub repo mapping (**you must populate this**)

## ⚠️ Not yet verified against a live Crisp account

No Crisp token existed while writing this, so a few specifics are best-guesses from Crisp's public API docs, marked `VERIFY:` in the code:

1. **How a conversation exposes its inbox/segment** (`getInboxKey()` in `crisp-client.mjs`). Log one real conversation object from `fetchResolvedConversationsSince()` and confirm the actual field before trusting the repo mapping.
2. **The exact messages-fetch endpoint path** (`fetchTranscript()`).
3. **The exact note-posting endpoint/shape** (`postNote()`).

Do a manual dry run against one real resolved conversation before enabling the hourly schedule, and adjust these three spots if the real API disagrees with the docs.

## 1. Crisp API tokens — one per account, not one total

`user-registration` and `themegrill` are on **separate Crisp accounts** (different logins), not just different inboxes under one account — confirmed directly, not assumed. That means **two independent tokens**, created separately in each account, and credentials cannot be shared between them.

Use a **Website Token**, not a Plugin Token — this matters, they're genuinely different things:
- A **Plugin Token** requires a separate Marketplace developer account, creating a "plugin" there, requesting production-scope approval, and installing it on the website via a private install link. That's for third-party/distributable integrations — overkill for our own internal automation.
- A **Website Token** is generated directly inside the workspace, no Marketplace account, no approval step. This is the right one.

For **each** account: log into that Crisp account → **Settings → Workspace Settings → Advanced configuration** → **API Token** section → **Generate Token**. Copy the pair immediately — shown only once. This also gives you the website ID (visible in that same settings area, or in the URL).

Note: Website Tokens are capped at 10,000 requests/day and only a workspace owner can manage them — both are fine for our hourly-poll volume.

Naming convention — the account key (`USER_REGISTRATION`, `THEMEGRILL`, matching `config/inbox-to-repo.json`) must exactly match the suffix in these names:

| Account | Secrets | Variable (not a secret) |
|---|---|---|
| User Registration | `CRISP_USER_REGISTRATION_IDENTIFIER`, `CRISP_USER_REGISTRATION_KEY` | `CRISP_USER_REGISTRATION_WEBSITE_ID` |
| ThemeGrill | `CRISP_THEMEGRILL_IDENTIFIER`, `CRISP_THEMEGRILL_KEY` | `CRISP_THEMEGRILL_WEBSITE_ID` |

The website ID is a plain **repo variable**, not a secret — it's an identifier, not a credential, and Phase 1 already taught us the cost of treating a non-secret as one: GitHub masks any string matching a secret's value everywhere it appears, including inside unrelated plain text. Repo variables: Settings → Secrets and variables → Actions → **Variables** tab.

Onboarding a third Crisp account later means: create its token, add its three secrets/variable following the same naming convention, add its account key + inbox mappings to `config/inbox-to-repo.json`, and add its three lines to the `classify` job's `env:` block in the workflow (Stage 2 already resolves credentials dynamically by account, no workflow change needed there).

## 2. Model provider — currently OpenAI (swap later freely)

Using OpenAI for now since that key already exists; not a hardcoded commitment — Robert's own team mixes providers and switches per cost/quality, and everything here reads the provider via env vars/config, not hardcoded calls.

- Org secret `OPENAI_API_KEY`.
- Repo variables `CLASSIFY_MODEL` and `INVESTIGATE_MODEL` (both default to `gpt-5-mini` in the workflow if unset). **Verify the exact model id against your own OpenAI account** (platform.openai.com/docs/models) before trusting the default — some names circulating as of writing (e.g. "GPT-5.6 Terra/Luna") come from low-quality pricing-aggregator sites, not confirmed OpenAI documentation.
- `gpt-5-mini` is a reasonable Stage 1 classifier (cheap, tool-less). For Stage 2's actual code investigation, consider a stronger reasoning-tier model once you've confirmed the plumbing works — `gpt-5-mini` is fine for proving the pipeline, not necessarily for investigation quality.
- If/when an Anthropic key arrives: swap `OPENAI_API_KEY` references for `ANTHROPIC_API_KEY`, change the classify script's endpoint to `api.anthropic.com/v1/messages`, and change `--model "openai/..."` to `--model "anthropic/..."` in the workflow. **Anthropic must be a pay-as-you-go API key** — their terms prohibit using a Claude subscription (Free/Pro/Max) OAuth token in third-party tools like OpenCode.

## 3. Upgrade `tg-autopilot`'s PAT scope

Phase 1's PAT has **Contents: Read-only**. Stage 1 needs to commit the advanced `cursor.json` back to `wpeverest/.github`, which needs **Contents: Read and write** on that specific repo. Edit the existing fine-grained PAT (or issue a new one) to add that scope.

## 4. Populate `config/inbox-to-repo.json`

Replace the placeholder entry with real Crisp inbox IDs mapped to the repo each should investigate against. An unmapped conversation is **skipped, not guessed at** — check the workflow's step summary after a run for any inbox keys it saw but couldn't map, and add them if real.

## 5. Sanity-check cost before enabling the schedule

ThemeIsle's own numbers: $0.0003 per conversation when Stage 1 (or a quick Stage 2 look) concludes "no bug," up to ~$2 for a deep investigation that finds and files a real bug. Before turning on the hourly cron, estimate your actual resolved-conversation volume and multiply by a rough blended cost to sanity-check the monthly bill. Start with `workflow_dispatch` manual runs, not the schedule, until you trust the numbers.

## Verification

1. **Dry run one conversation**: manually resolve a test conversation in Crisp with an obvious, reproducible bug description, then run the workflow via `workflow_dispatch`. Confirm: the right repo gets checked out, an issue is filed with the full structured body, and `cursor.json` advances.
2. **Dedupe**: resolve a second conversation describing the *same* bug → confirm a comment on the existing issue, not a duplicate.
3. **Client-side note-back**: resolve a conversation that's clearly a client-side misunderstanding → confirm a note lands in that Crisp conversation and no GitHub issue is filed.
4. **Cursor correctness**: run again with no new conversations → confirm nothing gets re-processed.
