# Documentation review

Have a subagent on the writer model (`mt models get writer`) review
documentation, code comments, user-facing messages, and domain terminology in
the full diff against the PR's base, including pending edits and new files,
using [documentation standards](../../internal/documentation-standards/SKILL.md).
When your instructions bar subagents, run the review yourself under these rules.

Every run covers the full diff, not only the latest commit. Brief the reviewer
to edit passages in place (overriding documentation-standards's read-only review
default) and reach a keep, cut, or correct decision for every added or changed
passage as it reads after the change. Leave out word limits and severity
filters. They let implementation narration and restated error messages through
as style.

The reviewer applies its cuts and corrections in place and leaves them
uncommitted. It reports these instead of applying them:

- A finding about code behavior, such as a comment that contradicts the code.
- A rename of an exported symbol.
- Removal of a TODO.
- An edit to a recorded decision or its attribution, such as an ADR.
- Anything outside the diff.

Edit the checkout only after the reviewer finishes. Then read its diff against
the standards and revert any edit that breaks them. Check each reported item,
then handle it:

- Fix a bug, where code contradicts its documented intent, and add a test.
- Apply a rename across all callers and confirm the typecheck passes.
- Remove a TODO only once you have checked that its work is done.
- Rewrite a recorded decision only when the code shows the decision changed.
- Fix an item outside the diff when it finishes something the diff started,
  such as a rename. Leave other out-of-diff items out of the PR and list them
  in your reply.

You are done when every edit in the diff is kept or reverted and every reported
item has an outcome. In your final reply, list each finding with its outcome,
including each proposal you overrode, or state that there were none.
