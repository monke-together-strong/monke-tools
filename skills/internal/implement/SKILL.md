---
name: implement
description: Only use when explicitly mentioned with /implement or $implement.
---

The user's primary Spec, issue, plan, or direct request is the Work target.
Implement it.

If the work is a Spec, run the Spec gate before branch creation, code
exploration, or edits.

When assigned a checkout, read its repo instructions, use absolute file paths,
and anchor every command to it. Confirm its root and branch before editing.

## Spec gate

A Spec is any issue or document produced by `$to-spec`, presented as an
implementation specification, or containing Spec sections such as Problem
Statement, User Stories, Implementation Decisions, Testing Decisions, or Out
of Scope.

The Spec gate stays on the Spec's native tracker. Do not search other trackers
or connectors during the gate. Open an external tracker link only when the Spec
explicitly names it as an implementation slice; related background links are
not slice sources.

The Spec gate is complete only after checking explicit native-tracker slice
evidence:

- implementation-slice links or task-list items in the Spec body
- issue comments that explicitly link implementation slices
- linked-issue relationships or timeline cross-references available through the native tracker

Use the native tracker's relationship or timeline endpoint when the ordinary
issue view omits those fields. Treat that view as incomplete, not as evidence
that the tracker lacks relationship data.

Do not inspect milestones, project items, labels, or broad tracker search
results. Only when the native tracker has no relationship or timeline surface,
run exact searches for both the tracker-local Spec issue key or ID and its
canonical URL. Inspect results only for explicit implementation-slice
references.

A negative gate is valid only when the relationship or timeline source was
queried, or its absence was established, and both exact reference forms found
no slices. Record the sources, endpoints, and reference forms checked.

Exit:

- If one or more implementation slices are found, read
  [SPEC-ORCHESTRATION.md](./SPEC-ORCHESTRATION.md) and orchestrate the slices.
- If no slices are found, state exactly which sources were checked, then
  implement the Spec directly.

## Direct implementation

For every run not routed to Spec orchestration, resolve the user-supplied review
base or current `HEAD` to its full commit SHA before implementation starts and
record it as the final-review fixed point. Keep it unchanged through every
closeout rerun.

Use `$tdd` where possible, at pre-agreed seams.

Run targeted typechecking, linting, and single test files regularly.

## Closeout

After implementation and verification, stage every checkout change, including
untracked paths, and commit them; if already clean, use `HEAD`. Record the full
`HEAD` SHA as the review candidate, then run a closeout verifier subagent in the
same checkout with this prompt. Resolve the procedure path from this installed
skill, not from the implementation checkout.

```text
Run the implement closeout procedure in this checkout.

Checkout: <absolute checkout path>
Read this checkout's repo instructions, use absolute file paths, and anchor
every command to it. Pass these checkout instructions to your reviewers.
Procedure: <absolute path to this skill's CLOSEOUT-GATES.md>
Work target: <Work target or "none">
Review fixed point: <recorded fixed point>
Review candidate: <recorded candidate>
Background context: <parent Spec and supporting docs or "none">
Orchestrated Spec: <yes/no>
Spec closeout list: <deferred items or "none">

Read the procedure file and follow it exactly. Report missing evidence,
findings, and the review result back to the implementation agent.
```

Wait through native notifications or the host's wait tool; resume incomplete
work or report its blocker. Follow `CLOSEOUT-GATES.md` through final `PASS` with
a clean checkout.
