---
id: TASK-15
title: Seed env files and seedPaths from the local source checkout in all spawn modes
status: Done
assignee:
  - claude
created_date: '2026-07-20 03:10'
updated_date: '2026-07-20 03:52'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Default-branch spawn (`mt spawn -m`) sets `seedMaterialRoot` to the freshly created worktree itself (src/monke.ts:373-374), so seeding `.env*` files and `seedPaths` is a structural no-op: gitignored `.env` files never exist in a fresh checkout. `rewriteManagedEnvFiles` then hard-fails with "Expected managed env file to exist at ..." (src/env.ts:152-154) for every repo whose managed app `.env` is untracked — which is all current repos. The failure surfaces on the first repo in materialization order, so for winters-echo it blames the external crypto-trading dependency. Session-branch respawn shares the same seed-root choice and the same failure when its worktree is recreated.

This is the dominant recurring failure in the 2026-07-19 agent-session retrospective (failed spawns across winters-echo, local-file-viewer, and banana-os sessions, with agents falling back to raw worktrees — one fallback corrupted the source checkout's node_modules).

Scope: seed machine-local material (`.env*` files and declared `seedPaths`) from the repo's local source checkout in every spawn mode, matching current-head behavior. Out of scope: dirty-state carry semantics (-m still never carries tracked staged/unstaged changes), rollback semantics, preflight validation, optional dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mt spawn -m succeeds when managed app .env files exist only as untracked files in the source checkouts, for both the root repo and external dependency repos, and the new worktrees receive port-rewritten env files
-
Respawning an existing session branch seeds env files and seedPaths from the local source checkout when the worktree is recreated
-
Untracked seedPaths content is seeded into default-branch-mode worktrees from the source checkout
-
Default-branch mode still carries no tracked dirty changes; seeding remains limited to env seed files and declared seedPaths
-
Tests cover default-branch spawn with an untracked managed .env at the source checkout for a root repo and an external dependency

- [x] #2 Respawning an existing session branch seeds env files and seedPaths from the local source checkout when the worktree is recreated
- [x] #3 Untracked seedPaths content is seeded into default-branch-mode worktrees from the source checkout
- [x] #4 Default-branch mode still carries no tracked dirty changes; seeding remains limited to env seed files and declared seedPaths
- [x] #5 Tests cover default-branch spawn with an untracked managed .env at the source checkout for a root repo and an external dependency
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Unify seedMaterialRoot to the repo source checkout in spawnSessionFromSourceRootLocked
2. Review session-branch respawn and mt materialize seed roots for the same fix
3. Add tests: -m spawn with untracked managed .env (root + external dep), session-branch respawn seeding, untracked seedPaths in -m, no tracked dirty carry in -m
4. Run bun test, lint, fmt; check ACs
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Outcome: all spawn modes now seed `.env*` files and declared seedPaths from the repo's local source checkout. Removed the `seedMaterialRoot` parameter and the `seedWorktreeFilesFromRoot` indirection; `materializeRepo` calls `seedWorktreeFiles` (which always uses `config.sourceRoot`) in both `spawn` and `materialize` paths.

Key changes:
- src/env.ts: collapsed `seedWorktreeFilesFromRoot` into `seedWorktreeFiles`; deleted `SeedWorktreeFilesFromRootOptions`.
- src/monke.ts: dropped `seedMaterialRoot` from `materializeRepo` options and both call sites (`spawnSessionFromSourceRootLocked`, `runMaterialize`); `baselinePortsRoot` semantics unchanged.
- Seeding never overwrites existing files, so tracked env files keep the spawned ref's committed content — default-branch mode still carries no tracked dirty changes.

Verification: `bun run test` (289 passed, 22 files), `bun run typecheck`, `bun run lint:check`, `bun run fmt:check` all clean. New tests: single-repo `-m` untracked env + seedPaths + dirty-tracked-not-carried, session-branch respawn seeding (env + seedPaths), multi-repo `-m` untracked external-dependency env. Updated one existing test that asserted the old behavior (untracked env files NOT seeded on `-m`) to assert the new semantics; renamed it accordingly.

Follow-ups: preflight validation before mutation, optional/lazy externals, `--bare` mode, and readiness surfacing remain untracked (see 2026-07-19 retrospective analysis).
<!-- SECTION:NOTES:END -->
