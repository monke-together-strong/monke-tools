---
id: TASK-9
title: Use Codex goal for mt work implementer context
status: To Do
assignee: []
created_date: '2026-05-18 00:20'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`mt work` already has long-running, multi-step workflows: cleanup, implementer, reviewer, and PRD issue loops. The implementer phase currently receives the task or plan text, but it does not establish or reuse a Codex goal for the session.

Add goal usage to the workflow so the implementer has an explicit objective that can survive multi-step execution and make progress tracking clearer. The first practical slice should bias toward the implementer using a goal, because that is the phase responsible for doing the work. The design should also decide how goal lifecycle behaves in multi-step flows such as `mt work --plan` and PRD-driven issue execution, including when goals are created, updated, completed, or left untouched after failure.

Keep the behavior conservative: goal integration should improve agent context and observability without weakening existing cleanup/reviewer sequencing, commit policy, live streaming, or failure summaries.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Implementer-backed `mt work` runs establish or reuse a clear Codex goal that reflects the current plan or issue objective before implementation begins.
- [ ] #2 Goal lifecycle behavior is defined and observable for multi-step flows, including successful completion, implementer failure, reviewer failure, and PRD issue loop execution.
- [ ] #3 Cleanup and reviewer phases keep their existing sequencing, streaming, commit policy, and summary behavior when goal support is enabled.
- [ ] #4 Focused tests cover goal usage for the single-plan implementer path and at least one PRD-driven multi-step path.
<!-- AC:END -->
