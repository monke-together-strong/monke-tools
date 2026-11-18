# Cleanup recovery

Preview with `mt cleanup --dry-run` and inspect the blockers. For report
formats and selection options, run `mt cleanup --help`.

## Generated output

Verify that the changes, including staged versions, can be reproduced from
preserved inputs. Restore those tracked paths from HEAD in both the index and
working tree. Delete verified untracked output. Recheck status and preserve
authored or uncertain changes.

## Discovery and recovery

Cleanup starts from the invoking checkout's Source and Sources recorded in
retained Sessions. Use `--source <repo>` to include another Source or checkout,
including when invoking Cleanup outside a repo. Paths resolve from the invoking
directory.

- With `--archive-untracked`, preserve tracked changes separately. Restore
  archived files from the reported archive's `files/` directory.
- Before using `--recover-with '<command>'` for a live Ordinary worktree,
  verify ownership and make the command safe to retry from the Source checkout
  with saved resource context.
- For a missing Session worktree, restore it or use
  `mt chop <session> --cleanup-from-source` after verifying that the Source
  checkout's code, credentials, and infrastructure configuration can safely
  perform its cleanup.

After failure, preserve retained state, fix the reported cause, and retry.
Earlier cleanup commands may run again. Follow reported recovery commands for
retained detached commits. A missing directory can still have work or resources
to recover.
