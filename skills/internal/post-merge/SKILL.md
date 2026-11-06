---
name: post-merge
description: Finish a merged PR or an explicitly authorized direct-to-base landing.
---

# Post-Merge

## Resolve the landing

For a PR, use the explicit number or URL; otherwise use `gh pr view`. Ask if no
single PR resolves. Continue only when
`gh pr view <number> --json state,body,mergeCommit,headRefName,headRefOid,baseRefName`
reports `MERGED`. Use `mergeCommit.oid` as `landedCommit`.

For an explicitly authorized direct landing, use the supplied commit and base
branch instead. Record the user's authorization from the task or handoff. In
the repository whose `origin` is the landing destination, run:

```sh
git fetch origin refs/heads/<baseRefName>
git rev-parse --verify '<commit>^{commit}'
git merge-base --is-ancestor <full-commit-sha> FETCH_HEAD
```

Continue only when all commands succeed. Use the full SHA as `landedCommit`.
If authorization, the commit, or the base branch is missing, resolve that gap
before continuing. A local commit or branch name alone is not landing evidence.
Carry any supplied task verification contract, related issues, and source
checkout identity into the handoff.

## Hand off

Post-merge ownership moves to an independent top-level thread. When this thread
was started to run post-merge, continue below. Running this skill is the user's
request for that thread; in T3 Code, start it with `t3_thread_launch`. Finish
here only when no thread tool exists. Otherwise:

1. Start a new thread on GPT 6.1 Sol, high effort, that runs post-merge for the
   landing with this skill, its checkout, `landedCommit`, and `baseRefName`.
   Include the PR URL or the direct-landing authorization. Link it.
2. Finish this thread in the same turn. The deploy gate, contract checks,
   demo repairs and cleanup now belong to the new thread. Recap only what
   remains here outside them: a decision still waiting on the user, or agreed
   work not yet done. When nothing remains, settle this thread with
   `t3_thread_organize` (`action: "settle"`).

## Finish the landing

1. Close relevant issues and sub-issues, such as the Spec issue and its
   breakdown issues.
2. List worktrees and local branches, and
   [clear reproducible generated changes](../../references/internal/CLEANUP_RECOVERY.md#generated-output).
   For a direct landing, set `headRefName` only from the explicitly identified
   source branch, and set `headRefOid` to `landedCommit`. With no source identity,
   skip source cleanup. Always retain the base branch and its checkouts.
   A worktree is a cleanup candidate only when its branch equals `headRefName`,
   `git status --short` is empty, and
   `HEAD` equals `headRefOid`. A local branch is a candidate only when no
   worktree uses it and its tip equals `headRefOid`.
3. Clean up candidates. Use `mt chop <session>` from the source checkout for mt
   Sessions, only when every member is clean and its work has landed; retain
   failed teardowns for recovery. Use `git worktree remove <path>` for ordinary
   worktrees, then delete candidate branches. Never run global `mt cleanup` here.
4. Run `git fetch origin`. In a clean checkout already on `baseRefName`, run
   `git pull --ff-only origin <baseRefName>`. Switch the retained checkout used
   for this landing to `baseRefName`, and leave other checkouts on their branches.

Never discard authored or unclassified changes, trust git ancestry alone for
squash merges, or use `git reset --hard`, `git clean`, or forced worktree removal.

## Load the contracts

A contract names the environment, deployment gate, and checks. Apply both
sources:

- **Repository contract**: root `POST_MERGE.md` at the landed commit, read with
  `git show <landedCommit>:POST_MERGE.md`. When the landed commit has none, use the
  Source checkout's root `POST_MERGE.md` if
  `git -C <source checkout> check-ignore -q POST_MERGE.md` confirms it is
  local-only. Apply the scope it states to this landing.
- **Task contract**: the `## Post-Merge Verification` section of the PR body,
  or the supplied verification contract for a direct landing. It adds
  task-specific checks. `Not required: <reason>` waives only this contract.

When no contract applies and the task has no waiver, inspect the landed change and
task requirements. When existing evidence establishes correctness, finish and
report that evidence and its verification limits. Ask for a missing contract only
when a specific deployment, migration, or target-environment check remains
unverified by that evidence. Name the check and explain the gap.

## Wait for the gate

In T3 Code, rename the thread with `t3_thread_update` to
`Verify #<number>: <subject>`, or `Verify <short-sha>: <subject>` for a direct
landing, where the subject names the behavior under check
and its environment, such as `Verify #123: web embeds on production`.

Run [wait-for-gate](scripts/wait-for-gate.ts) from this skill's directory on the
landed commit, and wait for it to exit:

```sh
bun <skill-dir>/scripts/wait-for-gate.ts --repo <owner/name> --sha <landedCommit> --workflow <name> [--job <name>]
bun <skill-dir>/scripts/wait-for-gate.ts --repo <owner/name> --sha <landedCommit> --status <context>
```

- **Deployment**: the deploy job within its workflow, or the commit status a
  deployer posts, such as one per Railway service.
- **Library release**: the release workflow, then confirm the release PR
  includes this landing's release entry and hand off its URL. When the user asks to
  publish the new version, follow [library release](references/library-release.md).

On `skipped`, the gate did not deploy, so skip its deployment checks. On
`timed_out`, ask before waiting longer. When the gate has no signal the script
can watch, ask before testing.

## Verify

Run every check from each applicable contract and record its result and evidence.

On a failed gate or check, investigate with `$diagnosing-bugs`. For a repo-owned
defect, open a root-cause fix PR with `$pr`, linking the merged PR or landed commit.

## Report

Report the landed commit and base branch, base update, cleanup results, and
contract sources. Include each check's result and evidence, any fix PR or
release PR handoff, skip reasons, and pending items.
