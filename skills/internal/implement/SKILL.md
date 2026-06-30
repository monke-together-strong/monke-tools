---
name: implement
description: "Implement a piece of work based on a PRD or set of issues."
disable-model-invocation: true
---

Implement the work described by the user in the PRD or issues.

If the work is a PRD, run the PRD gate before branch creation, code exploration, or edits.

## PRD gate

A PRD is any issue or doc titled or labeled PRD, or containing PRD sections such as Problem Statement, User Stories, Implementation Decisions, Testing Decisions, or Out of Scope.

The PRD gate stays on the PRD's native tracker. Do not search other trackers or connectors during the gate. Open an external tracker link only when the PRD explicitly names it as an implementation slice; related background links are not slice sources.

The PRD gate is complete only after checking explicit native-tracker slice evidence:

- implementation-slice links or task-list items in the PRD body
- issue comments that explicitly link implementation slices
- linked-issue relationships or timeline cross-references available through the native tracker

Do not inspect milestones, project items, labels, or broad tracker search results. If the native tracker cannot expose linked issues or timeline cross-references directly, use one exact search for the PRD issue id or URL.

Exit:

- If one or more implementation slices are found, read the sibling file [PRD-ORCHESTRATION.md](./PRD-ORCHESTRATION.md) and orchestrate the slices.
- If no slices are found, state exactly which sources were checked, then implement the PRD directly.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

## Closeout gates

After implementation and verification are done, create a separate closeout
thread in the same checkout to run these gates. The implementation thread owns
fixes and the final commit; do not commit until the closeout thread reports that
all gates are complete.

The closeout thread may inspect the PRD, run commands, collect evidence, and
run `/review`. It must not create another closeout thread, make source changes,
or commit. If a gate finds missing evidence or a review finding that requires
code changes, report it back to the implementation thread, wait for the fix,
then rerun the affected gate.

Use this closeout-thread prompt:

```text
/implement closeout gates for <work reference>

Review fixed point: <fixed point or "ask if needed">
PRD: <parent PRD URL/path or "none">
Orchestrated PRD: <yes/no>

Run only closeout gates in this checkout. Do not run implementation setup, run
the PRD gate, create another closeout thread, make source changes, or commit.
Report missing evidence, review findings, and the final gate result back to the
implementation thread.
```

### PRD testing evidence gate

If the work is a PRD, run this gate before the Review gate. If the work is not
a PRD, skip this gate.

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

### Review gate

Run `/review` exactly as specified by the review skill.

For an orchestrated PRD, use
`/review <final-review fixed point> <parent PRD URL>`.

This instruction is explicit authorization to spawn any sub-agents required by `/review`, including its parallel Standards and Spec reviewers.

### PRD closeout

For PRD, post the final-review fixed point, testing evidence ledger, and review
command as a parent PRD comment. The PRD work is incomplete until the comment is
posted or tracker write access is reported blocked.

If PRD orchestration was used, reconcile the PRD closeout list against the final
review before posting. Add the deferred-finding dispositions to the parent PRD
comment. Every deferred finding must have one disposition:

- fixed in the accumulated branch
- covered by a final review finding that is then fixed
- explicitly accepted as out of scope with the reason recorded

Commit your work to the current branch.
