# Implement Closeout Gates

The verifier inspects evidence and runs `$code-review`; it does not edit source,
commit, or spawn another closeout verifier. The implementation thread owns fixes,
reruns, tracker closeout, and the final report.

Inputs: Work target (Spec, issue, plan, direct request, or `none`), fixed review
base SHA, candidate SHA, background references, and the Spec closeout list when
Spec orchestration was used. The Work target owns review and tracker closeout;
background references constrain the work without becoming additional targets.

## Candidate and evidence

At entry and immediately before and after review, require `HEAD^{commit}` to
match the candidate and `git status --porcelain` to be empty. Otherwise report
`FAIL`: the candidate does not represent all work under review.

Account for every Work target requirement, including acceptance criteria, testing
decisions and gates, STOP conditions, required artifacts, and scope boundaries.
Use one compact evidence list. Each requirement needs proof, a reason it is not
applicable, or an explicit acceptance of exclusion from scope. Reuse recorded
verification; red/green or before/after requirements need both sides traceable.
Record when there is no Work target or no Spec-specific testing requirement.
Missing evidence blocks review; add it to the Spec closeout list when orchestrating.

## Review

Run `$code-review <fixed point> <work target>`, omitting the target when absent
and reporting that Spec review may skip for lack of a source. Its review
subagents are authorized.

Classify all findings by impact:

- **Blocking:** missing or failing required evidence or checks; P0/P1 defects;
  production correctness, security, data integrity, concurrency, or recovery
  defects at any severity; meaningful production-code standards breaches.
- **Advisory:** P2/P3 maintainability findings, test-only style, naming, ordering,
  and judgement calls without production impact.

Report the fixed point, candidate, evidence, and classified findings. Keep one
deduplicated advisory list across attempts.

The verifier returns here; the implementation thread performs the remaining steps.

## Resolve and finish

For missing evidence or blockers, report `BLOCKED`. The implementation thread
fixes them, runs targeted verification, commits, records the new candidate, and
reruns this procedure against the original fixed point.

After blockers are resolved, fix advisory findings in one batch, verify, and
commit. This batch does not trigger another closeout review. Record the reviewed
candidate and final `HEAD`, confirming any difference contains only reported
advisory fixes. A new blocker or failing check returns to the blocking loop.
Require a clean checkout.

For orchestrated Specs, reconcile every deferred closeout item: fixed directly,
covered by a fixed review finding, or explicitly accepted out of scope with a
reason. For a tracker Work target, post the fixed point, reviewed and final SHAs,
evidence, review command, and finding dispositions on that target; required
tracker access remains a blocker. For other targets, post only when a comment
target was supplied.

Report `PASS` with the SHAs and evidence summary after these steps complete,
`BLOCKED` when implementation action or explicit acceptance is needed, or `FAIL`
when closeout cannot run.
