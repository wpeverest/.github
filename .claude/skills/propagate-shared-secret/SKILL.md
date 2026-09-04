---
name: propagate-shared-secret
description: Add a brand-new secret (or variable) that needs to reach every private repo across the wpeverest and themegrill orgs, working around GitHub Free's org-secret-to-private-repo limitation.
---

# Propagate a new shared secret across both orgs

## The trap this exists to avoid

**Both `wpeverest` and `themegrill` are on GitHub's Free plan.** On Free, an org-level Actions secret's "repository access" setting only ever offers "All public repositories" — there is no way to extend it to private repos on any tier below Team. It fails **silently**: the workflow still runs, the secret just resolves empty (or, for a `workflow_call` input, errors clearly with "Secret X is required, but not provided") — there's no permissions error pointing at the real cause.

Confirmed twice, the same way both times: something works perfectly on whichever repo it's first tested against (because that repo happened to be public), then fails identically on every *other* repo in a rollout, because every private repo was silently never going to work. This hit `BOT_TOKEN`/`BOT_TOKEN_THEMEGRILL` first, then `ARTIFACTS_KEY`/`ARTIFACTS_SECRET` again later — including on `wpeverest` itself, so don't assume the "home" org is exempt.

## The fix

Give each private repo its own **repo-level** copy of the secret instead of relying on the org-level one. A repo-level secret has no plan/visibility restriction on any tier, and always takes precedence over an org-level secret of the same name. Critically, `secrets: inherit` on a caller workflow already includes repo-level secrets — a caller using `inherit` doesn't need to change once the repo-level copy exists.

Website IDs / other non-secret identifiers: use a repo **variable**, not a secret — same reasoning applies (Free-plan org variables also can't reach private repos), plus GitHub masks any string matching a registered secret's *value* everywhere it appears in logs, which makes debugging confusing if a non-credential value is stored as a secret unnecessarily.

## Steps

1. Build (or reuse) a script that loops every repo across both orgs and sets the repo-level secret unconditionally — don't bother checking per-repo visibility first, it's simpler to just always set it. `scripts/propagate-pr-build-zip-secrets.mjs` is the current reference implementation.
2. Confirm the PAT driving this has the **Secrets** permission category specifically — see the fine-grained-PAT note below, it's independent of Contents/Workflows/Actions and 403s in a way that looks like a general access problem.
3. When adding *any* brand-new secret to this system going forward, assume from the start that it will need this same repo-level propagation for every private repo in both orgs — build it in rather than discovering the silent-failure pattern a third time.

## Fine-grained PAT permissions are more granular than they look

A fine-grained PAT's permission list has several categories that sound related but are checked completely independently — missing one gives a 403 that looks like a general access problem, not a missing-scope problem:

- **Contents** — reading/writing ordinary files.
- **Workflows** — separate permission specifically for `.github/workflows/*`. `Contents: Read and write` alone is not enough; you'll get "Resource not accessible by personal access token" on that path specifically while every other file write succeeds.
- **Secrets** — separate, needed for both `GET .../actions/secrets/public-key` and `PUT .../actions/secrets/{name}`.
- **Actions** — needed for triggering `repository_dispatch` and reading/managing workflow runs.

When a new script needs to touch workflow files or secrets on a repo it hasn't touched before, check all four permissions up front instead of discovering each 403 one at a time.

## Verification

`gh api`/`gh` CLI can serve a cached response for a `GET` shortly after your own `PUT`/`DELETE` — see the `verify-github-actions-change` skill. Use a fresh `curl` (or wait and retry) when confirming a secret propagation actually took effect, especially seconds after running it.
