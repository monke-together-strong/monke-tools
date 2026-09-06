---
subject: Clean eligible Sessions across all Roots
packages:
  monke-tools: minor
---

## Global Session cleanup

`mt cleanup` now inspects and cleans eligible retained Sessions across all Roots, including live, partially removed, and finalization-only Sessions. Every member must pass eligibility before removal. Local branches and unowned worktrees are preserved.

Preview with `mt cleanup --dry-run` from any directory without changing Git or retained state. Both modes support `--json`, with planned actions, per-member checks, and precise partial-failure and retry reports. The `--merged` flag has been removed.
