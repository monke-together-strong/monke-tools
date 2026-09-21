---
name: monke-tools-core
description: Use mt for worktree creation, navigation, diff review, teardown, monke.yml configuration, installation, updates, and skill targets. Use for worktree tasks in repos with monke.yml or instructions requiring monke-tools.
---

# monke-tools Core

Use `mt spawn <session>` for isolated repo work, following the repo's branch naming
rules. Run subsequent commands from the returned checkout. Use `mt <command> --help`
for flags.

## Choose the command

| Command | Use |
| --- | --- |
| `mt spawn <session>` | Create the repo and dependency worktrees. |
| `mt materialize` | Resume or refresh a Session's environment and bootstrap. |
| `mt swing <target>` | Navigate to a Session, worktree, or same-repo PR. `^` selects source; `-` selects the previous target. |
| `mt diff` | Review the current checkout; `--pick` chooses a comparison base. |
| `mt setup` | Prepare static checkout values and dependency paths before infrastructure starts. |
| `mt resources acquire` | Acquire missing resources for the current checkout. |
| `mt resources exec -- <command> [args...]` | Run with validated saved resource values. |
| `mt resources release` | Release allocations while retaining the checkout and infrastructure. |
| `mt chop [target]` | Remove one Session or ordinary worktree, preserving branches. |
| `mt cleanup --dry-run` | Preview eligible Sessions across all repos. |
| `mt home` | Print the Monke home path. |
| `mt skills configure` | Select skill targets or reconcile installed guidance. |

## Create and resume work

Spawn starts from the invoking checkout's `HEAD` and carries its edits; dependencies
use their source checkouts. `--no-dirty` requires clean checkouts. `-m` starts from
default branches without carrying edits. Existing worktrees retain their contents.
Source checkouts provide configuration and seed files.

After failure, use the reported retry command from the recorded checkout. A created
worktree is not ready until materialization succeeds. Add `--codex` to Spawn or Swing
to open the checkout in Codex. Shell navigation requires the installed shell adapter.

Use `mt swing pr:<number>` or a PR URL for same-repo PRs. Diverged local heads block
navigation; resolve the divergence without discarding work. Fork PRs are unsupported.

## Release and remove

For acquisition prerequisites, foreground execution, or partial failures, read
[resource commands](../../references/internal/RESOURCES.md).

A Session member selects the whole Session for Chop. From source, provide an explicit
target. Dirty files block removal; ignored files are deleted with the worktree.
Use `--force` only when discarding that work is authorized. Preserve local branches.

Preview global Cleanup before running `mt cleanup`; optional paths restrict its scope.
Cleanup may stop old attached processes and skips Sessions with recently active ones.
For archives, missing or ordinary worktrees, and failed teardown, read
[cleanup recovery](../../references/internal/CLEANUP_RECOVERY.md).

## Configuration and installation

For `monke.yml`, resource modules, or Docker teardown, read the
[configuration reference](MONKE-YML-REFERENCE.md).

For installation, updates, shell integration, or Codiff dependencies, read
[installation and updates](INSTALLATION.md).
