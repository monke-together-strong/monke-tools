# Review fixes

Use the caller's task scope, recorded review base, and required reviews.

## Finding criteria

Classify confirmed findings by impact:

- **Blocking:** missing task requirements; missing or failing required evidence
  or checks; P0/P1 defects; production correctness, security, data integrity,
  concurrency, or recovery defects at any severity; meaningful production-code
  standards breaches.
- **Advisory:** P2/P3 maintainability findings, test-only style, naming, ordering,
  and judgment calls without production impact.

Keep one deduplicated advisory list across attempts.

## Resolve and finish

1. Verify findings against the task and actual code or observable behavior.
   Explain dismissed findings and record deferred work with its owner.
2. Fix all validated findings within scope, blocking and advisory, in one batch.
   Run the affected checks and commit the fixes, preserving unrelated checkout
   edits.
3. If the batch fixed any blockers, rerun the required reviews on the updated
   candidate and repeat this loop. Each code review compares the entire current
   change set against the same original baseline.
4. If the batch fixed only advisory findings, finish without another review
   round. A new blocker or failing required check returns to this loop.

Completion requires no unresolved blockers, committed task changes, passing
required checks, and completed required reviews. Report the reviewed candidate
and final `HEAD`; any changes after the last review must contain only reported
advisory fixes.
