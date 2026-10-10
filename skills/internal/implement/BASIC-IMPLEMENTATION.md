# Basic Implementation

Use this for direct work, a Spec without attached tickets, or one ticket of a
larger Spec. Implement the Work target's scope and acceptance criteria.

Before editing, resolve the user-supplied review base or current `HEAD` to its
full commit SHA. Keep this review base for the implementation and its fixes.

Use `$tdd` where possible, at pre-agreed seams. Run focused tests, typechecking,
and linting for the changed scope as you work, following the repo's instructions.

Commit the task's changes before review, preserving unrelated checkout edits.
Run `$code-review <review base> <Work target>`, omitting the target when absent.
Invoke it directly from the implementation agent and give its reviewers the
absolute checkout path.

Resolve findings and verify completion using
[Review fixes](../../references/internal/REVIEW_FIXES.md).

Return the review base and final commit SHAs, a concise verification summary,
and any remaining integration work.
