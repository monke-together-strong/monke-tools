---
id: TASK-2
title: Refactor CLI to use commander.js
status: Done
assignee:
  - '@codex'
created_date: '2026-04-11 14:22'
updated_date: '2026-04-11 14:25'
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
- Added commander as a runtime dependency and replaced the manual argv switch with a commander-backed program in src/index.ts.
- Preserved the existing usage strings by mapping commander parse failures back to the repo's current MonkeError messages.
- Added a focused cli.test.ts file for arity validation and stderr output coverage.

- Verified with `bun test` and `bun run lint`.
- Repo-wide `bun run fmt:check` still reports a pre-existing formatting issue in tests/helpers.ts; formatted the touched files directly with `bunx oxfmt src/index.ts tests/cli.test.ts`.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Replaced the manual CLI switch with a commander-backed program while keeping the existing `monke` command surface and usage strings intact.

Changes:
- Added `commander` as a runtime dependency and built subcommands for `create`, `materialize`, and `cleanup` in `src/index.ts`.
- Mapped commander parse failures back to the repo's existing `MonkeError` messages so missing, extra, and unknown args still report the same usage text.
- Added `tests/cli.test.ts` to cover top-level usage, per-command arity validation, and stderr output from the main entrypoint.

Verification:
- `bun test`
- `bun run lint`
- `bunx oxfmt src/index.ts tests/cli.test.ts`

Note:
- `bun run fmt:check` still flags a pre-existing formatting issue in `tests/helpers.ts` unrelated to this refactor.
<!-- SECTION:FINAL_SUMMARY:END -->
