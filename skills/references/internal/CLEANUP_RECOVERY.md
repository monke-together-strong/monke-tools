# Cleanup recovery

## Ownership and execution

Preview with `mt cleanup --dry-run`; use `--json` for structured results.
`--eligible` filters human output only; JSON includes all Sessions. Inspect blockers before removal.
A Session is removable only when every member's work is preserved and ownership
is verified. An unavailable check is a blocker, not permission to force removal.

- `--archive-untracked` preserves untracked-only work in the reported archive;
  tracked changes still need preservation. Restore from the archive's `files/` directory.
- Positional worktree paths restrict cleanup scope. `--include-unowned` also considers
  ordinary worktrees; live ones require explicit resource recovery.
- `--recover-with '<command>'` requires explicit paths and runs the supplied command
  from each Source checkout with saved resource context. Verify ownership and make
  the command safe to retry before using it.
- For a missing Session worktree, restore it or use
  `mt chop <session> --cleanup-from-source` after verifying the source's code,
  credentials, and infrastructure configuration can safely perform its cleanup.

After a failure, preserve retained state, fix the reported cause, and retry the
same target. Earlier cleanup commands may run again. Follow reported recovery
commands for retained detached commits; a missing directory alone does not prove
its work or resources have been cleaned up.
