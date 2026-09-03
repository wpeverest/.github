# tg-autopilot

Shared GitHub automation for ThemeGrill's repos across the `wpeverest` and `themegrill` orgs, run under one machine-user identity, **`tg-autopilot`**. No server, no dashboard — everything here is a scheduled or triggered GitHub Actions workflow, called by a small per-repo caller workflow.

Why a machine user instead of a GitHub App: it keeps one identity across both orgs without an App's separate installation/permission model, and it's what the reference implementation this was built from (`pirate-bot`) also uses. **Important trap this caused once already**: a machine user's API type is `"User"`, not `"Bot"` — code that checks `comment.user.type === 'Bot'` to find `tg-autopilot`'s own comments will never match. Match on `comment-author: tg-autopilot` (or whatever login you use) plus a stable body marker instead.

## What's here

| Feature | Files | Docs |
|---|---|---|
| **PR build-zip comment** — builds a plugin/theme zip on every ready-for-review PR, uploads it, and posts/updates one comment with a direct download link | `.github/workflows/pr-build-zip.yml` + `.caller.yml` | [SETUP.md](SETUP.md) |
| **PR review automation** — requests Copilot as a reviewer when a PR opens, and lets team members trigger a Copilot code review by commenting a trigger phrase | `.github/workflows/copilot-review-on-comment.yml` + `.caller.yml` | inline comments in the workflow file |
| **Crisp → AI → GitHub issue** — hourly pipeline that reads resolved (and some still-open) Crisp support conversations, classifies whether they describe a real bug/feature, and either files a GitHub issue, comments on an existing one, or leaves a note back in the Crisp conversation | `.github/workflows/crisp-triage.yml`, `scripts/`, `prompts/`, `config/`, `state/` | [PHASE2-SETUP.md](PHASE2-SETUP.md) |

## Onboarding a new repo

**Build-zip / Copilot review**: add the repo's name to the right org's array in `config/copilot-review-repos.json`, then re-run the matching propagate workflow (`workflow_dispatch`, this repo's Actions tab):

- `Propagate Copilot review on comment` — opens a PR on the new repo adding `copilot-review-on-comment.yml`, and sets its repo-level `BOT_TOKEN`.
- `Propagate PR build ZIP workflow` — inspects the new repo's own build tooling (package.json/Gruntfile.js/gulpfile.js/composer.json) and opens a PR with an auto-detected `pr-build-zip.yml`. **Auto-detection is a best guess, not a guarantee** — the PR it opens is the actual test of whether the detected `build-command`/`zip-glob` produce a real ZIP; check the run and fix the `with:` block if it fails (see `scripts/propagate-pr-build-zip.mjs`'s own comments for the detection heuristics and their known blind spots, e.g. a packaging script not named `release`/`build`).
- `Propagate pr-build-zip secrets to all repos` — only needs re-running if the new repo needs `ARTIFACTS_KEY`/`ARTIFACTS_SECRET` and doesn't already have them (see the Free-plan gotcha below — this is required for the ZIP build to actually work, not just for the PR to open).

Don't hand-copy `*.caller.yml` into a repo directly anymore — that was the original Phase 1 approach, superseded by the scripts above once more than a couple of repos needed onboarding. The scripts are idempotent: re-running them after adding one new repo name doesn't touch or duplicate anything on the repos already onboarded.

**Crisp triage**: add the target repo (or product name, for the multi-product `THEMEGRILL` account) to `config/inbox-to-repo.json` — see [PHASE2-SETUP.md § 4](PHASE2-SETUP.md#4-populate-configinbox-to-repojson). No caller workflow needed here; this one runs centrally against every mapped repo.

## Cross-org reach

A fine-grained PAT is scoped to exactly **one** resource owner (one org), so `tg-autopilot` holds two:

- **`BOT_TOKEN`** — scoped to `wpeverest`. Also where this repo itself lives, so this token needs `Contents: Read and write` here specifically (Stage 1 of the Crisp pipeline commits its own advanced state back).
- **`BOT_TOKEN_THEMEGRILL`** — scoped to `themegrill`, for its 25+ product repos (colormag, zakra, etc.).

Both are stored as org secrets on `wpeverest`, since that's where every workflow here actually *runs*, regardless of which org each token grants access into. Workflows pick the right one dynamically based on the target repo's org (see `startsWith(matrix.repo, 'themegrill/') && ...` in `crisp-triage.yml` for the pattern).

## GitHub Free plan: org secrets never reach a private repo — remember this for every future secret

**Both `wpeverest` and `themegrill` are on GitHub's Free plan.** On Free, an org-level Actions secret's "repository access" setting only ever offers "All public repositories" — there is no way to extend it to private repos, on any plan tier below Team. It fails *silently*: the workflow still runs, the secret just resolves empty (or, for a `workflow_call` input, the call errors clearly with "Secret X is required, but not provided") — there's no permissions error pointing at the real cause.

Confirmed for real, twice, the same way both times: something worked perfectly on whichever repo it was first tested against, then failed identically on every *other* repo in the rollout — because the first test happened to land on one of the few public repos, and every private repo was silently never going to work.

- `BOT_TOKEN` / `BOT_TOKEN_THEMEGRILL` — hit this first with the Copilot-review rollout.
- `ARTIFACTS_KEY` / `ARTIFACTS_SECRET` — hit this again with the pr-build-zip rollout, this time on `wpeverest` itself (not just `themegrill` — it's not a themegrill-specific quirk, don't assume `wpeverest` is exempt just because it's the "home" org).

**The fix, every time**: give each repo its own **repo-level** copy of the secret instead of relying on the org-level one. A repo-level secret has no plan/visibility restriction on any plan, and always takes precedence over an org-level secret of the same name — and critically, `secrets: inherit` already includes repo-level secrets, so a caller workflow using `inherit` doesn't need to change to naming secrets explicitly once the repo-level copy exists.

**When adding a brand new secret to this system in the future**: assume it will need the same repo-level propagation treatment for every private repo in both orgs, and build that in from the start rather than discovering it the same way twice more. `scripts/propagate-pr-build-zip-secrets.mjs` is the current reference implementation (loops both orgs, sets repo-level secrets unconditionally for simplicity rather than checking visibility per repo).

## Fine-grained PAT permissions are more granular than they look

A fine-grained PAT's permission list has several categories that sound related but are checked completely independently — missing one gives a 403 that looks like a general access problem, not a missing-scope problem:

- **Contents** — reading/writing ordinary files.
- **Workflows** — a *separate* permission specifically for writing to `.github/workflows/*`. `Contents: Read and write` alone is not enough to add or edit a workflow file via the API; you'll get "Resource not accessible by personal access token" on that path specifically, while every other file write succeeds fine.
- **Secrets** — also separate, needed for both `GET .../actions/secrets/public-key` and `PUT .../actions/secrets/{name}`. Missing this fails the exact repo-level-secret-propagation pattern described above.
- **Actions** — needed for triggering `repository_dispatch` and reading/managing workflow runs.

Confirmed for real: the propagation PATs needed all four added one at a time across separate failures before the Copilot-review and pr-build-zip rollouts worked end to end. When a new script needs to touch workflow files or secrets on a repo it hasn't touched before, check all four up front instead of discovering each 403 one at a time.

## `gh api`/`gh` CLI caches responses — don't trust an immediate re-check

The `gh` CLI (both `gh api` and commands built on it) can serve a cached response for a `GET` shortly after a `PUT`/`DELETE` you just made — confirmed for real while debugging a Copilot-reviewer issue: removing then re-adding a PR reviewer showed the *old* state on the very next `gh api .../requested_reviewers` call, making a real fix look like it hadn't worked. A plain `curl` (or waiting and retrying) bypasses this. When verifying that a mutation actually took effect — especially seconds after making it — prefer a fresh `curl` over `gh api` if the result looks stale or contradicts what should have just changed.

## A bot's own comment must never be able to re-trigger its own workflow

Any `issue_comment`-triggered workflow that might post its *own* comment back (a status update, an error notice, a "try again" message) needs to make sure that comment can't match its own trigger phrase — otherwise it can loop forever. Confirmed for real on `copilot-review-on-comment.yml`: an early version's failure-notice comment said "try commenting `@tg-autopilot review` again," which contains the trigger phrase itself, so posting it re-triggered the workflow, which could fail again, post the notice again, indefinitely (caught after ~20 runs on one PR). The fix that actually matters is excluding comments authored by `tg-autopilot` itself from the trigger condition — not just rewording the message, since any future message could reintroduce the same trap by accident.

## Copilot code-review requests are genuinely flaky/slow at the platform level

`gh pr edit --add-reviewer @copilot` (what `copilot-review-on-comment.yml` uses) can take well over a minute between the request "succeeding" and Copilot actually showing up as a reviewer — and can occasionally need a second attempt to register at all. This isn't a bug in this repo's workflow; it's confirmed inconsistent GitHub-platform-side behavior. Don't add a quick success/fail check here without a generous polling window — an earlier version that gave up after ~25 seconds reported false failures on requests that were quietly still working in the background. See the "Request Copilot review" step's own comments in `copilot-review-on-comment.yml` for the current polling approach.

## Debugging a run

- **Actions tab** on this repo (`wpeverest/.github`) → find the workflow run → each job's logs are per-conversation/per-PR, not aggregated.
- A failed "Investigate" job in Crisp triage can be safely re-run on its own from the run page (**Re-run job**) — it retries the same conversation, no state to reset first. See [PHASE2-SETUP.md § 4d](PHASE2-SETUP.md#4d-investigate-job-concurrency-and-openai-rate-limits) for why this happens and when it's expected.
- Committed state (`state/*.json`) is the pipeline's only memory of what it's already processed. If a run looks like it's reprocessing something it shouldn't, check whether the "Commit advanced state" step actually succeeded on the prior run, not just whether the investigation itself did.
