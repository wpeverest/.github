---
name: onboard-copilot-review-repo
description: Onboard a repo to the auto-Copilot-review pipeline (request Copilot as a reviewer on PR open, and via a trigger-phrase comment).
---

# Onboard a repo to Copilot auto-review

Adds `.github/workflows/copilot-review-on-comment.yml` + `.caller.yml` to a repo so Copilot is requested as a PR reviewer automatically on open, and can also be triggered by a team member commenting the trigger phrase.

## Steps

1. Add the repo's `org/name` to the right array (`wpeverest` or `themegrill`) in `config/copilot-review-repos.json`.
2. Run `Propagate Copilot review on comment` (`workflow_dispatch`, this repo's Actions tab). It opens a PR on the target repo adding the caller workflow, and sets that repo's `BOT_TOKEN` (or `BOT_TOKEN_THEMEGRILL`) if missing.
3. Don't hand-copy `*.caller.yml` into a repo directly — that was the superseded Phase 1 approach. The propagate script is idempotent; re-running it after adding one new repo name doesn't touch repos already onboarded.
4. The `repositories` input on the propagation workflow controls which repos it actually touches even if more are listed in the config — useful for limiting a rollout to a couple of test repos first.

## Known platform quirks to expect, not debug from scratch

- **Copilot review requests are genuinely slow/flaky at the GitHub platform level.** `gh pr edit --add-reviewer @copilot` can take over a minute between "succeeding" and Copilot actually appearing as a reviewer, and can need a second attempt. This is not a bug in the workflow — don't add a quick pass/fail check; the existing poll-with-retry (up to ~3 minutes) in the workflow's "Request Copilot review" step is the right pattern to copy if you're adding this elsewhere.
- **The machine user (`tg-autopilot`) is API type `"User"`, not `"Bot"`.** Any code that checks `comment.user.type === 'Bot'` to detect the bot's own comments will never match. Match on `comment.user.login === 'tg-autopilot'` (or whatever login is in use) plus a stable body marker instead.
- **A bot's own comment must never be able to re-trigger its own comment-triggered workflow.** If this workflow ever posts a status/failure comment back, make sure that comment's text can't itself contain the trigger phrase — see `write-safe-bot-workflow` skill for the full reasoning and the concrete incident this is based on.

## Verification

Open two test PRs at once if verifying concurrency — confirmed to work correctly, but re-verify after any change to the request-review or trigger-comment logic. Check that Copilot actually shows up as a requested reviewer, not just that the workflow run itself went green.
