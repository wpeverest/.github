# tg-autopilot

Shared GitHub automation for ThemeGrill's repos across the `wpeverest` and `themegrill` orgs, run under one machine-user identity, **`tg-autopilot`**. No server, no dashboard — everything here is a scheduled or triggered GitHub Actions workflow, called by a small per-repo caller workflow.

Why a machine user instead of a GitHub App: it keeps one identity across both orgs without an App's separate installation/permission model, and it's what the reference implementation this was built from (`pirate-bot`) also uses. **Important trap this caused once already**: a machine user's API type is `"User"`, not `"Bot"` — code that checks `comment.user.type === 'Bot'` to find `tg-autopilot`'s own comments will never match. Match on `comment-author: tg-autopilot` (or whatever login you use) plus a stable body marker instead.

## What's here

| Feature | Files | Docs |
|---|---|---|
| **PR build-zip comment** — builds a plugin/theme zip on every ready-for-review PR, uploads it, and posts/updates one comment with a direct download link | `.github/workflows/pr-build-zip.yml` + `.caller.yml` | [SETUP.md](SETUP.md) |
| **Copilot review on comment** — lets any team member trigger a Copilot code review on a PR by commenting a trigger phrase, without needing their own Copilot seat | `.github/workflows/copilot-review-on-comment.yml` + `.caller.yml` | inline comments in the workflow file |
| **Crisp → AI → GitHub issue** — hourly pipeline that reads resolved (and some still-open) Crisp support conversations, classifies whether they describe a real bug/feature, and either files a GitHub issue, comments on an existing one, or leaves a note back in the Crisp conversation | `.github/workflows/crisp-triage.yml`, `scripts/`, `prompts/`, `config/`, `state/` | [PHASE2-SETUP.md](PHASE2-SETUP.md) |

## Onboarding a new repo

**Build-zip / Copilot review**: copy the relevant `*.caller.yml` into the target repo's `.github/workflows/`, fill in its inputs (see the caller file's own comments), and make sure `tg-autopilot` has write access to that repo.

**Crisp triage**: add the target repo (or product name, for the multi-product `THEMEGRILL` account) to `config/inbox-to-repo.json` — see [PHASE2-SETUP.md § 4](PHASE2-SETUP.md#4-populate-configinbox-to-repojson). No caller workflow needed here; this one runs centrally against every mapped repo.

## Cross-org reach

A fine-grained PAT is scoped to exactly **one** resource owner (one org), so `tg-autopilot` holds two:

- **`BOT_TOKEN`** — scoped to `wpeverest`. Also where this repo itself lives, so this token needs `Contents: Read and write` here specifically (Stage 1 of the Crisp pipeline commits its own advanced state back).
- **`BOT_TOKEN_THEMEGRILL`** — scoped to `themegrill`, for its 25+ product repos (colormag, zakra, etc.).

Both are stored as org secrets on `wpeverest`, since that's where every workflow here actually *runs*, regardless of which org each token grants access into. Workflows pick the right one dynamically based on the target repo's org (see `startsWith(matrix.repo, 'themegrill/') && ...` in `crisp-triage.yml` for the pattern).

## Debugging a run

- **Actions tab** on this repo (`wpeverest/.github`) → find the workflow run → each job's logs are per-conversation/per-PR, not aggregated.
- A failed "Investigate" job in Crisp triage can be safely re-run on its own from the run page (**Re-run job**) — it retries the same conversation, no state to reset first. See [PHASE2-SETUP.md § 4d](PHASE2-SETUP.md#4d-investigate-job-concurrency-and-openai-rate-limits) for why this happens and when it's expected.
- Committed state (`state/*.json`) is the pipeline's only memory of what it's already processed. If a run looks like it's reprocessing something it shouldn't, check whether the "Commit advanced state" step actually succeeded on the prior run, not just whether the investigation itself did.
