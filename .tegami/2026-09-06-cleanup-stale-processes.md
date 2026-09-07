---
subject: Stop stale processes before removing Session worktrees
packages:
  monke-tools: minor
---

## Stale process handling in Cleanup

`mt cleanup` now scans the process table once per run. A process started from inside a Session worktree and at least one day old is stopped before that worktree is removed, so an abandoned dev server can no longer refill the directory and fail removal. Any process under a day old skips the Session with the process list; an old process that merely has its working directory in the worktree is left running and reported.
