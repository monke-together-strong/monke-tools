---
id: TASK-4
title: Extend IDEA cleanup with merged-branch and diff-aware removal detection
status: To Do
assignee: []
created_date: '2026-04-11 16:47'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Expand IDEA cleanup so it can automatically detect removable items by inspecting whether related branches have already been merged and whether there are any remaining diffs or local changes that should block cleanup. The goal is to make cleanup more automatic while still being conservative about anything that might still matter.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 IDEA cleanup detects branches that have already been merged and includes their related cleanup candidates in its removable set.
- [ ] #2 Cleanup logic checks git diff or other local-change signals so it does not remove items that still have unmerged or uncommitted work behind them.
- [ ] #3 The cleanup output explains why each candidate is removable or why it was skipped, so users can understand the decision.
- [ ] #4 Tests cover merged-branch detection and at least one case where local diffs or unmerged work prevent removal.
<!-- AC:END -->
