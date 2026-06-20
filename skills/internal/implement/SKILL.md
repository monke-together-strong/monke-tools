---
name: implement
description: "Implement a piece of work based on a PRD or set of issues."
disable-model-invocation: true
---

Implement the work described by the user in the PRD or issues.

If the work is described by a PRD, first determine whether it has implementation issues attached. If it does, use [PRD-ORCHESTRATION.md](PRD-ORCHESTRATION.md). If it does not, implement the PRD directly in a new thread.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /review to review the work.

Commit your work to the current branch.
