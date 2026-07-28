---
packages:
  monke-tools: minor
---

## Complete Chop targeting and force semantics

Complete `mt chop [target] [--force]` target resolution across Sessions and Ordinary worktrees.
Session names take precedence over Ordinary targets, and selecting a valid recorded Session-member
path promotes removal to the whole owning Session without allowing unrelated Ordinary-worktree
removal.

Add `--force` to deliberately discard staged, modified, and untracked files across Ordinary,
single-repo, and multi-repo Session targets. Structural, identity, scope, lock, and Session-state
safety checks remain mandatory; ignored files are always deleted and are now called out in Chop
help.
