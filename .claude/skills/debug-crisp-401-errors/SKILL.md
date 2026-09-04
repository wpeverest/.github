---
name: debug-crisp-401-errors
description: Systematically diagnose a Crisp API 401/invalid_session (or other auth-looking) error in crisp-triage, without jumping to conclusions.
---

# Debug a Crisp API auth error

`scripts/crisp-client.mjs`'s `crispFetch` already retries transient `401 invalid_session` and `429` responses with backoff (see its own comment for exactly what's confirmed vs. still unexplained about the 401 case). If retries aren't enough and you're actually root-causing a persistent failure, work through these in order — each one was tried for real and either confirmed or ruled out during the original investigation:

## Elimination checklist

1. **Bad/stale credentials?** Test the exact same `identifier`/`key`/`websiteId` standalone, outside the real pipeline, via a disposable diagnostic script (see below). If the standalone call succeeds every time with the same creds that fail inside the real run, credentials are not the cause.
2. **Malformed cursor/date value?** Dump the exact value being sent (`filter_date_start`, etc.) byte-for-byte (e.g. `xxd`) — a hidden control character or wrong timezone offset is easy to miss by eye.
3. **Daily quota exceeded?** Check Crisp's own dashboard for that workspace, not just assumptions from request-count math — Website Tokens are capped at 10,000 requests/day.
4. **Concurrent-session conflict?** Check whether other requests against the same account were in flight at the failure's exact timestamp. An isolated, no-concurrent-traffic failure rules this out.
5. **Page-number-specific?** Confirm whether it fails on page 1 (the very first request) or only deeper pages — a page-1 failure with no prior requests that run rules out any kind of running-session-state theory.
6. **Wrong value in the org secret/variable itself?** Compare the *full, untruncated* stored value against Crisp's own dashboard for that exact workspace — a copy-paste mistake during any credential-recreation step (e.g. after an org transfer) can put a KEY's value into the WEBSITE_ID field or similar. Note: GitHub masks a variable's plain-text display if its value happens to match *any* registered secret's value anywhere — this is a signal worth investigating but is not proof of a mismatch on its own; it can also be a harmless value collision.
7. **Genuinely just token health.** If everything above is ruled out and the failure persists on one specific account, regenerate a fresh Website Token for that workspace (Settings → Workspace Settings → Advanced configuration → API Token → Generate Token) and update its `IDENTIFIER`/`KEY` secrets. This is the most direct way to rule out any credential-side corruption that can never be inspected directly (secret values are never readable after being set).

## Building a disposable diagnostic workflow

- New `workflow_dispatch` files need to land on the default branch before they can be dispatched at all — expect an indexing-lag delay (over a minute) even after the Contents API confirms the file exists.
- Delete the diagnostic script/workflow once you're done — confirm via a branch-not-found check that nothing stray was left behind, especially if a push ever times out mid-command (which can leave local commits that never actually reached the remote).
- Test the *exact* failing parameter combination standalone, not a simplified version — a call that "should be equivalent" isn't proof if the real failure is sensitive to something you simplified away.

## What "safe either way" means for the retry mitigation

Retrying on 401 can only ever recover a real transient flake or burn a few retries before surfacing the same error anyway — it can never silently mask a genuinely invalid, permanently-broken token, since that would just keep failing through every retry too. Treat retry as a legitimate mitigation to ship even when the root cause stays unresolved, but say so plainly rather than claiming it as a fix — see `crisp-client.mjs`'s own comment for how this was framed at the time.
