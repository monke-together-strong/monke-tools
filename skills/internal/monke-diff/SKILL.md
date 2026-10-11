---
name: monke-diff
description: Open visual diffs with mt. Use when presenting completed changes, reviewing dirty work, comparing branches or commits, selecting a time window, or configuring the Codiff or LFV adapter.
---

# Monke diff

`mt diff` owns comparison selection. Use `mt diff --help` for sources and flags;
`--pick` chooses a comparison base.

Use `--adapter lfv` for user-facing diffs, or save it with
`mt diff configure --adapter lfv`. LFV owns authentication, rendering, Refresh,
and expiry. The configured LFV CLI must exist. Return the printed review URL unchanged.

For "last N hours/days plus dirty changes", resolve the oldest included first-parent
commit's parent to an immutable base SHA, then run
`mt diff --adapter lfv --branch <base-sha> --path <checkout>`. With no included commits,
use `--working-tree`. Refresh keeps the base
fixed while updating HEAD and dirty changes; it does not slide the time window.

For Monke or Codiff installation and dependency recovery, read
[Monke installation](../monke-install/SKILL.md).
