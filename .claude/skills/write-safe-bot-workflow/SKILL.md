---
name: write-safe-bot-workflow
description: Checklist for writing or editing any GitHub Actions workflow triggered by comments/PR-events that also posts its own comments back, to avoid identity-detection and self-trigger-loop bugs.
---

# Writing a safe comment-triggered bot workflow

Two traps this system has hit for real — check both any time a workflow is triggered by `issue_comment`/`pull_request_review_comment` and might also post its own comment back.

## 1. The machine user's API type is `"User"`, not `"Bot"`

`tg-autopilot` runs as a real machine-user account, not a GitHub App. Code that checks `comment.user.type === 'Bot'` to identify the bot's own comments will **never match**. Always match on `comment.user.login === 'tg-autopilot'` (or whatever login is configured) — optionally combined with a stable marker string in the comment body if you need to distinguish this bot's *specific* status comments from other things it might post.

## 2. A bot's own comment must never be able to re-trigger its own workflow

If a comment-triggered workflow can post a comment of its own (a status update, a failure notice, a "try again" message), that comment's text must never be able to match the same trigger phrase the workflow listens for — otherwise it loops forever.

**Confirmed for real** on `copilot-review-on-comment.yml`: an early version's failure-notice comment read "try commenting `@tg-autopilot review` again" — which contains the trigger phrase itself. Posting that notice re-triggered the workflow, which could fail again, post the notice again, indefinitely. Caught after ~20 runs on one PR.

**The fix that actually matters**: exclude comments authored by the bot's own login from the trigger condition entirely (`github.event.comment.user.login != 'tg-autopilot'` in the `if:`), not just rewording the failure message — any future message text could reintroduce the same trap by accident, but excluding the bot's own login closes it structurally.

## When adding a new trigger phrase or status comment

Before merging, ask: if this workflow posts this exact text back as a comment, and comments from this bot aren't excluded from the trigger, does anything re-fire? If yes, either exclude the bot's own comments from the trigger (preferred) or guarantee the posted text can never contain the trigger phrase (fragile, don't rely on this alone).
