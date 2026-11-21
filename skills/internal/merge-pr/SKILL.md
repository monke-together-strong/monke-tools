---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request.
---

# Merge PR

A direct "merge this PR" or "merge PR #123" is approval.

## Checklist

1. Resolve the PR using the explicit number or URL when given, or `gh pr view` otherwise. Ask if no single PR resolves. Read its URL and `headRefOid` with `gh pr view <number> --json url,headRefOid`.
2. Run `mt prs untrack <url>` to take ownership from the external-merge poller.
   Save the thread and checkout if printed. Squash-merge with
   `gh pr merge <number> --squash --match-head-commit <sha>`. Use the head
   shepherding verified when available, or the `headRefOid` from step 1.
3. Confirm `gh pr view <number> --json state` reports `MERGED`. If the merge
   fails or remains pending, restore any previous tracking using
   `mt prs track <url> --thread <id> --checkout <path>`. If the head moved,
   report the new head and repeat shepherding when it preceded the merge.
   Wait for `MERGED` before post-merge work.
4. Run [post-merge](../post-merge/SKILL.md) for the merged PR.

Report the PR URL and merge method with post-merge's handoff or report.
