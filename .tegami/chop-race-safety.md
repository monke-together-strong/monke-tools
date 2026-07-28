---
packages:
  monke-tools: minor
---

## Make Chop retryable and race-safe

Make `mt chop` recover exact unlocked stale worktree registrations, retry retained Session
finalization after every recorded worktree is gone, and report completed Sessions as missing on
later attempts.

Chop now revalidates Ordinary and Session worktrees immediately before foreground removal, stops
after a race or removal failure while retaining Session state, and requests shell relocation as
soon as the invoking worktree is removed even when a later Cleanup command fails.
