# Documentation review

Have a subagent on the writer model (`mt models get writer`) review documentation, code comments, user-facing messages, and domain terminology across the full diff against the PR base, including pending edits and new files, using [documentation standards](../../internal/documentation-standards/SKILL.md). Run the review yourself under these rules when subagents are barred.

Brief the reviewer to cover the full diff, edit passages in place (overriding read-only review mode), and reach a keep, cut, or correct decision for every added or changed passage as it reads after the change. Omit word limits and severity filters, which let implementation narration and restated errors pass as style.

The reviewer leaves edits uncommitted and reports these items instead of editing them:

- Code behavior contradictions, such as a comment that disagrees with the code.
- Exported-symbol renames.
- `TODO` removals.
- Edits to recorded decisions or their attribution, such as ADRs.
- Items outside the diff.

Wait until the reviewer finishes before editing the checkout. Inspect its diff against the standards and revert any edit that breaks them. Handle each reported item:

- Fix a code and documentation contradiction at its owner and add a test.
- Apply a rename across all callers and confirm typechecking passes.
- Remove a `TODO` only after verifying its work is complete.
- Rewrite a recorded decision only when the code shows the decision changed.
- Fix an out-of-diff item only when it finishes work the diff started, such as a rename. Leave other out-of-diff items out of the PR and list them in your reply.

Done when every reviewer edit is kept or reverted and every reported item has an outcome. In your final reply, list each finding and its outcome (including overrides), or state that there were none.
