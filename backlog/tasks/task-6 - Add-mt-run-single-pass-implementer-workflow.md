---
id: TASK-6
title: Add mt work single-pass implementer workflow
status: Done
assignee:
  - '@codex'
created_date: '2026-04-16 00:44'
updated_date: '2026-04-16 15:46'
labels: []
dependencies: []
references:
  - 'https://github.com/monke-together-strong/monke-tools/issues/13'
documentation:
  - 'https://github.com/monke-together-strong/monke-tools/issues/12'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement GitHub issue #13 from PRD #12 by adding a top-level mt work command that accepts raw plan text, preserves multiline plan input exactly as provided by the shell, checkpoints dirty startup work when needed, runs Codex-backed implementer and reviewer passes from the current checkout with live-streamed agent output, blocks commits outside the cleanup checkpoint phase, and ends with a short workflow summary via a dedicated module instead of CLI-embedded orchestration.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mt work is available as a top-level command, requires --plan, preserves multiline plan text exactly as provided by the shell, and routes execution through a dedicated workflow module
- [x] #2 Running mt work --plan ... checkpoints dirty startup work when needed, then runs Codex-backed implementer and reviewer passes in the current checkout while streaming the underlying agent output live
- [x] #3 The command ends with a short summary covering cleanup, implementer, and reviewer outcomes; aborts before implementation if cleanup fails to checkpoint cleanly; and fails when implementer or reviewer create commits
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the CLI with a top-level `mt work` command that requires `--plan`, preserves the raw multiline plan string, and dispatches into a new deep workflow module instead of embedding orchestration in `src/index.ts`.
2. Add a dedicated run-workflow module plus the minimal supporting types/helpers needed to normalize execution to the git repo root, locate the Codex executable, run a single implementer pass, and stream child-process stdout/stderr live to the terminal.
3. Define a small Monke-owned implementer prompt/standards loading path for this first slice and pass the original plan text through unchanged to the Codex invocation.
4. Finish the command with a short result summary that reports success/failure without turning the CLI into workflow logic.
5. Add focused Vitest coverage for CLI wiring and plan passthrough, plus module-level tests for repo-root execution, Codex invocation/streaming, and summary behavior; then run the targeted test suite and repo checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Pulled GitHub issue #13 and PRD #12 context to confirm this slice stays implementer-only, not full cleanup/reviewer workflow.
- Reviewed current CLI, runtime, git helpers, and test patterns to line up the new command with existing repo conventions.

- Added a top-level `mt work --plan <text>` command that dispatches into a dedicated run workflow module instead of embedding orchestration in the CLI parser.
- Added Monke-owned implementer prompt/standards assets, repo-root normalization, Codex executable lookup, live child-process streaming, and short success/failure summaries.
- Added focused CLI and integration tests using a fake `codex` binary to verify raw multiline plan passthrough, repo-root execution, streamed output, and failure summaries.
- Verified with `bun test` and `bun run lint`; formatted touched files with `bunx oxfmt ...`. Full `bun run fmt:check` still reports a pre-existing issue in `__tests__/multi-repo.test.ts` outside this change.

- Follow-up: The earlier note "Pulled GitHub issue #13 and PRD #12 context to confirm this slice stays implementer-only, not full cleanup/reviewer workflow." is now stale.
- Scope expanded during implementation because the shipped `mt work` flow needed cleanup checkpointing, reviewer execution, and commit-guard enforcement to match the end-to-end workflow behavior captured in the acceptance criteria and final summary.
- Shipped outcome: the task now covers cleanup, implementer, and reviewer passes in one workflow rather than an implementer-only slice.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Recorded the shipped `mt work` workflow as the top-level Codex entrypoint rather than the earlier implementer-only slice.

Impact:
- `mt work --plan <text>` preserves raw multiline plan text, resolves execution to the git repo root, and drives the full workflow from one CLI entrypoint.
- Dirty startup work is checkpointed first when needed, so existing changes are either captured in a required `clean up:` commit or the run aborts before implementation.
- The command streams live agent output for both the Codex-backed implementer and reviewer passes, then reports a short combined summary of cleanup, implementation, and review outcomes.
- Commit creation is blocked outside cleanup, so implementer and reviewer passes may not create commits even when they otherwise finish successfully.

Key changes:
- Wired `mt work --plan <text>` into the CLI and routed execution through dedicated workflow orchestration in `src/run.ts`.
- Loaded Monke-owned cleanup, implementer, and reviewer prompts plus shared coding standards for the sequential workflow phases.
- Added repo-root execution, live stdout/stderr streaming, reviewer target selection from the resulting diff or HEAD state, and summary reporting across cleanup, implementer, and reviewer phases.
- Added focused CLI and workflow coverage for exact plan passthrough, streamed agent output, cleanup checkpointing, reviewer execution, and commit-blocking enforcement.
<!-- SECTION:FINAL_SUMMARY:END -->
