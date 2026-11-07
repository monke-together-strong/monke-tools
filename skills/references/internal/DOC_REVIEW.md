# Documentation review

Have a subagent review documentation, code comments, user-facing messages, and
domain terminology in the full diff against the PR's base, including pending
edits and new files, using
[documentation standards](../../internal/documentation-standards/SKILL.md).
Every run covers the full diff, not only the latest commit. Brief it with the
standards' completion criterion: a keep, cut, or correct decision for every
passage the diff adds or changes, judged as the passage reads after the change.
Leave out word limits and severity filters; they let implementation narration
and restated error messages through as style.

Review its decisions and code findings, and check each proposed edit's new text
against the same standards before applying it. When your instructions bar
subagents, apply the standards yourself. Either way, list each finding, or state
that there were none, in your final reply.
