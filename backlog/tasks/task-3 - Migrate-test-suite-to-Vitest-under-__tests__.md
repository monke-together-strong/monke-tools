---
id: TASK-3
title: Migrate test suite to Vitest under __tests__
status: Done
assignee:
  - '@codex'
created_date: '2026-04-11 14:28'
updated_date: '2026-04-12 22:57'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the current bun:test-based test setup with Vitest while keeping the test suite under __tests__/ and preserving existing coverage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Project test commands run through Vitest instead of bun:test
- [x] #2 Existing test files under __tests__ continue to pass under Vitest
- [x] #3 Supporting config and helpers are updated for the Vitest runner
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add Vitest as a dev dependency, switch the package test script to `vitest run`, and add a small Vitest config that targets `__tests__/**/*.test.ts`.
2. Replace `bun:test` imports in `__tests__/` with `vitest` imports, and update shared setup/helpers for Vitest lifecycle hooks.
3. Run the migrated suite under Vitest, fix any runner-specific differences, and keep linting green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Moved the `bun:test` suite from `tests/` into `__tests__/`, including the shared `helpers.ts` module.
- Added Bun-backed Vitest wiring in `./package.json` and `./vitest.config.ts`, while keeping imports working from the new directory layout.
- Replaced `bun:test` imports in `./__tests__/` with `vitest` imports.
- Verified the migration with `bun run test` and `bun run lint`.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated the project test runner from `bun:test` to Bun-backed Vitest while keeping the suite under `./__tests__/`.

Traceability:
- PR: [#10](https://github.com/monke-together-strong/monke-tools/pull/10)
- Commit: `5177198243e09b5f61c5439ceb653926597404c8`

Changes:
- Added `vitest` as a dev dependency and introduced [./vitest.config.ts](../../vitest.config.ts) to target `./__tests__/**/*.test.ts` with file parallelism disabled.
- Switched the package test command in [./package.json](../../package.json) to `bunx --bun vitest run` so Vitest runs on Bun and preserves the existing Bun-specific code paths.
- Updated the migrated files under `./__tests__/` to import their test APIs from `vitest` instead of `bun:test`.

Verification:
- `bun run test`
- `bun run lint`
<!-- SECTION:FINAL_SUMMARY:END -->
