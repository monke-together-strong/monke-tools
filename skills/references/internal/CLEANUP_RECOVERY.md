# Cleanup recovery

## Ownership and execution

Preview with `mt cleanup --dry-run`; use `--json` for structured results.
`--eligible` filters human output only; JSON includes all Sessions. Inspect blockers before removal.
A Session is removable only when every member's work is preserved and ownership
is verified. An unavailable check is a blocker, not permission to force removal.

Discovery includes the invoking checkout's Source and Sources recorded in retained
Sessions.
Add other repositories with repeatable `--source <repo>` options, including when
you invoke Cleanup outside a repository. Paths resolve relative to the invoking
directory and may identify either a Source or one of its checkouts. `--source` adds
discovery coverage without restricting Session selection. Positional worktree
targets select cleanup scope. A requested Source that cannot be inspected stops
cleanup before teardown or worktree removal.

Reports list each Source as `inspected`, `missing`, or `unavailable`. The summary
counts registered linked worktrees in inspected Sources, including registrations
whose directories are missing and excluding Source checkouts. Removal counts cover
this invocation and include completed removals from a partially failed Session.

- `--archive-untracked` preserves untracked-only work in the reported archive;
  tracked changes still need preservation. Restore from the archive's `files/` directory.
- `--include-unowned` also considers ordinary worktrees; live ones require explicit
  resource recovery.
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
