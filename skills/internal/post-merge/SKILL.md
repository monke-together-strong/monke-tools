---
name: post-merge
description: Verify a merged PR against its repository and PR post-merge contracts.
disable-model-invocation: true
---

# Post-Merge

## Resolve the PR

Use the explicit number or URL; otherwise use `gh pr view`. Ask if no single PR
resolves. Continue only when `gh pr view <number> --json state,body,mergeCommit`
reports `MERGED`.

## Load the contracts

A contract names the environment, deployment gate, and checks. Apply both
sources:

- **Repository contract**: root `POST_MERGE.md` when present. It covers every
  merged PR within the scope it states.
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

Report the contract sources, each check's result and evidence, any fix PR or
release PR handoff, and any skip reason.
