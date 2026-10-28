---
name: post-merge
description: Finish a merged PR by closing its issues, cleaning up its checkouts, updating the base, and verifying its post-merge contracts.
disable-model-invocation: true
---

# Post-Merge

## Resolve the PR

Use the explicit number or URL; otherwise use `gh pr view`. Ask if no single PR
resolves. Continue only when
`gh pr view <number> --json state,body,mergeCommit,headRefName,headRefOid,baseRefName`
reports `MERGED`.

## Finish the merge

1. Close relevant issues and sub-issues, such as the Spec issue and its
   breakdown issues.
2. List worktrees and local branches. A worktree is a cleanup candidate only
   when its branch equals `headRefName`, `git status --short` is empty, and
   `HEAD` equals `headRefOid`. A local branch is a candidate only when no
   worktree uses it and its tip equals `headRefOid`.
3. Clean up candidates. Use `mt chop <session>` from the source checkout for mt
   Sessions, only when every member is clean and its work has landed; retain
   failed teardowns for recovery. Use `git worktree remove <path>` for ordinary
   worktrees, then delete candidate branches. Never run global `mt cleanup` here.
4. Run `git fetch origin`. In a clean checkout already on `baseRefName`, run
   `git pull --ff-only origin <baseRefName>`. Switch a retained PR checkout to
   `baseRefName`, and leave other checkouts on their branches.

Never delete dirty work, trust git ancestry alone for squash merges, or use
`git reset --hard`, `git clean`, or forced worktree removal.

## Load the contracts

A contract names the environment, deployment gate, and checks. Apply both
sources:

- **Repository contract**: root `POST_MERGE.md` at the merge commit, read with
  `git show <mergeCommit>:POST_MERGE.md`, when present. It covers every merged
  PR within the scope it states.
- **PR contract**: the `## Post-Merge Verification` section of the PR body. It
  adds PR-specific checks. `Not required: <reason>` waives only this section.

When no contract applies and the PR has no waiver, inspect the merged change and
task requirements. Skip with a reason when pre-merge evidence is sufficient (for
example, docs or a local CLI cleanup). If correctness depends on deployment,
migration, or the target environment, ask for the missing contract.

## Wait for the gate

In T3 Code, rename the thread with `t3_thread_update` to
`Verify #<number>: <subject>`, where the subject names the behavior under check
and its environment, such as `Verify #123: web embeds on production`.

Run [wait-for-gate](scripts/wait-for-gate.ts) on the merge commit and wait for it
to exit:

```sh
bun scripts/wait-for-gate.ts --repo <owner/name> --sha <mergeCommit> --workflow <name> [--job <name>]
bun scripts/wait-for-gate.ts --repo <owner/name> --sha <mergeCommit> --status <context>
```

- **Deployment**: the deploy job within its workflow, or the commit status a
  deployer posts, such as one per Railway service.
- **Library release PR**: the release workflow, then confirm the release PR
  includes this PR's release entry and hand off its URL. When the user asks to
  publish the new version, follow [library release](references/library-release.md).

On `skipped`, the gate did not deploy, so skip its deployment checks. On
`timed_out`, ask before waiting longer. When the gate has no signal the script
can watch, ask before testing.

## Verify

Run every check from each applicable contract and record its result and evidence.

On a failed gate or check, investigate with `$diagnosing-bugs`. For a repo-owned
defect, open a root-cause fix PR with `$pr`, linking the merged PR.

## Settle and report

In T3 Code, settle the thread with `t3_thread_organize` once nothing remains
open in it, such as a fix PR, a release PR handoff, or a pending question.

Report the base update, removals, skipped cleanup, contract sources, each check's
result and evidence, any fix PR or release PR handoff, and any skip reason.
