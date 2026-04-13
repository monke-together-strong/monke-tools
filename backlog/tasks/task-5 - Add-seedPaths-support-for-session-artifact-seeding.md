---
id: TASK-5
title: Add seedPaths support for session artifact seeding
status: Done
assignee:
  - '@codex'
created_date: '2026-04-12 20:11'
updated_date: '2026-04-12 20:14'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Allow monke to seed additional repo-local files or directories into newly created session worktrees so repos like winters-echo can bring over Frostbite Chrome session profiles for E2E.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 monke.yml supports an optional repo-level seedPaths array of repo-root-relative file or directory paths
- [x] #2 Configured seed paths are copied into newly created session worktrees without overwriting existing worktree content
- [x] #3 Repeated create/materialize runs do not re-copy or clobber seeded paths
- [x] #4 Invalid or escaping seedPaths are rejected during config load
- [x] #5 Missing source seedPaths warn and do not fail session creation
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend monke.yml parsing and RepoConfig types with optional repo-level seedPaths validation.
2. Generalize new-worktree seeding so .env files plus configured file/directory paths are copied without overwriting existing targets.
3. Surface non-fatal warnings for missing source seedPaths during session creation/materialization.
4. Add focused Vitest coverage for valid/invalid config, file and directory seeding, and no-clobber behavior on repeated runs.
5. Run the targeted test suite and update the task notes/summary based on the verified result.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Added repo-level seedPaths parsing with in-repo path validation and duplicate normalized-path detection.
- Generalized new-worktree seeding to copy configured files/directories alongside discovered .env files, while skipping existing targets.
- Missing seed paths now warn to stderr during worktree creation instead of failing session creation.
- Added config and single-repo coverage for valid/invalid seedPaths, file+directory copy, and no-clobber behavior on repeated create/materialize runs.
- Verified with bunx --bun vitest run __tests__/config.test.ts __tests__/single-repo.test.ts, bun run lint, and bun test.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added repo-level `seedPaths` support so Monke can seed extra repo-local files and directories into newly created session worktrees without clobbering later session-local changes.

Changes:
- Extended `monke.yml` parsing and `RepoConfig` with validated `seedPaths`.
- Replaced env-only worktree seeding with shared seeding logic that still copies `.env*` files and now also copies configured directories/files.
- Missing configured seed paths now emit warnings to stderr instead of aborting create/materialize.
- Added focused coverage for config validation, initial file+directory seeding, and no-overwrite behavior on repeated runs.

Tests:
- `bunx --bun vitest run __tests__/config.test.ts __tests__/single-repo.test.ts`
- `bun run lint`
- `bun test`
<!-- SECTION:FINAL_SUMMARY:END -->
