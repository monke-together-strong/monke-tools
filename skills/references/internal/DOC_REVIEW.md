# Documentation review

Have a subagent review documentation, code comments, user-facing messages, and
domain terminology in the full diff against the PR's base, including pending
edits and new files, using
[documentation standards](../../internal/documentation-standards/SKILL.md).
Use a Codex subagent when available. When your instructions bar subagents, run
the review yourself under these rules.

Every run covers the full diff, not only the latest commit. Brief it with the
standards' completion criterion: a keep, cut, or correct decision for every
passage the diff adds or changes, judged as the passage reads after the change.
Leave out word limits and severity filters; they let implementation narration
and restated error messages through as style.

The reviewer applies its cuts and corrections in place and leaves them
uncommitted. It reports these instead of applying them:

- a finding about code behavior, such as a comment that contradicts the code;
- a rename of an exported symbol;
- removal of a TODO;
- an edit to a recorded decision or its attribution, such as an ADR;
- anything outside the diff.

Edit the checkout only after the reviewer finishes. Then read its diff against
the standards and revert any edit that breaks them. Check each reported item,
then decide it:

- Fix a bug, where code contradicts its documented intent, and add a test.
- Apply a rename once the type check passes.
- Remove a TODO only once you have checked that its work is done.
- Rewrite a recorded decision only when the code shows it changed.
- Fix an item outside the diff when it finishes something the diff started,
  such as a rename. Leave any other one out of the PR and list it in your reply.

You are done when every edit in the diff is kept or reverted and every reported
item has an outcome. In your final reply, list each finding with its outcome,
including each proposal you overrode, or state that there were none.
