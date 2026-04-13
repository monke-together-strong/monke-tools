---
id: TASK-2
title: Refactor CLI to use commander.js
status: Done
assignee:
  - '@codex'
created_date: '2026-04-11 14:22'
updated_date: '2026-04-12 22:57'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the hand-rolled argv parsing in the monke CLI with commander.js while preserving the current commands and user-facing behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CLI commands are parsed and dispatched through commander.js instead of the manual switch in src/index.ts
- [x] #2 Existing create, materialize, and cleanup commands keep their current behavior and validation semantics
- [x] #3 CLI tests cover the commander-backed entrypoints and usage/error output
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add commander.js to the project dependencies and refresh the lockfile.
2. Replace the manual argv switch in src/index.ts with a commander-backed parser that dispatches to runCreate, runMaterialize, and runCleanup.
3. Preserve current usage and validation semantics for missing/extra arguments by translating commander parse failures into the existing error messages.
4. Add focused CLI tests for command dispatch and usage/error output, then run the relevant test suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Added `commander` as a runtime dependency and replaced the manual argv switch with a commander-backed program in `./src/index.ts`.
- Preserved the existing usage strings by mapping commander parse failures back to the repo's `MonkeError` messages.
- Added focused coverage in `./__tests__/cli.test.ts` for arity validation and stderr output.
- Verified with `bun run test` and `bun run lint`.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Refactored the manual CLI switch into a commander-backed entrypoint while keeping the current `mt` command surface and usage strings stable.

Traceability:
- PR: [#10](https://github.com/monke-together-strong/monke-tools/pull/10) introduced the commander refactor in commit `5177198243e09b5f61c5439ceb653926597404c8`.
- PR: [#11](https://github.com/monke-together-strong/monke-tools/pull/11) renamed the shipped CLI surface to `mt` in commit `357a8eb62feaa8503d6730bdc45e0009bde6543d`.

Changes:
- Added `commander` as a runtime dependency and built subcommands for `create`, `materialize`, and `cleanup` in `./src/index.ts`.
- Mapped commander parse failures back to the repo's `MonkeError` messages so `mt` preserves the existing usage and validation semantics.
- Added focused coverage in `./__tests__/cli.test.ts` for top-level usage, per-command arity validation, and stderr output.

Verification:
- `bun run test`
- `bun run lint`
<!-- SECTION:FINAL_SUMMARY:END -->
