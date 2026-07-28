---
packages:
  monke-tools: minor
---

## Chop complete Sessions

Extend `mt chop [target]` to remove one selected clean Session across every repo recorded in its
Session state. Chop performs an aggregate side-effect-free preflight, preserves local branches,
removes the invoking worktree last, and retains Session state when removal or Cleanup fails so the
same explicit command can be retried.

Session finalization now uses only saved Cleanup commands and Resource data, runs from the Root repo
toward dependencies, and is shared by explicit Chop and broad dead-Session Cleanup.
