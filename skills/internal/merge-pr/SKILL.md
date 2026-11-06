---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request.
---

# Merge PR

A direct "merge this PR" or "get this merged" authorizes merging now. Report
CI and review status, then merge without waiting for them or asking for a
separate waiver.

For "merge when ready" or an equivalent condition, complete
[shepherd-pr](../shepherd-pr/SKILL.md) first. Preserve that condition when
returning here and use `--require-passing` below.

## Checklist

1. Resolve the PR: explicit number or URL wins; otherwise use `gh pr view`. Ask if no single PR resolves.
2. Run [check-ci](scripts/check-ci.ts) immediately before untracking:

   ```sh
   bun <skill-dir>/scripts/check-ci.ts --repo <owner/name> --pr <number>
   ```

   The default reports the current head and CI without blocking on pending,
   failed, missing, or skipped-only checks. For conditional merging, add
   `--require-passing`; exit 1 means keep tracking and return to shepherding.
   Continue only on exit 0. A usage or read error exits 64; resolve it before
   proceeding.
3. Run `mt prs untrack <url>` so the external-merge poller leaves this PR to you.
   Squash-merge with the head returned by check-ci:

   ```sh
   gh pr merge <number> --repo <owner/name> --squash --match-head-commit <head>
   ```

   Completion requires the merge command to succeed and
   `gh pr view <number> --repo <owner/name> --json state` to report `MERGED`.
   If the merge fails or the state is not `MERGED`, track it again with the
   thread and checkout that `untrack` printed. If the head changed, repeat the
   CI check for the new head before retrying.
4. Run [post-merge](../post-merge/SKILL.md) for the merged PR.

Report the PR URL, merge method, checked head, CI result, and merge timing with
post-merge's hand-off or report.
