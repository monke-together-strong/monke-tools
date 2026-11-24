---
name: post-merge
description: Finish a PR after it merges, or a commit pushed directly to the base branch.
---

# Post-merge

## Resolve the PR

For a PR, use the explicit number or URL when given, or `gh pr view` otherwise. Ask if no single PR
resolves. Continue only when
`gh pr view <number> --json state,body,mergeCommit,headRefName,headRefOid,baseRefName`
reports `MERGED`.

For an authorized direct push, there is no PR. Use the pushed commit's full SHA
as `mergeCommit` and the branch it was pushed to as `baseRefName`. Continue only
when it has landed:

```sh
git fetch origin <baseRefName> && git merge-base --is-ancestor <mergeCommit> FETCH_HEAD
```

Set `headRefName` and `headRefOid` to the source branch and the commit pushed
from it. With no known source branch, or when it is `baseRefName`, skip worktree
and branch cleanup. Elsewhere, read "the PR" as the pushed commit: link the
commit where a step links the PR, use its checkout as the PR checkout, and use
the task's own verification requirements as the PR contract.

## Load the contracts

A contract names the environment, deployment gate, and checks. Apply both
sources:

- **Repository contract**: root `POST_MERGE.md` at the merge commit, read with
  `git show <mergeCommit>:POST_MERGE.md`. When the merge commit has none, use the
  Source checkout's root `POST_MERGE.md` if
  `git -C <source checkout> check-ignore -q POST_MERGE.md` confirms it is
  local-only. It covers every merged PR within the scope it states.
- **PR contract**: the `## Post-Merge Verification` section of the PR body. It
  adds PR-specific checks. `Not required: <reason>` waives only this section.

When no contract applies and the PR has no waiver, inspect the merged change and
task requirements. When existing evidence establishes correctness, proceed with
routine cleanup and report that evidence and its verification limits. Ask for a
missing contract only when a specific deployment, migration, or target-environment
check remains unverified by that evidence. Name the check and explain the gap.

## Hand off

Cleanup removes the PR checkout, and a thread bound to a removed checkout can
never open again. Post-merge runs from a thread whose workspace **survives**
cleanup: the Source checkout, or any checkout outside the cleanup candidates.
Read this thread's workspace with `t3_worktree_status`.

When this thread's workspace survives, continue below if only routine cleanup
remains or this thread was started to run post-merge. Without a thread tool,
continue below and run every command from the Source checkout.

Otherwise, move post-merge ownership to a new top-level thread. Running this
skill is the user's request for that thread. In T3 Code, start it with
`t3_thread_launch`:

1. Start a new thread on the post-merge model (`mt models get post-merge`) in
   the Source checkout (`workspaceStrategy: { type: "root" }`). Prompt it with
   the PR (or the pushed commit with its base and source branches), the PR
   checkout path, and the path to this `SKILL.md`. Include the new thread link
   in your reply.
2. Finish this thread in the same turn. The deployment gate, contract checks,
   follow-up fixes, and cleanup now belong to the new thread. Recap only what
   remains here outside them: a decision still waiting on the user, or agreed
   work not yet done. When nothing remains, settle this thread with
   `t3_thread_organize` (`action: "settle"`).

## Finish the merge

1. Close relevant issues and sub-issues, such as the Spec issue and its
   breakdown issues.
2. List worktrees and local branches, and
   [clear reproducible generated changes](../../references/internal/CLEANUP_RECOVERY.md#generated-output).
   A worktree is a cleanup candidate only when its branch equals `headRefName`,
   `git status --short` is empty, and
   `HEAD` equals `headRefOid`. A local branch is a candidate only when no
   worktree uses it and its tip equals `headRefOid`.
3. Clean up candidates from the Source checkout. For Sessions, run
   `mt chop <session>` only when every member is clean and its work has landed,
   and retain failed teardowns for recovery. For Ordinary worktrees, run
   `mt chop <path>`. Then delete candidate branches. Never run global
   `mt cleanup` here.
4. Run `git fetch origin`. In a clean checkout already on `baseRefName`, run
   `git pull --ff-only origin <baseRefName>`. Switch a retained PR checkout to
   `baseRefName`, and leave other checkouts on their branches.

Never discard authored or unclassified changes, trust git ancestry alone for
squash merges, or use `git reset --hard`, `git clean`, or forced worktree removal.

## Wait for the gate

Use the deployment or release gate named by the applicable contract or task
requirement. Continue to **Verify** when its checks need no gate.

In T3 Code, rename the thread with `t3_thread_update` to
`Verify #<number>: <subject>`, or `Verify <short-sha>: <subject>` for a direct
push. Name the behavior under check and its environment in `<subject>`, such as
`Verify #123: web embeds on production`.

Use `mt prs wait-for-gate --help` for gate selectors. Wait on the merge commit.
For Railway, check the commit status context of each service the change deploys.

For a library Release PR, wait for the release workflow and confirm the Release
PR includes this change's Release entry. Hand off its URL. When the user asks to
publish the new version, follow [library release](references/library-release.md).

On `skipped`, the gate did not deploy, so skip its deployment checks. On
`timed_out`, ask before waiting longer. When the gate has no signal `mt prs wait-for-gate`
can watch, ask before testing.

## Verify

Run every check from each applicable contract and record its result and evidence.

On a failed gate or check, investigate with `$diagnosing-bugs`. For a repo-owned
defect, open a root-cause fix PR with `$pr`, linking the merged PR.

## Report

Report the base update, removals, skipped cleanup, contract sources, each check's
result and evidence, any fix PR or Release PR handoff, skip reasons, and pending
items.

When no user decision or agreed work remains, settle the current thread with
`t3_thread_organize` (`action: "settle"`).
