---
id: TASK-6
title: Add mt run single-pass implementer workflow
status: Done
assignee:
  - '@codex'
created_date: '2026-04-16 00:44'
updated_date: '2026-04-16 04:03'
labels: []
dependencies: []
references:
  - 'https://github.com/monke-together-strong/monke-tools/issues/13'
documentation:
  - 'https://github.com/monke-together-strong/monke-tools/issues/12'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement GitHub issue #13 from PRD #12 by adding a top-level mt run command that accepts raw plan text, runs one Codex-backed implementer pass in the current checkout, streams live agent output, and ends with a short summary via a dedicated workflow module instead of CLI-embedded orchestration.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mt run is available as a top-level command, requires --plan, and preserves multiline plan text exactly as provided by the shell
- [x] #2 Running mt run --plan ... starts a Codex-backed implementer pass in the current checkout and streams the underlying agent output live
- [x] #3 The command ends with a short summary of the implementer result, and the workflow logic is routed through a dedicated module rather than embedded in CLI parsing
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the CLI with a top-level `mt run` command that requires `--plan`, preserves the raw multiline plan string, and dispatches into a new deep workflow module instead of embedding orchestration in `src/index.ts`.
2. Add a dedicated run-workflow module plus the minimal supporting types/helpers needed to normalize execution to the git repo root, locate the Codex executable, run a single implementer pass, and stream child-process stdout/stderr live to the terminal.
3. Define a small Monke-owned implementer prompt/standards loading path for this first slice and pass the original plan text through unchanged to the Codex invocation.
4. Finish the command with a short result summary that reports success/failure without turning the CLI into workflow logic.
5. Add focused Vitest coverage for CLI wiring and plan passthrough, plus module-level tests for repo-root execution, Codex invocation/streaming, and summary behavior; then run the targeted test suite and repo checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Pulled GitHub issue #13 and PRD #12 context to confirm this slice stays implementer-only, not full cleanup/reviewer workflow.
- Reviewed current CLI, runtime, git helpers, and test patterns to line up the new command with existing repo conventions.

- Added a top-level `mt run --plan <text>` command that dispatches into a dedicated run workflow module instead of embedding orchestration in the CLI parser.
- Added Monke-owned implementer prompt/standards assets, repo-root normalization, Codex executable lookup, live child-process streaming, and short success/failure summaries.
- Added focused CLI and integration tests using a fake `codex` binary to verify raw multiline plan passthrough, repo-root execution, streamed output, and failure summaries.
- Verified with `bun test` and `bun run lint`; formatted touched files with `bunx oxfmt ...`. Full `bun run fmt:check` still reports a pre-existing issue in `__tests__/multi-repo.test.ts` outside this change.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the first `mt run` slice as a top-level CLI command that requires `--plan`, preserves multiline plan text, and routes execution through a dedicated workflow module.

Changes:
- Wired `mt run --plan <text>` into the commander entrypoint and updated usage coverage.
- Added a deep run workflow that resolves the current git repo root, loads Monke-owned implementer prompt/standards assets, invokes `codex exec` from the repo root, streams child stdout/stderr live, and prints a short success/failure summary.
- Documented the new command in the README.
- Added focused tests for CLI validation plus fake-Codex integration coverage of repo-root execution, exact plan passthrough, streamed output, and failure summaries.

Verification:
- `bun test`
- `bun run lint`
- `bunx oxfmt --check src/run.ts __tests__/cli.test.ts __tests__/run.test.ts README.md`

Audit trail:
- Closed by PR #18 (commit 135fd71b1aa892847d4f0c786069e8db3db979a2).
<!-- SECTION:FINAL_SUMMARY:END -->
