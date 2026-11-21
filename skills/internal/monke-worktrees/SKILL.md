---
name: monke-worktrees
description: Use mt when creating, navigating, resuming, or removing worktrees and Sessions, acquiring, using, or releasing checkout resources, or recovering failed materialization and cleanup. Use for worktree tasks in repos with monke.yml or instructions requiring Monke.
---

# Monke worktrees and Sessions

Use the Session name as its branch name. Follow the repo's branch naming rules.
Run `mt <command> --help` for flags.

## Create and resume work

Run `mt spawn feature/banana` for isolated work. By default, the root starts at
the invoking checkout's `HEAD` and dependencies start from their Source
checkouts. Existing worktrees retain their contents. Source checkouts provide
local configuration and seed files.

Start from default branches with `mt spawn feature/banana -m`, or pass an
explicit base with `mt spawn feature/banana --from origin/main`. `--from`
resolves local refs before `origin`, and fetches branches or tags that exist
only on `origin`.

After a failure, fix the cause and run the reported retry command from the
original checkout, or from the checkout an error names. Wait for materialization
to succeed before using the new Session.

To adopt an Ordinary worktree, run `mt materialize --adopt` inside it.
The worktree keeps its path. Dependencies get Session worktrees under Monke home.

## Navigate

Use `mt swing feature/banana` for an existing Session or worktree, `mt swing ^`
for its Source checkout, and `mt swing -` for the previous target. For shell
adapter setup or repair, read [Monke installation](../monke-install/SKILL.md).

Use `mt swing pr:123` or a PR URL for a same-repo PR. Swing can materialize its
Session when needed. If the local branch has diverged from the PR head, preserve
that work before resolving the divergence.

## Release and remove

To use or release allocations, follow the
[resource procedure](../../references/internal/RESOURCES.md).

Run `mt chop` inside a Session or Ordinary worktree to remove it (for a Session,
this removes the whole Session), or run `mt chop <target>` from the Source
checkout with a Session name, branch, or worktree path. Before removing a
worktree or Session,
[clear reproducible generated changes](../../references/internal/CLEANUP_RECOVERY.md#generated-output)
in each member and preserve the remaining work.

Preview global Cleanup with `mt cleanup --dry-run` before running `mt cleanup`.
Cleanup stops attached process trees over a day old and skips Sessions with
processes under a day old. For archives, missing or Ordinary worktrees, or
failed teardown, follow [cleanup recovery](../../references/internal/CLEANUP_RECOVERY.md).
