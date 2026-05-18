---
id: TASK-10
title: Have reviewer create PR with review evidence
status: To Do
assignee: []
created_date: '2026-05-18 00:20'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`mt work` already runs a reviewer phase after implementation, but the workflow currently ends with local streamed output and a summary. For review-heavy flows, the user needs the reviewer to spin up a pull request and attach enough evidence that the resulting changes can be inspected without replaying the whole terminal session.

Add reviewer-driven PR creation to the workflow. After implementation and review complete successfully, the reviewer should create or prepare a PR from the working branch and include review evidence that is easy for the user to view. Evidence may include the plan or issue context, files changed, checks run, reviewer findings, screenshots or logs when relevant, and a concise final recommendation.

The behavior should stay conservative around failures and existing workflow rules: do not create misleading PRs when implementation or review failed, preserve commit policy, and make it clear when PR creation was skipped or could not complete.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Successful reviewed `mt work` runs can create or prepare a pull request from the current branch with a clear title and body tied to the plan or issue context.
- [ ] #2 The PR body or linked evidence includes enough reviewer-facing context to inspect the change, including changed scope, checks run, reviewer outcome, and any relevant artifacts or logs.
- [ ] #3 PR creation is skipped or reported clearly when implementation fails, reviewer fails, required git remote/branch context is unavailable, or the checkout is not in a PR-ready state.
- [ ] #4 Existing cleanup, implementer, reviewer sequencing, live streaming, commit policy, and final summary behavior remain intact when PR creation is enabled.
- [ ] #5 Focused tests cover successful PR evidence generation and at least one skipped/failure path.
<!-- AC:END -->
