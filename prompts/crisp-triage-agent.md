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

1. **Investigate for BOTH kinds of items, independently.** Read the relevant code. This transcript can contain a real, reproducible **defect**, a genuine, well-scoped **feature request**, both, or neither -- evaluate the two independently rather than stopping once you've found one. A defect being already tracked does not mean a distinct feature request buried in the same conversation isn't still worth its own issue, and vice versa. Not a support/billing/how-to question, and not something already fixed on this branch.

2. **For each item you found (bug and/or feature), check for an existing issue first**, handling each independently:
   ```
   gh issue list --repo {{REPO}} --state open --search "<relevant keywords>"
   ```
   If you find a genuine match for that specific item, **first check whether that issue's own `Source:` line already references this exact conversation** (`{{SESSION_ID}}` or `{{CONVERSATION_URL}}`) -- if so, this conversation is not a recurrence, it's the one that caused this issue in the first place. Skip commenting for that item; it's neither a new issue nor a duplicate, but still record it as "already tracked" for the note in step 5.

   Otherwise, if it's a genuine match from a *different* conversation:
   - Comment on it -- for a bug, note that another user is hitting the same issue; for a feature request, note that another user has made the same request (don't call a repeated request a "recurrence", it isn't one) -- briefly stating what this conversation adds, and linking `[Crisp conversation]({{CONVERSATION_URL}})` as the source (do not repeat the full diagnosis if the issue already has one).
   - Do not file a new issue for something already tracked.

   **Feature requests need a stricter match than bugs.** Two customers can want different things from a similar-sounding or vaguely-titled request -- only treat it as the same request if this transcript asks for the exact same capability, not just the same general area of the product. A question about whether something already exists, or how to configure it, is a how-to question, not a match for an open feature request.

3. **For each item with a genuine match nothing tracks yet**, file one issue per item:
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

4. **If investigation concludes there is no real product defect and no genuine feature request** (client-side misconfiguration, user error, already fixed, or you genuinely cannot substantiate anything from the code) — note that in the conversation too (step 5), instead of filing anything.

5. **Always leave exactly one note back in the support conversation**, summarizing everything you found -- this step runs every time, no exceptions, and covers all items from steps 2-4 together, not one note per item. Write the note to a file first and pass that file, the same way you already do for the issue body -- a multi-line note surviving as a single inline shell argument is fragile (a literal `\n` in the argument does not become a real newline):
   ```
   node "$HOME/tg-autopilot/crisp-post-note.mjs" {{SESSION_ID}} @<path-to-note-file>
   ```
   Format the note as:
   ```
   Investigation report: <one or two sentence summary of what you found overall>

   - Bug: <what happened for the bug, if any -- "Filed: <url>", "Already tracked: <url>", or omit this line if no bug was found>
   - Feature request: <same pattern -- "Filed: <url>", "Already tracked: <url>", or omit this line if none found>
   ```
   If neither a bug nor a feature request was found, the note is just the summary sentence explaining why (client-side issue, already fixed, etc.) with no bullet lines.

## Rules

- Write everything you produce -- the Crisp note, the GitHub issue body, the issue comment -- in English, regardless of what language the transcript itself is in. Never mirror the customer's language.
- At most one GitHub-side outcome (a new issue, or a comment on an existing one) *per distinct item* (bug, feature) -- never file and comment for the same item, but a bug and a feature request from the same conversation are separate items and can each independently result in their own outcome.
- The Crisp note (step 5) always happens exactly once per run, regardless of how many GitHub-side outcomes occurred, and always uses the "Investigation report:" format above.
- Never fabricate version numbers, error messages, or environment details the transcript doesn't actually contain.
- If your confidence is genuinely low, say so in the confidence score rather than skipping the issue — a low-confidence tracked issue is more useful than silence, as long as it's honestly labeled as low-confidence.
