---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request.
---

# Merge PR

A standalone "merge this PR" or "get this merged" authorizes merging now. Report
CI and review status, then merge without waiting for them or asking for a
separate waiver.

For "merge when ready" or a readiness condition from the calling workflow,
complete [shepherd-pr](../shepherd-pr/SKILL.md) first. Preserve that condition
when returning here and retain the full head SHA that passed its readiness checks.

## Checklist

1. Resolve the PR: explicit number or URL wins; otherwise use `gh pr view`. Ask if no single PR resolves.
2. Run `mt prs check-ci` immediately before untracking:

   ```sh
   mt prs check-ci --repo <owner/name> --pr <number>
   ```

   The default reports the current head and CI without blocking on pending,
   failed, missing, or skipped-only checks. For conditional merging, add
   `--require-passing <ready-head-sha>`. If CI blocks, keep tracking and return
   to shepherding. A different current head also requires shepherding again.
   Continue only on exit 0. Resolve usage or read errors before proceeding.
3. Run `mt prs untrack <url>` so the external-merge poller leaves this PR to you.
   Squash-merge with the head returned by check-ci:

   ```sh
   gh pr merge <number> --repo <owner/name> --squash --match-head-commit <head>
   ```

4. Read `gh pr view <number> --repo <owner/name> --json state` after the merge
   command, including when it fails. A confirmed `MERGED` state means the merge
   completed; continue to post-merge regardless of the command's exit code.

   Otherwise, restore any tracking record removed by `untrack`, using its printed
   thread and checkout. `Not tracked` means there is no prior record to restore.
   Resolve read errors before deciding whether to retry the merge.

   A queued or auto-merge request that remains open is pending. Retain ownership
   until it merges or is rejected. In T3, ensure tracking succeeds, using the
   actual current thread and checkout when no prior record exists:

   ```sh
   mt prs track <url> --thread <owning-thread-id> --checkout <PR-checkout>
   ```

   Use the host's PR watch while waiting. Outside T3, keep waiting or confirm a
   monitoring handoff that owns post-merge before ending the turn.

   If the merge was rejected because the head changed, repeat the CI report for
   an immediate merge. For a conditional merge, shepherd the new head before
   retrying. Continue below only after GitHub confirms `MERGED`.
5. Run [post-merge](../post-merge/SKILL.md) for the merged PR.

Report the PR URL, merge method, checked head, CI result, and merge timing with
post-merge's hand-off or report.
