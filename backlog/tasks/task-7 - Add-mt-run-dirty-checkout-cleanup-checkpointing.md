---
id: TASK-7
title: Add mt run dirty-checkout cleanup checkpointing
status: Done
assignee:
  - '@codex'
created_date: '2026-04-16 01:11'
updated_date: '2026-04-16 03:27'
labels: []
dependencies: []
references:
  - 'https://github.com/monke-together-strong/monke-tools/issues/14'
documentation:
  - 'https://github.com/monke-together-strong/monke-tools/issues/12'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement GitHub issue #14 from PRD #12 by teaching mt run to detect dirty startup checkouts, run a cleanup phase through the shared harness only when needed, and abort before implementation unless that cleanup phase creates a commit whose message starts with 'clean up'.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mt run detects whether the startup checkout is dirty and only invokes cleanup when staged, unstaged, or untracked changes are present
- [x] #2 The cleanup phase runs through the shared harness contract, is the only phase allowed to commit, and must produce a commit whose message starts with 'clean up'
- [x] #3 If cleanup runs but fails to create the required commit, the workflow aborts before implementation and reports the failure clearly
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the existing run workflow into a shared phase/harness model that can execute cleanup and implementer passes from the repo root while preserving live Codex streaming.
2. Add git checkout inspection helpers for startup dirty detection and post-phase commit verification, including staged/unstaged/untracked coverage and commit-subject lookup.
3. Add Monke-owned cleanup prompt assets and require the cleanup phase to create a commit whose subject starts with `clean up`; abort before implementation with a clear summary if cleanup was needed but did not produce that commit.
4. Update the CLI-facing run summary/reporting so successful clean repos skip cleanup cleanly and failed cleanup exits before the implementer runs.
5. Add focused Vitest coverage for dirty vs clean startup behavior, cleanup commit validation, abort behavior, and harness command sequencing using the fake Codex test harness; then run targeted tests, lint, and formatting checks on touched files.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Validation found two remaining enforcement gaps:
  - cleanup success was accepted even when startup dirt remained after the checkpoint commit
  - implementer commits were not blocked or detected, despite cleanup being the only allowed commit phase
- Finishing the missing invariants and extending coverage for both repros.

- Added a post-cleanup checkout-state invariant so cleanup only succeeds when it creates the required `clean up` commit and leaves the checkout clean before implementation starts.
- Added implementer commit detection by comparing HEAD before and after the implementer phase; the run now fails if implementer creates any commit.
- Extended the fake Codex harness and run tests to cover partial cleanup commits and forbidden implementer commits.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Completed the remaining enforcement work for issue #14 so `mt run` now rejects both incomplete cleanup checkpointing and forbidden implementer commits.

Changes:
- `src/run.ts` now re-inspects checkout state after cleanup and aborts before implementation if any staged, unstaged, or untracked changes remain.
- `src/run.ts` now snapshots HEAD around the implementer phase and fails the run if implementer creates a commit, preserving cleanup as the only commit-capable phase.
- `__tests__/run.test.ts` adds coverage for the two missing repros: partial cleanup commits that leave dirt behind, and implementer-created commits.
- `__tests__/helpers.ts` extends the fake Codex harness so those workflow invariants can be tested directly.

Tests:
- `bun test __tests__/run.test.ts __tests__/git.test.ts __tests__/cli.test.ts`
- `bunx oxfmt --check src/run.ts __tests__/helpers.ts __tests__/run.test.ts`
- `bun run lint`

Notes:
- `bun run fmt:check` still reports a pre-existing unrelated formatting issue in `__tests__/multi-repo.test.ts`.
<!-- SECTION:FINAL_SUMMARY:END -->
