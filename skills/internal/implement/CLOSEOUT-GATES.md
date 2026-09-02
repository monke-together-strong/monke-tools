# Implement Closeout Gates

Use this procedure when an implementation thread delegates final verification
to a closeout verifier subagent. The verifier may inspect the Work target, run
commands, collect evidence, and run `$code-review`, but it must not spawn
another verifier, change source, or commit.

The verifier runs through the Review Gate and reports its result. The
implementation thread owns the loop, tracker closeout, and final report.

Inputs:

- Work target: primary Spec, issue, plan, summary of a direct request, or `none`
- Review fixed point
- Review candidate: full commit SHA expected at `HEAD`
- Background context: parent Spec, supporting docs, or `none`
- Whether Spec orchestration was used
- Spec closeout list, when orchestration was used

## Candidate Gate

At entry and immediately before and after the Review gate, require
`git rev-parse HEAD^{commit}` to equal the Review candidate. A mismatch is
`FAIL`: the recorded candidate did not pass review.

The Work target is the single closeout target. Background context is read-only
intent and constraint material; it never changes the review or comment target.
A parent Spec remains background for a subissue unless this is an orchestrated
Spec closeout.

## Evidence Ledger

Create a compact ledger for each evidence gate. Every item needs one final
disposition:

- proved, with the command, test file, screenshot, review output, artifact,
  tracker comment, or auditably specific implementation-thread evidence
- not applicable, with the reason
- accepted out of scope, with the reason

Missing evidence blocks before `$code-review`. For red/green or before/after
requirements, both sides must be traceable.

## Work Evidence Gate

Inspect the Work target for acceptance criteria, testing instructions,
Definition of Done items, STOP conditions, required commands and artifacts, and
out-of-scope boundaries. Ledger each requirement. If the Work target is `none`,
record that no work-target evidence was available.

## Spec Testing Evidence Gate

When the Work target is a Spec, ledger every requirement in its Testing
Decisions and Testing Gate. If neither exists, record that no Spec-specific
testing evidence was required. During Spec orchestration, add missing evidence
to the Spec closeout list.

## Review Gate

Run `$code-review` as specified by the code-review skill:

- Work target present: `$code-review <review fixed point> <work target>`
- Work target `none`: `$code-review <review fixed point>`; report that Spec may
  skip for lack of a source

This authorizes all `$code-review` sub-agents.

Classify every finding:

- **Blocking:** missing or failing required evidence; failing checks; P0/P1
  defects in Spec compliance, production behavior, security, data integrity,
  concurrency, or recovery; and meaningful production-code standards breaches
- **Advisory:** P2/P3 maintainability findings, test-only style, ordering,
  naming, and judgement-call smells or duplication without production impact

Impact overrides the original label: production correctness, security,
data-integrity, concurrency, and recovery defects are blocking.

## Loop and finish

Report the fixed point, candidate, evidence ledger, and all classified findings.
Carry one deduplicated advisory list across review attempts.

- If evidence or blocking findings remain, report `BLOCKED`. The implementation
  thread resolves the blockers, runs targeted verification, commits all changes,
  records the new candidate, and reruns every closeout gate against the original
  fixed point. Continue while reviews find blockers.
- When no blockers remain, the implementation thread fixes all advisory
  findings in one batch, runs targeted verification, and commits. This batch
  does not trigger another closeout review. Record both the reviewed candidate
  and final `HEAD`; if they differ, confirm their diff contains only the
  reported advisory fixes.

Require a clean checkout. Discovery of a blocker or a failing check during the
advisory batch returns the work to the blocking loop.

## Tracker Closeout

For a tracker Work target, post the fixed point, reviewed and final candidates,
evidence, review command, and finding dispositions on that target. Skip this
for other Work targets unless the implementation thread supplied a comment
target. The work remains incomplete if required tracker access is blocked.

For Spec orchestration, reconcile the Spec closeout list first. Every deferred
finding must be fixed, covered by a review finding that was fixed, or explicitly
accepted out of scope with the reason recorded.

## Final Report

Report `PASS` with the fixed point, reviewed candidate, final candidate, and
ledger summaries when every gate and finalization step completed. Report
`BLOCKED` when implementation action or explicit acceptance is needed, and
`FAIL` when closeout cannot run.
