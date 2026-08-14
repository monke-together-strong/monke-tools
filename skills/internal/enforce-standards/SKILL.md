---
name: enforce-standards
description: Review repository standards and ship up to three bounded fix pull requests.
disable-model-invocation: true
---

# Enforce Standards

Pin the latest default-branch tip as `BASE_SHA`. Treat the tree at `BASE_SHA` as
`$code-review`'s candidate snapshot, overriding its normal fixed-point/diff workflow:

- inspect every tracked file exactly as it exists in the `BASE_SHA` tree;
- do not compare `HEAD` against `BASE_SHA` or rely on checkout state to define the candidate;
- run the Standards axis only.

Group findings by standard/rule and common remediation. Give each group confidence, severity,
exact `path:line` evidence, occurrence/file counts, and `structural` or `non-structural` status. A
group is structural when its fix needs an architectural, product, compatibility, schema, migration,
or public-API decision.

Rank non-structural groups by confidence, severity, then impact. Select at most three
high-confidence groups that are bounded and safe to fix. Selected groups must have disjoint file
scopes, share no dependency/generated/migration/lockfile changes, have no ordering dependency, and
apply independently to `BASE_SHA`. Keep only the highest-ranked conflicting group.

For each selected group:

1. Start a fresh branch and isolated worktree at `BASE_SHA`. If reusing the automation's worktree,
   reset it to `BASE_SHA` and switch to a fresh branch before processing the group. Verify that no
   changes from earlier groups remain.
2. Run focused and repository-required checks.
3. Create PR

Create at most three PRs. If isolation or the environment blocks a batch, preserve the work and
report the blocker. If no group qualifies, make no changes.

Report the base, grouped findings and ranking, fixed groups, changed files, checks, blockers, PRs,
and remaining findings. When no high-confidence non-structural group remains, group structural
findings by decision and give concise options, tradeoffs, and the maintainer decision required.
