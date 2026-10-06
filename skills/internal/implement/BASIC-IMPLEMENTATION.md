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
absolute checkout path and repo instructions.

Verify findings against the code and task. Fix confirmed in-scope findings in
one batch, run the affected checks, and commit the fixes. Explain dismissed
findings and record deferred cross-ticket work.

Confirmed production defects, missing task requirements, and failing required
checks block completion. After blocking fixes, rerun `$code-review` with the
same review base and Work target, carrying prior findings forward.
Repeat until blockers are resolved. Completion requires committed task changes,
passing required checks, and completed independent review.

Return the review base and final commit SHAs, a concise verification summary,
and any remaining integration work.
