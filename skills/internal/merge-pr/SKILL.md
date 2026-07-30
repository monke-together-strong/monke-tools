---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request, then clean up only proven-clean local PR worktrees or branches, switch to the PR base branch, and pull latest.
---

# Merge PR

A direct "merge this PR" / "merge PR #123" is approval.

## Checklist

1. Resolve the PR: explicit number or URL wins; otherwise use `gh pr view`. Ask if no single PR resolves.
2. Before merging, record `number`, `url`, `headRefName`, `headRefOid`, and `baseRefName`; list worktrees and local branches. Mark a worktree cleanup candidate only when its branch equals `headRefName`, `git status --short` is empty, and `HEAD` equals `headRefOid`. Mark a local branch cleanup candidate only when no worktree uses it and its tip equals `headRefOid`.
3. Merge the PR (squash-merge). Completion requires the merge command to succeed and `gh pr view <number> --json state` to report `MERGED`.
4. Close relevant issues and sub-issues - for instance, PRD issue, and breakdown issues of that PRD.
5. Clean up only proven candidates: `git worktree remove <path>` for separate clean PR worktrees; delete the local PR branch only when unused and still at `headRefOid`. If the current checkout is the PR branch, keep it as the surviving checkout and switch it to `baseRefName`.
6. Update the surviving checkout: use the checkout that remains open for the user after cleanup; run `git fetch origin`, `git switch <baseRefName>` if needed, then `git pull --ff-only origin <baseRefName>`.
7. Execute the post-merge contract from the merged PR body.
   - Use only `## Post-Merge Verification` from `gh pr view <number> --json body` as the contract source.
   - If the section says `Not required: <reason>`, report that reason and skip verification.
   - If the section is missing or lacks the environment, deployment gate, or checks, pause and ask the user for the missing contract.
   - Wait for the deployment gate when the section gives a discoverable signal; otherwise ask before testing.
   - Run the listed checks and record pass/fail evidence for each one.
8. Run `mt cleanup` when `mt` is available; report if it is unavailable or fails.

Never delete dirty work, trust git ancestry alone for squash merges, assume the base is `main`, or use `git reset --hard`, `git clean`, or forced worktree removal. Report the PR URL, merge method, base update, removals, post-merge verification, and any skipped cleanup.
