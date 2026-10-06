---
name: monke-worktrees
description: Use mt when creating, navigating, resuming, or removing worktrees and Sessions, acquiring, using, or releasing checkout resources, or recovering failed materialization and cleanup. Use for worktree tasks in repos with monke.yml or instructions requiring Monke.
---

# Monke worktrees and Sessions

Use `mt spawn <session>` for isolated repo work. The session name is also its
branch name: choose a name that follows repo rules and keep it consistent with
the Session. Use `mt <command> --help` for flags.

## Create and resume work

Spawn starts from the invoking checkout's `HEAD` and carries its edits; dependencies
use their source checkouts. `--no-dirty` requires clean checkouts. `-m` starts from
default branches without carrying edits. Existing worktrees retain their contents.
Source checkouts provide configuration and seed files.

After failure, use the reported retry command from the recorded checkout. A created
worktree is not ready until materialization succeeds.

Use `mt swing <target>` to navigate to a Session or worktree; `^` selects source
and `-` selects the previous target. Shell navigation requires the installed shell
adapter. For setup or repair, read [Monke installation](../monke-install/SKILL.md).

Use `mt swing pr:<number>` or a PR URL for same-repo PRs. Diverged local heads block
navigation; resolve the divergence without discarding work. Fork PRs are unsupported.

For authoring `monke.yml` or resource modules, read
[Monke configuration](../monke-config/SKILL.md).

For acquiring, using, releasing, or recovering checkout resources, read
[resource commands](../../references/internal/RESOURCES.md).

## Release and remove

A Session member selects the whole Session for Chop. From source, provide an explicit
target. Dirty files block removal; ignored files are deleted with the worktree.
Use `--force` only when discarding that work is authorized. Preserve local branches.

Preview global Cleanup with `mt cleanup --dry-run` before running `mt cleanup`;
optional paths restrict its scope. Cleanup may stop old attached processes and skips
Sessions with recently active ones. For archives, missing or ordinary worktrees,
and failed teardown, read [cleanup recovery](../../references/internal/CLEANUP_RECOVERY.md).
