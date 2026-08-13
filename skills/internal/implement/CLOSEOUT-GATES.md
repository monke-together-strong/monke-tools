# Implement Closeout Gates

Use this procedure when an implementation thread delegates final verification to
a closeout verifier subagent. The verifier may inspect the work target, run
commands, collect evidence, and run `/code-review`, but it must not spawn
another verifier, make source changes, or commit.

Inputs:

- Work target: primary PRD, issue, plan, summary of a direct request, or `none`
- Review fixed point
- Review candidate: full commit SHA expected at `HEAD`
- Background context: parent PRD, supporting docs, or `none`
- Whether PRD orchestration was used
- PRD closeout list, when orchestration was used

## Candidate Gate

At entry, immediately before and after the Review gate, and before the Final
Report, require `git rev-parse HEAD^{commit}` to equal the Review candidate. A
mismatch is `FAIL`: the recorded candidate did not pass closeout.

The work target is the single closeout target. Background context is read-only
intent and constraint material; it never changes the review target or comment
target. If the work target is a tracker issue, including a PRD issue, post
closeout evidence on that same issue. If the work target is a subissue of a PRD,
the parent PRD remains background unless this is an orchestrated PRD closeout.

If a gate blocks, report it to the implementation thread.

## Evidence Ledger

Create a compact ledger for each evidence gate. Every item needs one final
disposition:

- proved, with the command, test file, screenshot, review output, artifact,
  tracker comment, or implementation-thread evidence
- not applicable, with the reason
- accepted out of scope, with the reason

Implementation-thread evidence is enough only when it is auditably specific. If
an item is missing, block before `/code-review`. For red/green or before/after
requirements, both sides must be traceable.

## Work Evidence Gate

Run this gate for every closeout, before the Review gate.

Inspect the Work target for acceptance criteria, testing instructions,
Definition of Done items, STOP conditions, required commands, required
artifacts, and out-of-scope boundaries. Ledger those requirements. If the Work
target is `none`, record that no work-target evidence was available.

## PRD Testing Evidence Gate

Run this additional gate when the Work target is itself a PRD.

Inspect the Work target's Testing Decisions and Testing Gate. Ledger every
PRD-specific testing evidence requirement. If neither section exists, record
that no PRD-specific testing evidence was required.

If PRD orchestration was used, add missing PRD testing evidence to the PRD
closeout list.

## Review Gate

Run `/code-review` exactly as specified by the code-review skill.

- Work target present: `/code-review <review fixed point> <work target>`
- Work target `none`: `/code-review <review fixed point>`; report that Spec may
  skip for lack of a source

This authorizes all `/code-review` sub-agents.

## Tracker Closeout

Run this gate when the Work target is a tracker issue. If the Work target is not
a tracker issue, skip this gate unless the implementation thread gave an
explicit comment target.

Post the review fixed point, review candidate, testing evidence ledger, and
review command as a Work target comment. The work is incomplete until the
comment is posted or tracker write access is reported blocked.

If PRD orchestration was used, reconcile the PRD closeout list against the final
review before posting. Add the deferred-finding dispositions to the Work target
comment. Every deferred finding must have one disposition:

- fixed in the accumulated branch
- covered by a final review finding that is then fixed
- explicitly accepted as out of scope with the reason recorded

## Final Report

Include the Review fixed point and Review candidate in the report. Report `PASS`
when every required gate completed, `BLOCKED` when implementation action or
explicit acceptance is needed, and `FAIL` when closeout cannot run.
