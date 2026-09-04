# tg-autopilot

Shared GitHub automation for ThemeGrill's repos across the `wpeverest` and `themegrill` orgs, run under one machine-user identity, **`tg-autopilot`**. No server, no dashboard — everything here is a scheduled or triggered GitHub Actions workflow, called by a small per-repo caller workflow.

We use a machine user instead of a GitHub App because it keeps one identity across both orgs without an App's separate installation/permission model. One quirk worth knowing up front: `tg-autopilot`'s API type is `"User"`, not `"Bot"` — see `write-safe-bot-workflow` under [Maintainer skills](#maintainer-skills) before writing anything that checks a comment author's type.

## What's here

| Feature | Files | Docs |
|---|---|---|
| **PR build-zip comment** — builds a plugin/theme zip on every ready-for-review PR, uploads it, and posts/updates one comment with a direct download link | `.github/workflows/pr-build-zip.yml` + `.caller.yml` | [SETUP.md](SETUP.md) |
| **PR review automation** — requests Copilot as a reviewer when a PR opens, and lets team members trigger a Copilot code review by commenting a trigger phrase | `.github/workflows/copilot-review-on-comment.yml` + `.caller.yml` | inline comments in the workflow file |
| **Crisp → AI → GitHub issue** — hourly pipeline that reads resolved (and some still-open) Crisp support conversations, classifies whether they describe a real bug/feature, and either files a GitHub issue, comments on an existing one, or leaves a note back in the Crisp conversation | `.github/workflows/crisp-triage.yml`, `scripts/`, `prompts/`, `config/`, `state/` | [PHASE2-SETUP.md](PHASE2-SETUP.md) |

## Maintainer skills

`.claude/skills/` has step-by-step guides for the maintenance tasks below. Start here before touching config or workflows by hand — each one already bakes in the gotchas this README used to spell out inline.

| Skill | Use it when... |
|---|---|
| `onboard-pr-build-zip-repo` | adding a repo to the build-zip pipeline, or fixing a failed auto-detected build |
| `onboard-copilot-review-repo` | adding a repo to the Copilot auto-review pipeline |
| `onboard-crisp-account` | wiring up a *new Crisp workspace* (a product with its own separate Crisp login) — not the same as onboarding a repo |
| `propagate-shared-secret` | adding a brand-new secret/variable that needs to reach every private repo in both orgs |
| `transfer-repo-across-orgs` | moving a repo between `wpeverest` and `themegrill` |
| `debug-crisp-401-errors` | crisp-triage is failing with a Crisp API auth error |
| `write-safe-bot-workflow` | writing or editing any comment-triggered workflow |
| `verify-github-actions-change` | a change you just made looks like it didn't take effect |

## Onboarding a new repo

**Build-zip / Copilot review**: add the repo's name to the right org's array in `config/copilot-review-repos.json`, then re-run the matching propagate workflow (`workflow_dispatch`, this repo's Actions tab):

- `Propagate Copilot review on comment` — opens a PR on the new repo adding `copilot-review-on-comment.yml`, and sets its repo-level `BOT_TOKEN`.
- `Propagate PR build ZIP workflow` — inspects the new repo's own build tooling and opens a PR with an auto-detected `pr-build-zip.yml`. Auto-detection is a best guess, not a guarantee — see `onboard-pr-build-zip-repo`'s checklist if the opened PR's build fails.
- `Propagate pr-build-zip secrets to all repos` — only needs re-running if the new repo is missing `ARTIFACTS_KEY`/`ARTIFACTS_SECRET`.

Don't hand-copy `*.caller.yml` into a repo directly — that was the original Phase 1 approach, superseded by the scripts above. They're idempotent: re-running them after adding one new repo name doesn't touch repos already onboarded.

The Copilot reviewer rollout is currently limited to `themegrill/colormag` and `themegrill/zakra` for testing — the propagation workflow's `repositories` input controls the target list.

**Crisp triage**: add the target repo (or product name, for the multi-product `THEMEGRILL` account) to `config/inbox-to-repo.json` — see [PHASE2-SETUP.md § 4](PHASE2-SETUP.md#4-populate-configinbox-to-repojson). No caller workflow needed; this one runs centrally against every mapped repo. Wiring up a brand-new Crisp *account* is a separate step — see `onboard-crisp-account`.

## How the cross-org access works

A fine-grained PAT is scoped to exactly **one** org, so `tg-autopilot` holds two:

- **`BOT_TOKEN`** — scoped to `wpeverest`, where this repo itself lives.
- **`BOT_TOKEN_THEMEGRILL`** — scoped to `themegrill`, for its 25+ product repos.

Both live as org secrets on `wpeverest`, since that's where every workflow here actually *runs*. Each workflow picks the right token dynamically based on the target repo's org (see `startsWith(matrix.repo, 'themegrill/') && ...` in `crisp-triage.yml`).

**The one rule to remember for every future secret**: both orgs are on GitHub's Free plan, where an org-level secret silently never reaches a private repo — no error, it just resolves empty. The fix is always a repo-level copy of the secret. Full explanation and the reference script: `propagate-shared-secret` skill.

## Debugging a run

- **Actions tab** on this repo (`themegrill/.github`) → find the workflow run → each job's logs are per-conversation/per-PR, not aggregated.
- A failed "Investigate" job in Crisp triage can be safely re-run on its own from the run page (**Re-run job**) — it retries the same conversation, no state to reset first. See [PHASE2-SETUP.md § 4d](PHASE2-SETUP.md#4d-investigate-job-concurrency-and-openai-rate-limits) for why this happens.
- Committed state (`state/*.json`) is the pipeline's only memory of what it's already processed. If a run looks like it's reprocessing something it shouldn't, check whether "Commit advanced state" actually succeeded on the *prior* run, not just whether the investigation itself did.
- If a mutation you just made (a secret, a workflow file, a PR reviewer) looks like it didn't take — see `verify-github-actions-change` before assuming the fix failed.
