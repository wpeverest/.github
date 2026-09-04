---
name: transfer-repo-across-orgs
description: Transfer a GitHub repo between the wpeverest and themegrill orgs (or onboard a new org generally) without breaking tg-autopilot's automation across it.
---

# Transfer a repo between orgs

Grounded in the `wpeverest/.github` → `themegrill/.github` transfer.

## Before transferring

1. **Clear any name collision** in the destination org (e.g. if a repo with the same name already exists there, decide what happens to it first — this is a manual judgment call, don't automate past it).
2. **Gather every secret and variable** on the source repo/org you'll need to recreate on the destination — GitHub does not carry org-level secrets across a transfer automatically, since the repo is joining a different org's secret scope entirely.
3. **Extend the relevant PAT's permissions** if the destination org wasn't previously covered — see the fine-grained-PAT note in `propagate-shared-secret` skill. A PAT is scoped to exactly one resource owner (org); moving a repo to a new org that the existing PAT doesn't cover means either a new PAT or an expanded one.

## During/after transfer

4. **Run the transfer** via GitHub's own repo transfer flow (Settings → Danger Zone → Transfer). Old `org/repo` URLs redirect automatically afterward. Issue/PR numbering continues from where it left off.
5. **Recreate secrets/variables** on the destination org/repo, following the repo-level pattern in `propagate-shared-secret` skill rather than assuming org-level will reach every repo.
6. **Fix every self-referential token reference.** Any workflow in the transferred repo that referenced its *own* org's bot token by name (e.g. a `.github` repo's own workflows calling `secrets.BOT_TOKEN` when that secret was scoped to the *old* org) needs updating to the new org-appropriate secret name. This is easy to miss because the workflow still runs — it just fails at the point that specific token is actually used. Do a full-repo grep for the old secret name across every `.yml`/`.mjs` file, not just the ones you remember touching.
7. **Bulk-fix every downstream caller.** If this is a shared `.github` repo that other repos' caller workflows reference by `uses: <org>/.github/...@...`, every caller across every repo in both orgs needs its reference updated to the new org path. This can mean bulk-opening and bulk-merging dozens of PRs — confirm each one's diff is exactly the path-rename before merging, and merge in batches you can roll back if one is wrong, not all-at-once blind.
8. **Update any hardcoded org references in this repo's own config** — e.g. `config/copilot-review-repos.json`'s org-keyed arrays, `config/inbox-to-repo.json`'s repo values, any `REUSABLE_WORKFLOW_REF`-style constant in the propagate scripts themselves.

## Verify nothing silently broke

9. GitHub Actions has an **indexing lag** after a workflow file lands on the default branch — `workflow_dispatch` can 404 for over a minute even though the Contents API confirms the file exists. Wait and retry before concluding a newly added workflow is broken.
10. Don't trust a green checkmark alone post-transfer — actually re-run each major pipeline (build-zip, Copilot review, Crisp triage) end to end and check real output, not just job status. This transfer is exactly what surfaced the Crisp 401 investigation — see `debug-crisp-401-errors` skill — so budget time for at least one non-obvious follow-up issue.
