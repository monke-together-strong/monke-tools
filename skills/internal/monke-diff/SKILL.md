---
name: monke-diff
description: Open visual diffs with mt. Use only when the user asks to see, review, or compare changes visually (dirty work, branches, commits, or a time window), or to configure the Codiff or Monke See adapter.
---

# Monke diff

Use `mt diff --help` to choose the comparison and `mt diff configure` to set the
machine's adapter. Codiff opens on the user's screen. Run `mt diff` only in
the user's thread in response to their visual diff request. Monke See prints
a review URL. Give that URL to the user.

For "last N hours or days plus dirty changes", find the oldest included
first-parent commit and resolve its parent to a SHA. Run
`mt diff --branch <base-sha> --path <checkout>`. With no included commits, use
`--working-tree`. To move the time window, resolve a new base and run again.

For Monke or Codiff installation and dependency recovery, read
[Monke installation](../monke-install/SKILL.md).
