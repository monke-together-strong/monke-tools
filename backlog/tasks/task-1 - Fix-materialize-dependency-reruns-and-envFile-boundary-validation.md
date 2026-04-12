---
id: TASK-1
title: Fix materialize dependency reruns and envFile boundary validation
status: Done
assignee:
  - '@codex'
created_date: '2026-04-11 06:54'
updated_date: '2026-04-12 22:57'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Address the review findings on the Monke issue #1 branch by ensuring materialize re-applies dependency repos on rerun and by rejecting envFile paths that escape the app directory.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 monke materialize re-applies dependency repos before root reruns so dependency-managed files are healed
- [x] #2 monke rejects envFile paths that escape the target app directory
- [x] #3 Regression tests cover both behaviors
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Tighten config validation so each app envFile resolves inside that app directory.
2. Adjust materialize orchestration so dependency repos are re-materialized on rerun instead of being skipped from saved session state.
3. Add regression tests for dependency healing and envFile boundary rejection, then run the focused suite and full tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Contained app envFile paths to the app directory during config validation to prevent repo-root or sibling env rewrites.
- Updated materialize orchestration to reapply dependency repos before the current repo instead of reusing saved dependency state as a skip shortcut.
- Added regression coverage for envFile boundary rejection and root-triggered dependency re-materialization.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed the two review gaps on issue #1 branch.

Changes:
- Constrained each app's `envFile` to resolve within that app directory during config loading, preventing repo-root or sibling env rewrites.
- Updated `mt materialize` to re-materialize dependency repos before the current repo instead of short-circuiting on saved dependency state, so dependency-managed env files and `.monke/ports.env` heal on rerun.
- Added regression tests for `envFile` containment and root-triggered dependency re-materialization.

Tests:
- `bunx --bun vitest run __tests__/config.test.ts __tests__/recovery-bootstrap-cleanup.test.ts`
- `bun run test`
- `bun run lint`
<!-- SECTION:FINAL_SUMMARY:END -->
