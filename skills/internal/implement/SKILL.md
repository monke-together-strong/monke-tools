---
name: implement
description: Only use when explicitly mentioned with /implement or $implement.
---

The user's primary PRD, issue, plan, or direct request is the Work target.
Implement it.

If the work is a PRD, run the PRD gate before branch creation, code exploration, or edits.

## PRD gate

A PRD is any issue or doc titled or labeled PRD, or containing PRD sections such as Problem Statement, User Stories, Implementation Decisions, Testing Decisions, or Out of Scope.

The PRD gate stays on the PRD's native tracker. Do not search other trackers or connectors during the gate. Open an external tracker link only when the PRD explicitly names it as an implementation slice; related background links are not slice sources.

The PRD gate is complete only after checking explicit native-tracker slice evidence:

- implementation-slice links or task-list items in the PRD body
- issue comments that explicitly link implementation slices
- linked-issue relationships or timeline cross-references available through the native tracker

Use the native tracker's relationship or timeline endpoint when the ordinary
issue view omits those fields. Treat that view as incomplete, not as evidence
that the tracker lacks relationship data.

Do not inspect milestones, project items, labels, or broad tracker search
results. Only when the native tracker has no relationship or timeline surface,
run exact searches for both the tracker-local PRD issue key or ID and its
canonical URL. Inspect results only for explicit implementation-slice
references.

A negative gate is valid only when the relationship or timeline source was
queried, or its absence was established, and both exact reference forms found
no slices. Record the sources, endpoints, and reference forms checked.

Exit:

- If one or more implementation slices are found, read the sibling file [PRD-ORCHESTRATION.md](./PRD-ORCHESTRATION.md) and orchestrate the slices.
- If no slices are found, state exactly which sources were checked, then implement the PRD directly.

## Direct implementation

For every run not routed to PRD orchestration, resolve the user-supplied review
base or current `HEAD` to its full commit SHA before implementation starts and
record it as the final-review fixed point. Keep it unchanged through every
closeout rerun.

Use `$tdd` where possible, at pre-agreed seams.

Run targeted typechecking, linting, and single test files regularly.

## Closeout

After implementation and verification, stage every checkout change, including
untracked paths, and commit them; if already clean, use `HEAD`. Record the full
`HEAD` SHA as the review candidate, then run a closeout verifier subagent in the
same checkout with this prompt:

```text
Run the implement closeout procedure in this checkout.

Procedure: skills/internal/implement/CLOSEOUT-GATES.md
Work target: <Work target or "none">
Review fixed point: <recorded fixed point>
Review candidate: <recorded candidate>
Background context: <parent PRD and supporting docs or "none">
Orchestrated PRD: <yes/no>

Read the procedure file and follow it exactly. Report missing evidence, review
findings, and the final gate result back to the implementation thread.
```

If closeout blocks, supply missing evidence, obtain explicit acceptance, or fix
the code. If the checkout changes, rerun targeted verification, commit every
checkout change, update the review candidate, then rerun the Review gate and
affected evidence gates against the same fixed point. Finish only after closeout passes with
a clean checkout.
