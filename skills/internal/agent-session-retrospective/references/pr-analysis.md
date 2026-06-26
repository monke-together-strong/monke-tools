# PR analysis contract

This is the single source of truth for the required PR analysis lane in
`agent-session-retrospective`. Load it when `SKILL.md` reaches "PR trajectory analysis".

## Completion bar

The lane is complete when `runs/<runTs>/pr-analysis.md` exists and every in-scope merged PR is
represented by either a per-PR analysis entry or a PR analysis gap with repo, reason, and impact.
If there are no in-scope merged PRs, write the aggregate report and say that directly.

The deterministic brackets are:

```bash
bun scripts/run-retrospective.ts pr-collect --run-ts <runTs> [--repo-cache tmp/agent-retrospective-pr-analysis]
bun scripts/run-retrospective.ts pr-aggregate --run-ts <runTs>
```

`pr-collect` uses a `tmp/agent-retrospective-pr-analysis` repo cache for local git diffs unless
`--repo-cache` overrides it, writes `runs/<runTs>/pr-analysis/manifest.json`, and writes one
`runs/<runTs>/pr-analysis/prs/*.json` work item per PR. The host agent fans out one subagent per
work item, and each subagent writes Markdown to that work item's `analysisPath`. `pr-aggregate`
then writes `runs/<runTs>/pr-analysis.md`.

## Window

Use the resolved retrospective window from `runs/<runTs>/window.json`. PR analysis and commit read
that file; they do not recompute the window.

Include merged PRs whose `mergedAt` lands inside that window.

## Scope

- Resolve the authenticated GitHub user with `gh api user --jq .login`.
- Enumerate repositories with
  `gh repo list monke-together-strong --json nameWithOwner,isArchived,isPrivate`.
- Include every accessible non-archived repository under `monke-together-strong`, including private
  repositories the authenticated user can access.
- Skip archived repositories.
- Query merged PRs authored by the authenticated GitHub user running the skill.
- Do not infer authorship from Agent transcript activity; mixed human, agent, co-author, review,
  and shepherding history makes the GitHub author the boundary.
- If a repository or PR lookup is inaccessible or fails, write a PR analysis gap and continue.

The PR lane is organization-scoped and does not depend on which repositories had eligible Agent
transcript bundles.

## Evidence model

The primary unit is one merged PR analyzed from its PR opening snapshot to its merged outcome. Do not
correlate PRs back to Agent transcripts in this version.

Record the PR opening snapshot confidence:

- `exact` when GitHub exposes a reliable creation-time head ref.
- `inferred` when reconstructed from PR commit times.
- `unknown` when no opening ref can be identified.

The merged outcome is the final PR head SHA and merge commit metadata from GitHub.

The primary evidence is the post-opening delta: the diff from the PR opening snapshot to the merged
outcome. Commit messages are supporting context only, not the primary classification unit.

Prefer local git diff for the post-opening delta. Fetch missing refs when needed. Fall back to
GitHub PR file or patch data only when local git cannot materialize the refs, and mark that lower
confidence in the aggregate report.

## Per-PR agent contract

Fan out one agent per PR. Each per-PR agent receives:

- PR metadata: repo, number, URL, title, `createdAt`, `mergedAt`, base branch, head branch, final
  head SHA, merge commit SHA, commits, changed files, and comments or timeline entries only when
  useful.
- Opening snapshot confidence.
- Post-opening delta.
- Commit messages as supporting context.

Each per-PR agent writes Markdown with these exact headings:

```md
## Opening Snapshot
## Post-Opening Delta
## Corrective Patterns
## Ignored Feature Scope
## Commit Message Reference
```

Per-PR agents identify corrective changes: fixes, tightening, refactors, verification, cleanup, or
removals from the opening snapshot. New feature or scope additions belong under `Ignored Feature
Scope`.

Per-PR agents produce observations and corrective-change patterns, not final durable-fix proposals.

## Aggregate report

The orchestrator aggregates per-PR Markdown into:

```text
~/.monke/agent-retrospectives/runs/<runTs>/pr-analysis.md
```

Put recurring corrective-change patterns first. Include explicit PR analysis gaps with repo, reason,
and impact. The aggregate report is transient run input; commit embeds or summarizes it into the
final retrospective report.

## Validation boundary

Commit performs light mechanical validation only:

- expected PR numbers,
- required headings,
- opening and final refs when known,
- cited commit SHAs that belong to the PR.

Commit does not try to validate every prose claim.
