# ThemeGrill GitHub Bot — Phase 1 setup

Files here go into a new repo **`wpeverest/.github`**:

- `.github/workflows/pr-build-zip.yml` — the reusable workflow (the bot's logic)
- `.github/workflows/pr-build-zip.caller.yml` — template to copy into each consuming repo

Steps 1–4 below require account and cloud access, so they are yours to do.

## 1. Machine user account

Create a GitHub user `tg-autopilot` with its own mailbox and 2FA; store the
recovery codes in the team vault. A machine user (not a GitHub App) is what the
`pirate-bot` reference uses, and it keeps one identity across both orgs.

Invite it to `wpeverest` (and later `themegrill`/`Masteriyo`) with write access to target repos.

Generate a **fine-grained PAT**, scoped to the target repos:

| Permission | Level |
|---|---|
| Contents | Read |
| Pull requests | Read and write |
| Issues | Read and write |
| Metadata | Read |

Set it as the org secret **`BOT_TOKEN`**.

> The `comment-author: tg-autopilot` line in `pr-build-zip.yml` must match this
> login exactly. If you pick a different name, update it there.

## 2. Bucket

Create the artifact bucket. Cloudflare R2 is recommended over S3 — build ZIPs are
large and R2 charges no egress.

**Public read.** Do *not* rely on `--acl public-read`; the workflow deliberately
does not send an ACL. Modern S3 buckets ship with Object Ownership set to
"Bucket owner enforced", which disables ACLs outright, and R2 has no ACLs at all.
Grant public read once, at the bucket level:

- **R2** — enable public access (r2.dev subdomain, or attach a custom domain).
- **S3** — a bucket policy allowing `s3:GetObject` to `*` on `arn:aws:s3:::BUCKET/*`.

**Lifecycle rule: expire objects after 30 days.** Without it this bucket grows
forever. Keep the number in step with the `retention-days` input, which is only
the text shown in the PR comment.

Then set the org secrets `ARTIFACTS_KEY` and `ARTIFACTS_SECRET`. **Do not**
make the bucket name itself a secret — pass it as the plain `artifacts-bucket`
input in each caller workflow instead, and point `public-base-url` at whatever
domain fronts the bucket.

> A bucket name isn't sensitive, and treating it as one backfires: GitHub
> Actions masks any string matching *any* registered secret's value, wherever
> that string shows up. If the bucket name is a secret, it gets masked to
> `***` inside `public-base-url` too — even though that's a plain input —
> which breaks the download link in the PR comment. Learned this the hard way
> during Phase 1 testing; keep only the actual credentials (access key ID and
> secret access key) as secrets.

## 3. Cross-org constraint — decide this before rolling out

**A private reusable workflow cannot be called from a different organization.**
Access is limited to the same repository, the same org/user, or the same
enterprise account. So `Masteriyo/*` repos cannot call a private
`wpeverest/.github`. Options:

1. **Make `wpeverest/.github` public** (recommended). The workflow YAML holds no
   secrets — secrets stay per-org and are passed by the caller via
   `secrets: inherit`. One copy for both orgs.
2. If both orgs sit under one GitHub Enterprise account, internal visibility works.
3. Otherwise duplicate the workflow into a `Masteriyo/.github` — which reintroduces
   exactly the drift this design exists to avoid.

Note that `secrets: inherit` only passes secrets within the same org or enterprise.
Cross-org callers must pass each secret explicitly instead:

```yaml
secrets:
  BOT_TOKEN: ${{ secrets.BOT_TOKEN }}
  ARTIFACTS_KEY: ${{ secrets.ARTIFACTS_KEY }}
  ARTIFACTS_SECRET: ${{ secrets.ARTIFACTS_SECRET }}
```

## 4. Onboard a repo

Copy `pr-build-zip.caller.yml` to the repo as `.github/workflows/pr-build-zip.yml`
and set `build-command`, `zip-glob`, and the target `branches`. Reuse the repo's
existing release target (`gulp release`, `yarn dist`, ...) so packaging rules such
as `.distignore` stay owned by the repo rather than the bot.

## Verification

1. `gh api users/tg-autopilot` returns the account; `gh secret list --org wpeverest`
   lists `BOT_TOKEN` and the three bucket secrets.
2. Open a **draft** PR → no build. Mark ready → build runs, one comment appears
   authored by `tg-autopilot`.
3. **No-login download** (the whole point of not using GitHub artifacts) —
   with no credentials present:
   ```
   curl -sIL "<url>" | head -1     # expect 200
   ```
   Then confirm in a logged-out browser that it downloads, and that the ZIP
   installs via Plugins → Add New → Upload Plugin **without unzipping first**.
4. **Updated, not duplicated** — push a second commit: still exactly **one** bot
   comment, new SHA and timestamp. Push a third immediately: the earlier run is
   cancelled by the concurrency group.
5. Confirm the lifecycle rule (`aws s3api get-bucket-lifecycle-configuration`, or
   the R2 equivalent).
6. Onboard a second repo with a different toolchain to prove the input contract.

## Design notes

Two failure modes this workflow avoids on purpose:

- **Identifying its own comment by `comment.user.type == 'Bot'`.** A machine user
  is type `User`, so that test never matches and every push posts a *new* comment.
  We match on author login + the `<!-- tg-autopilot: pr-build-zip -->` marker.
- **Gating builds on a magic commit-message token** such as `#build`. It relies on
  people remembering it and gives reviewers nothing by default. We gate on draft
  status instead.
