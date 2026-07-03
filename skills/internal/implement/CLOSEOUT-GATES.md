# Implement Closeout Gates

Use this procedure when an implementation thread delegates final verification to
a closeout verifier subagent. The verifier may inspect the PRD, run commands,
collect evidence, and run `/code-review`, but it must not spawn another verifier,
make source changes, or commit.

Inputs:

- Work reference: PRD, issue, plan, summary of a direct request, or `none`
- Review fixed point
- PRD URL/path, or `none`
- Whether PRD orchestration was used
- PRD closeout list, when orchestration was used

If a gate blocks, report it to the implementation thread. After the fix or
explicit acceptance, rerun the affected gate.

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

Inspect the Work reference for acceptance criteria, testing instructions,
Definition of Done items, STOP conditions, required commands, required
artifacts, and out-of-scope boundaries. Ledger those requirements. If the Work
reference is `none`, record that no work-reference evidence was available.

## PRD Testing Evidence Gate

Run this additional gate when `PRD` is not `none`.

Inspect the PRD's Testing Decisions and Testing Gate. Ledger every PRD-specific
testing evidence requirement. If neither section exists, record that no
PRD-specific testing evidence was required.

If PRD orchestration was used, add missing PRD testing evidence to the PRD
closeout list.

## Review Gate

Run `/code-review` exactly as specified by the code-review skill.

- Orchestrated PRD: `/code-review <final-review fixed point> <parent PRD URL>`
- Non-orchestrated PRD: `/code-review <review fixed point> <PRD URL/path>`
- Non-PRD work reference: `/code-review <review fixed point> <work reference>`
- Work reference `none`: `/code-review <review fixed point>`; report that Spec may
  skip for lack of a source

This authorizes all `/code-review` sub-agents.

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

Report `PASS` when every required gate completed, `BLOCKED` when implementation
action or explicit acceptance is needed, and `FAIL` when closeout cannot run.
