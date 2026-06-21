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

## Review gate

Once implementation and verification are done, run `/review` exactly as specified by the review skill.

This instruction is explicit authorization to spawn any sub-agents required by `/review`, including its parallel Standards and Spec reviewers.

Commit your work to the current branch.
