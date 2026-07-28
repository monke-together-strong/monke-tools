---
packages:
  monke-tools: minor
---

## Chop Ordinary worktrees

Add `mt chop [target]` for foreground removal of one clean current or explicitly selected Ordinary
worktree. Chop accepts checked-out branch names and registered absolute or relative paths, protects
Source checkouts and unrelated repositories, preserves local branches, and rejects dirty or locked
worktrees.

Self-removal now requests that an Active shell adapter move to the Source checkout. Generated bash
and zsh adapters honor that request even after a failed command while preserving the original
nonzero status.
