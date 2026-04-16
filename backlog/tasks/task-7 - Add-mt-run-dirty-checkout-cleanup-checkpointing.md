---
id: TASK-7
title: Add mt run dirty-checkout cleanup checkpointing
status: Done
assignee:
  - '@codex'
created_date: '2026-04-16 01:11'
updated_date: '2026-04-16 04:57'
labels: []
dependencies: []
references:
  - 'https://github.com/monke-together-strong/monke-tools/issues/14'
documentation:
  - 'https://github.com/monke-together-strong/monke-tools/issues/12'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement GitHub issue #14 from PRD #12 by extending mt run so dirty startup checkouts are checkpointed through the shared harness only when needed, the streamed Codex-backed implementer and reviewer workflow proceeds only after cleanup succeeds, and any commit outside the cleanup checkpoint phase is blocked and reported.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mt run detects whether the startup checkout is dirty and only invokes cleanup when staged, unstaged, or untracked changes are present before continuing to the implementer and reviewer workflow
- [x] #2 The cleanup phase runs through the shared harness, is the only phase allowed to commit, must produce a commit whose message starts with clean up, and later implementer or reviewer commit attempts are treated as failures
- [x] #3 If cleanup runs but fails to create the required checkpoint commit or leaves the checkout dirty, the workflow aborts before implementation and reports the failure clearly; otherwise reviewer execution and the final summary still reflect the full workflow result
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
Completed the cleanup enforcement slice so the shipped `mt run` workflow safely handles dirty repos before the implementer and reviewer passes continue.

Impact:
- Dirty startup work is checkpointed only when needed and must land in a required `clean up:` commit before the main workflow can proceed.
- After successful cleanup, `mt run` still runs the Codex-backed implementer and reviewer passes with live streaming and reports the combined workflow outcome at the end.
- Cleanup remains the only phase allowed to create commits, and commit attempts from later phases are surfaced as workflow failures.

Key changes:
- Extended the shared run harness so cleanup, implementer, and reviewer phases execute from the repo root with common prompt loading and streamed output behavior.
- Added post-cleanup validation that aborts before implementation when the checkpoint commit is missing, uses the wrong prefix, or leaves the checkout dirty.
- Added commit detection around the implementer and reviewer phases so later workflow phases cannot create commits.
- Expanded fake-Codex workflow coverage for dirty startup repos, incomplete cleanup checkpoints, reviewer execution after implementation, and forbidden commit creation.
<!-- SECTION:FINAL_SUMMARY:END -->
