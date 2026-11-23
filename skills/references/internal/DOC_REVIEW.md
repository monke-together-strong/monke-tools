# Documentation review

Have a subagent on the writer model (`mt models get writer`) review documentation, code comments, caller-facing text, and domain terminology across the full diff against the PR base, including pending edits and new files, using [documentation standards](../../internal/documentation-standards/SKILL.md). Run the review yourself under these rules when subagents are barred.

Before briefing, list the diff's added or changed doc blocks (doc comments, API descriptions, ADR bullets, and glossary entries) with word counts, largest first: run `bun <path>/doc-blocks.ts <base>` from the repository root, with the path of [doc-blocks.ts](../../internal/documentation-standards/scripts/doc-blocks.ts). Brief the reviewer to edit in place (overriding read-only review mode), start from that list, and reach a keep, cut, or correct decision for each claim in scope. Scope is every added or changed passage in the full diff against the PR base, plus each unchanged passage that describes code the diff changed. Text the diff adds to an ADR is in scope like any other passage. A later run before a push may cover only the new commits' passages, plus passages anywhere that describe code those commits changed. Omit limits on the reviewer's report length and severity filters, which let implementation narration and restated errors pass as style.

The reviewer leaves edits uncommitted and reports these items instead of editing them:

- Code behavior contradictions, such as a comment that disagrees with the code.
- Exported-symbol renames.
- `TODO` removals.
- Edits to decisions recorded on the PR base, or to their attribution.
- Items outside the diff.

Wait until the reviewer finishes before editing the checkout. Inspect its diff against the standards and revert any edit that breaks them. Then check the kept passages it lists, largest first, against the reader tests, and cut what fails them. Handle each reported item:

- Fix a code and documentation contradiction at its owner and add a test.
- Apply a rename across all callers and confirm typechecking passes.
- Remove a `TODO` only after verifying its work is complete.
- Rewrite a decision recorded on the PR base only when the code shows the decision changed.
- Fix an out-of-diff item only when it finishes work the diff started, such as a rename. Leave other out-of-diff items out of the PR and list them in your reply.

Done when every reviewer edit is kept or reverted, every listed kept passage is confirmed or cut, and every reported item has an outcome. In your final reply, list each finding and its outcome (including overrides), or state that there were none.
