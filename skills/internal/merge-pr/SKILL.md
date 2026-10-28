---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request.
---

# Merge PR

A direct "merge this PR" / "merge PR #123" is approval.

## Checklist

1. Resolve the PR: explicit number or URL wins; otherwise use `gh pr view`. Ask if no single PR resolves.
2. Run `mt prs untrack <url>` so the external-merge poller leaves this PR to you. Merge the PR (squash-merge). Completion requires the merge command to succeed and `gh pr view <number> --json state` to report `MERGED`. If the merge fails or the state is not `MERGED`, such as with auto-merge or a merge queue, track it again with the thread and checkout that `untrack` printed.
3. Run [post-merge](../post-merge/SKILL.md) for the merged PR.

Report the PR URL and merge method with post-merge's report.
