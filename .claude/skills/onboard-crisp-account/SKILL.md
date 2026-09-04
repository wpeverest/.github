---
name: onboard-crisp-account
description: Onboard a new Crisp workspace/account (e.g. a new product with its own separate Crisp login) into the crisp-triage pipeline. Distinct from onboarding a GitHub repo — this is about adding a new support-inbox source.
---

# Onboard a new Crisp account to crisp-triage

Use this when a *new Crisp login/workspace* needs to feed the hourly Crisp → AI → GitHub pipeline — not when you're just mapping an existing account's inbox to a different or additional repo (that's just an edit to `config/inbox-to-repo.json`, no new account setup).

Confirmed for real: `user-registration` and `themegrill` are genuinely separate Crisp accounts (different logins), not just different inboxes under one account — credentials cannot be shared between them.

## Steps

1. **Generate a Website Token**, not a Plugin Token — a Plugin Token needs a Marketplace developer account and approval flow, which is overkill for internal automation. Log into the new Crisp account → Settings → Workspace Settings → Advanced configuration → API Token → Generate Token. Copy the identifier+key pair immediately (shown once). The website ID is visible in the same settings area or in the URL.

2. **Add credentials following the exact naming convention** — the account key (e.g. `EVEREST_FORMS`) must match the key you'll use in `config/inbox-to-repo.json`:
   - Secrets: `CRISP_<ACCOUNT>_IDENTIFIER`, `CRISP_<ACCOUNT>_KEY`
   - Repo **variable** (not a secret): `CRISP_<ACCOUNT>_WEBSITE_ID`

   The website ID must be a variable, not a secret — it's an identifier, not a credential, and GitHub masks any string matching a registered secret's value everywhere it appears (including unrelated log lines), which makes debugging confusing for no benefit. Set these at the **repo level** on `wpeverest` (where the workflow runs) — see the `propagate-shared-secret` skill for why org-level won't reach a private repo on GitHub Free.

3. **Add the three lines to `crisp-triage.yml`'s `classify` job `env:` block.** Stage 2 (investigation) already resolves credentials dynamically by account key via `credsForAccount()` in `scripts/crisp-client.mjs` — no workflow change needed there.

4. **Map the account in `config/inbox-to-repo.json`.** A single-product account maps directly to one repo. A multi-product account (like `THEMEGRILL`, serving 25+ themes/plugins with no structured per-product signal in Crisp segments) needs its known product list here too — Stage 1's classifier reads the transcript and names a product from this list. An unmatched product is skipped and logged in the run summary, not guessed at — check periodically and add products the classifier is missing.

5. **If this is a second (or later) GitHub org**, confirm a bot token exists for that org — see `transfer-repo-across-orgs` skill's PAT section. The workflow already picks the right token by branching on the target repo's org prefix; a third org means one more branch in that expression (or switch to a lookup table once there are more than two).

6. **Critical — seed escalated state before the account's first scheduled run.** Run `Seed escalated state for a new Crisp account` (`workflow_dispatch`, input = the account key) once, *before* `crisp-triage` runs on a schedule for this account. Without this, every currently-active conversation older than 12 hours looks "auto-escalation eligible" on day one, since `escalated.json` has no history for a brand-new account. Confirmed for real: onboarding User Registration without seeding first caused ~83% of its ~400-conversation active backlog to auto-escalate within minutes of a single run. Seeding marks the existing backlog as already-escalated so none of it fires; it does not block the manual `!tg-autopilot investigate` note path on any of that backlog.

## Verification

Trigger `crisp-triage` manually (`workflow_dispatch`) before trusting the hourly schedule. Confirm: the new account's credentials resolve (no `Missing Crisp env vars for account "X"` error), a resolved test conversation gets classified, and the active-conversation dedupe step doesn't flood anything (check job duration and rate-limit behavior if it runs alongside other accounts in the same matrix — see `debug-crisp-401-errors` skill if requests start failing under combined load).
