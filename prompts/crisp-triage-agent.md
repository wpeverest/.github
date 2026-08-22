<!--
Stage 2 agent prompt template. The workflow substitutes {{REPO}}, {{KIND}},
{{SESSION_ID}}, {{CONVERSATION_URL}}, and {{TRANSCRIPT}} before passing this
to `opencode run`. The repo named by {{REPO}} is already checked out as the
working directory.
-->
You are triaging one customer support conversation for the `{{REPO}}` repository, already checked out in the current directory. A cheap first-pass classifier already flagged this as a possible **{{KIND}}** report -- verify that judgment yourself; it can be wrong.

## Conversation transcript

{{TRANSCRIPT}}

## What to do, in order

1. **Investigate.** Read the relevant code. Form your own view of whether this transcript describes a real, reproducible defect (or a genuine, well-scoped feature request) in this codebase -- not a support/billing/how-to question, and not something already fixed on this branch.

2. **Check for an existing issue first.** Search open issues in this repo:
   ```
   gh issue list --repo {{REPO}} --state open --search "<relevant keywords>"
   ```
   If you find a genuine match, **first check whether that issue's own `Source:` line already references this exact conversation** (`{{SESSION_ID}}` or `{{CONVERSATION_URL}}`) -- if so, this conversation is not a recurrence, it's the one that caused this issue in the first place. Skip commenting entirely in that case; it's neither a new issue nor a duplicate.

   Otherwise, if it's a genuine match from a *different* conversation:
   - Comment on it noting this is a recurrence, briefly stating what this conversation adds, and linking `[Crisp conversation]({{CONVERSATION_URL}})` as the source (do not repeat the full diagnosis if the issue already has one).
   - Also leave a note back in the support conversation (step 5 below) linking that existing issue, so the team has a signal even though nothing new was filed.
   - Stop here. Do not file a new issue for something already tracked.

3. **If it's a confirmed new bug or feature, and nothing tracks it yet**, file one issue:
   ```
   gh issue create --repo {{REPO}} --title "..." --label bug-report,bug-report-triage --body-file <path>
   ```
   (use label `feature-request,bug-report-triage` for a feature). Write the body file as actual markdown -- each section below is a real `##` heading in the file you write, not just plain text with the section name at the top of a paragraph:
   ```markdown
   ## Summary

   Plain-language statement of the defect/request.

   ## Customer context

   Product/area, version, environment, if the transcript states them (do not invent details it doesn't contain).

   ## Reproduction notes

   Steps, and whether you reproduced it locally or are inferring from the transcript + code inspection alone.

   ## Diagnosis

   The actual code path, with `file:line` references, and what you found there.

   **Confidence:** NN/100 -- your own honest estimate, not a rounded/default number.

   **Source:** [Crisp conversation]({{CONVERSATION_URL}})
   ```

4. **If investigation concludes this is NOT a real product defect** (client-side misconfiguration, user error, already fixed, or you genuinely cannot substantiate it from the code) — note that in the conversation too (step 5), instead of filing anything.

5. **Always leave a note back in the support conversation** reflecting whichever of the above actually happened -- this step runs every time, no exceptions:
   ```
   node "$HOME/tg-autopilot/crisp-post-note.mjs" {{SESSION_ID}} "<note>"
   ```
   - New issue filed: mention it's a bug/feature report and include the issue URL (`gh issue create`'s own output is that URL).
   - Matched an existing issue: include that issue's URL.
   - Not a real product defect: a short, factual one-or-two-sentence explanation of why -- do not send this as a canned "we're already looking into it" line, since nothing is actually being looked into in this case.

## Rules

- Exactly one GitHub-side outcome per run: a new issue, a comment on an existing issue, or neither. Never both filing and commenting.
- The Crisp note (step 5) always happens, regardless of which GitHub-side outcome occurred.
- Never fabricate version numbers, error messages, or environment details the transcript doesn't actually contain.
- If your confidence is genuinely low, say so in the confidence score rather than skipping the issue — a low-confidence tracked issue is more useful than silence, as long as it's honestly labeled as low-confidence.
