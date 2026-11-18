---
name: monke-worktrees
description: Use mt when creating, navigating, resuming, or removing worktrees and Sessions, acquiring, using, or releasing checkout resources, or recovering failed materialization and cleanup. Use for worktree tasks in repos with monke.yml or instructions requiring Monke.
---

# Monke worktrees and Sessions

Use the Session name as its branch name. Follow the repo's branch naming rules.
Run `mt <command> --help` for flags.

## Create and resume work

Run `mt spawn feature/search` for isolated work. By default, the root starts at
the invoking checkout's `HEAD` and dependencies start from their Source
checkouts. Existing worktrees retain their contents. Source checkouts provide
local configuration and seed files.

When you need an explicit base, run `mt spawn feature/search --from origin/main`.
A branch or tag may exist only on `origin`.

After a failure, run the reported retry command from the checkout it names.
Wait for materialization to succeed before using the new Session.

To adopt an Ordinary worktree, run `mt materialize --adopt` inside it.
The worktree keeps its path. Dependencies get Session worktrees under Monke home.

## Navigate

Use `mt swing feature/search` for an existing Session or worktree, `mt swing ^`
for its Source checkout, and `mt swing -` for the previous target. For shell
adapter setup or repair, read [Monke installation](../monke-install/SKILL.md).

Use `mt swing pr:123` or a PR URL for a same-repo PR. Swing can materialize its
Session when needed. If a local head has diverged, preserve that work before
resolving the divergence.

## Release and remove

To use or release allocations, follow the
[resource procedure](../../references/internal/RESOURCES.md).

A Session member selects the whole Session for Chop. From the Source checkout,
name the Session explicitly. Before removing it,
[clear reproducible generated changes](../../references/internal/CLEANUP_RECOVERY.md#generated-output)
in each member and preserve the remaining work.

Preview global Cleanup with `mt cleanup --dry-run` before running `mt cleanup`.
Cleanup may stop old attached processes and skips Sessions with recently active
ones. For archives, missing or Ordinary worktrees, or failed teardown, follow
[cleanup recovery](../../references/internal/CLEANUP_RECOVERY.md).
