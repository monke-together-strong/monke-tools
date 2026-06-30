# Implement Closeout Gates

Use this procedure when an implementation thread delegates final verification.
This thread verifies only: it may inspect the PRD, run commands, collect
evidence, and run `/review`, but it must not create another closeout thread,
make source changes, or commit.

Inputs:

- Work reference
- Review fixed point
- PRD URL/path, or `none`
- Whether PRD orchestration was used
- PRD closeout list, when orchestration was used

If a gate finds missing evidence or a review finding that requires code changes,
report it to the implementation thread, wait for the fix, then rerun the
affected gate.

## PRD Testing Evidence Gate

Run this gate before the Review gate when `PRD` is not `none`. If `PRD` is
`none`, skip this gate.

Inspect the PRD's Testing Decisions and Testing Gate. Create a compact evidence
ledger that lists every PRD-specific testing evidence requirement. If the PRD
has no Testing Decisions or Testing Gate, record that no PRD-specific testing
evidence was required.

The gate is complete only when every ledger item has one final disposition:

- proved, with the command, test file, screenshot, review output, slice-thread
  result, or tracker comment that proves it
- not applicable, with the reason the PRD item no longer applies
- explicitly accepted as out of scope, with the reason recorded

If any ledger item is missing, the gate is blocked: report the evidence gap to
the implementation thread, wait for the fix, then rerun this gate before
`/review`.

For red/green or before/after requirements, proved means both sides are
traceable. A final green run alone is not enough.

If PRD orchestration was used, add any missing PRD testing evidence to the PRD
closeout list. At final closeout, missing evidence must be fixed before
`/review` runs or explicitly accepted as out of scope with the reason recorded.

## Review Gate

Run `/review` exactly as specified by the review skill.

For an orchestrated PRD, use:

```text
/review <final-review fixed point> <parent PRD URL>
```

This instruction is explicit authorization to spawn any sub-agents required by
`/review`, including its parallel Standards and Spec reviewers.

## PRD Closeout

Run this gate when `PRD` is not `none`. If `PRD` is `none`, skip this gate.

Post the final-review fixed point, testing evidence ledger, and review command
as a parent PRD comment. The PRD work is incomplete until the comment is posted
or tracker write access is reported blocked.

If PRD orchestration was used, reconcile the PRD closeout list against the final
review before posting. Add the deferred-finding dispositions to the parent PRD
comment. Every deferred finding must have one disposition:

- fixed in the accumulated branch
- covered by a final review finding that is then fixed
- explicitly accepted as out of scope with the reason recorded

## Final Report

Report `complete` only when every required gate completed. Otherwise report
`blocked` with the missing evidence, review findings, tracker access issue, or
question that prevents completion.
