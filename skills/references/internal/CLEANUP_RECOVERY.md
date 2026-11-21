# Cleanup recovery

Preview with `mt cleanup --dry-run` and inspect the blockers. For report
formats and selection options, run `mt cleanup --help`.

## Generated output

Verify that the changes, including staged versions, can be reproduced from
preserved inputs. Restore those tracked paths from `HEAD` in both the index and
working tree. Delete verified untracked output. Recheck status and preserve
authored or uncertain changes.

## Discovery and recovery

Cleanup starts from the invoking checkout's Source checkout and Source checkouts
recorded in retained Sessions. Use `--source <repo>` to include another Source
checkout or linked worktree, including when invoking Cleanup outside a repo.
Paths resolve from the invoking directory.

- `--archive-untracked` archives only untracked files. Tracked changes still
  block Cleanup, so handle them separately. Restore archived files from the
  reported archive's `files/` directory.
- For a live Ordinary worktree, verify ownership and pass `--include-unowned`,
  the explicit worktree path, and `--recover-with '<command>'`. The command runs
  from the Source checkout with `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and
  `MONKE_WORKTREE_PATH` (no saved resource values) and must be safe to retry.
- For a missing Session worktree with Cleanup obligations, restore it, run
  `mt chop <session> --cleanup-from-source` after verifying that the Source
  checkout's code, credentials, and infrastructure configuration can safely run
  the recorded cleanup, or run `mt cleanup <worktree> --recover-with '<command>'`
  with a retry-safe command that runs from the Source checkout with saved
  resource context.

After failure, preserve retained state, fix the reported cause, and retry.
Earlier cleanup commands may run again. Follow reported recovery commands for
retained detached commits. A missing directory can still have work or resources
to recover.
