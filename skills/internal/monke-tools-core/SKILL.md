---
name: monke-tools-core
description: Use monke-tools for session worktrees, env rewrites, dependency worktrees, and cleanup. Use whenever Codex needs to create, isolate, switch to, or repair worktrees in a repo with monke.yml or mt/monke-tools support; prefer mt spawn over raw git worktree commands for new session worktrees.
---

# monke-tools Core

Use this skill when the current repo uses `mt` / monke-tools. A repo uses monke-tools when it has `monke.yml`, existing `mt-*` session worktrees, or local instructions mention `mt`.

When creating an isolated branch/worktree for a task in a monke-tools repo, use `mt spawn <session>` from the source checkout instead of `git worktree add`. The session worktree is ready when dependency worktrees exist, env/path values are rewritten, and configured bootstrap behavior has completed or reported a clear failure.

## Prerequisite

The `mt` command must be available on `PATH`:

```bash
command -v mt
```

If it is missing or stale, ask the user to refresh the local install from the monke-tools checkout with `bun run install:local`.

## Commands

- `mt spawn <session> [--codex]`: create or update a Session worktree and its dependency worktrees. Use `--codex` when follow-up threads will use it; the flag opens it as a Codex workspace.
- `mt swing [target] [--codex]`: navigate to an existing Session worktree, Ordinary worktree, Source checkout, Previous Swing target, or same-repo pull request. Use `--codex` when follow-up threads will use that checkout; the flag opens it as a Codex workspace.
- `mt home`: print the resolved absolute Monke home path without creating it.
- `mt materialize`: run inside a Session worktree to refresh Managed env file rewrites, Path env values, resources, and bootstrap behavior.
- `mt setup`: run from a Source checkout to write Path env values into the Source checkout root `.env`.
- `mt cleanup`: remove Session state records whose Dead worktrees no longer exist and run configured Cleanup commands; `mt cleanup --merged` additionally removes Session worktrees for Merge-cleanable Sessions whose branch is proven by a Merged PR (`--dry-run` to preview without removing).
- `mt skills configure`: update which Agent skill roots receive monke-tools Distributed skills.
- `mt skills local-install <source-checkout> [--targets <targets...>]`: record the Installed source checkout and install skills using explicit Codex, Claude, or Cursor targets, the saved preference, or interactive configuration when neither exists.

## Core Flows

- Spawn a session worktree from the source checkout with `mt spawn <session>`; use the spawned session worktree for task work.
- Refresh an existing Session from inside the Session worktree with `mt materialize`; completion requires Managed env file rewrites, Path env values, resources, and bootstrap behavior to finish or report a clear failure.
- Update Source checkout Path env values with `mt setup`; do not use it as a replacement for Session materialization.
- Clean stale monke-tools state with `mt cleanup`; report cleanup failures instead of deleting state by hand.
- When editing or diagnosing `monke.yml`, read [MONKE-YML-REFERENCE.md](MONKE-YML-REFERENCE.md).

## Rules

- Follow the consumer repo's own `AGENTS.md`, branching, task, and test rules.
- Do not run `mt materialize` from a source checkout; use `mt spawn` or `mt setup` there.
- Do not hand-edit monke-tools session state unless explicitly debugging state corruption.
- If `mt` behavior seems stale after monke-tools source changes, refresh the local install from the monke-tools checkout with `bun run install:local`.
