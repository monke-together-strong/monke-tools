---
name: monke-tools-core
description: Use mt for worktree creation, navigation, diff review, teardown, monke.yml configuration, installation, updates, and skill targets. Use for worktree tasks in repos with monke.yml or instructions requiring monke-tools.
---

# monke-tools Core

Use `mt spawn <session>` from the source checkout or a linked worktree for new isolated work in a monke-tools repo. Follow the repo's branch naming rules and work in the resulting session checkout.

## Commands

- `mt spawn <session> [--codex]`: create or update a session worktree and its dependency worktrees. Use `--codex` when follow-up threads will use it; the flag opens the root session checkout as a Codex workspace.
- `mt swing [target] [--codex]`: navigate to a session or linked-worktree branch, `^` for the source checkout, `-` for the previous target, or a same-repo PR (`pr:123` or URL). Omit the target for a picker. Use `--codex` when follow-up threads will use that checkout; the flag opens it as a Codex workspace.
- `mt diff [-p|--pick]`: open Codiff for the current checkout using a remembered or inferred base, or a picker. Use `--pick` to choose explicitly. Bases contribute committed state; the current checkout includes staged, unstaged, and untracked changes.
- `mt home`: print the resolved absolute monke home path without creating it, honoring `MONKE_HOME` and defaulting to `~/.monke`.
- `mt materialize`: refresh env/path rewrites, resources, and bootstrap inside a session, reusing assigned ports.
- `mt setup`: write dependency paths into the source checkout's root `.env`.
- `mt chop [target]`: remove the current or selected session/worktree and run recorded session cleanup, preserving local branches. A session member selects the whole session; supply a target from the source checkout.
- `mt cleanup`: clean eligible retained Sessions across all Roots, including partially removed Sessions and those awaiting finalization. Preview without changes with `--dry-run`; both modes accept `--json` and `--eligible` (hide skipped Sessions in human output) and work outside a repository. Every member must pass eligibility. Optional worktree paths restrict scope; unowned worktrees stay untouched unless included explicitly. Process trees whose command line names a path inside a worktree, such as a dev server started there, are stopped before removal once a day old; any process under a day old skips the Session and is listed.
- `mt update [--check]`: activate the latest stable release, or check without changing the install. Read [installation and updates](INSTALLATION.md) before updating, especially from a local build or customized release.
- `mt skills configure`: change saved agent skill targets or reconcile their links and instructions.

## Usage notes

Spawn branches from the invoking checkout's `HEAD` and copies its edits, leaving the original untouched. Existing branches must match that HEAD to receive edits; existing worktrees keep their contents. Dependencies, configuration, and seeds use canonical source checkouts. Retry interrupted carry from its recorded checkout and HEAD.

`--no-dirty` requires clean invoking and dependency checkouts. `-m` (`--main`, `--master`) uses default branches without dirty carry and takes precedence over `--no-dirty`.

Explicit PR navigation fetches the PR head and creates a session if needed; diverged local heads block navigation. Stored targets and picker selections do not revalidate PR heads. Fork PRs are unsupported.

Run subsequent agent commands with the resolved checkout as their working directory. Shell navigation requires an active shell adapter; `--codex` opens a workspace without creating a thread.

A session is ready after dependencies, env/path rewrites, resources, and bootstrap succeed. On failure, report the failing repo and retry command; a created worktree alone is incomplete.

## Remove and recover

Resolve the target scope before removal. Dirty files block `chop`; use `--force` only when discarding them is authorized. Ignored files are always deleted with removed worktrees. Ordinary worktrees accept registered branches or paths; detached worktrees require current-location or path selection. Source checkouts are not removal targets.

Cleanup commands run before any Session worktrees are removed; failure retains the remaining worktrees and Session state. Earlier commands may already have removed resources. Diagnose the reported repository/step and completed actions, then retry `mt cleanup` for eligible Sessions or `mt chop <session>` for an explicit target; recorded cleanup commands run root-first and may rerun. A missing worktree blocks required commands; restore it, or explicitly use `mt chop <session> --cleanup-from-source` only after verifying those commands are safe from the source checkout. Preserve session state for recovery. Teardown is complete when removal and finalization succeed.

For archived notes, missing worktrees, or ordinary worktree cleanup, read the [cleanup recovery contract](../../../docs/reference/session-lifecycle.md#ownership-and-execution). `--archive-untracked` saves untracked-only bundles before removal. Live ordinary worktrees require audited resource recovery; `--recover-with '<command>'` requires explicit worktree paths and runs from canonical Sources with saved resources.

## Configuration and installation

When creating, editing, or diagnosing `monke.yml`, including Docker teardown, read the [configuration reference](MONKE-YML-REFERENCE.md).

For missing or stale mt, local builds, release updates, skill targets, shell integration, or Codiff dependencies, read [installation and updates](INSTALLATION.md).
