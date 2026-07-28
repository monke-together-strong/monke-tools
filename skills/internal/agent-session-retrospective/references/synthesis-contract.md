# Session synthesis contract

This contract owns the post-analysis candidate lifecycle and the Markdown passed to `commit
--synthesis`. Load it after transcript findings have been grouped and before any candidate is
ranked.

## Resolution audit

Assign each grouped candidate a stable run-local id (`A1`, `A2`, …), then inspect its current
authoritative state. Transcript claims and prior reports are discovery evidence, not current-state
proof. Check the surface that could resolve the candidate: current default-branch code, installed
or source skill guidance, merged PRs, issue state, configuration, or the smallest relevant
verification.

Record:

- `Resolution: unresolved | partially-resolved | resolved | superseded | unknown`
- `Checked-at:` timestamp
- `Checked-against:` concrete paths, refs, issues, PRs, or commands
- `Resolution evidence:` what the current state proves
- `Residual gap:` the remaining problem, or `none`

An open tracker is `unresolved`, not resolved. A completed change is `resolved` only when the
current authoritative state contains it and the relevant behavior is verified where practical.
Use `unknown` when current state cannot be inspected. If evidence recurs after a verified
resolution, classify the candidate as an active regression.

## Required synthesis shape

The synthesis file contains these three level-three headings exactly once and in this order.
`commit` rejects a file that omits or duplicates one.

### Active Actions

Include only `unresolved`, `partially-resolved`, and `unknown` candidates, ranked by **value ×
recurrence**. For a partially resolved candidate, recommend only its residual gap. Keep an unknown
candidate's uncertainty visible rather than presenting its recommendation as settled.

Each action begins with `#### <id> — <name>` and includes:

```text
Target: <code | tooling | setup | infra | deps | docs | agent-skill | AGENTS.md | CLAUDE.md | hook | preflight>
Confidence: <high | medium | low>
Resolution: <unresolved | partially-resolved | unknown>
Checked-at: <timestamp>
Checked-against: <current-state evidence inspected>
Resolution evidence: <what that evidence proves>
Residual gap: <what remains>
Session evidence: <repo/session/episode refs supporting recurrence>

<concrete durable fix>
```

Write `_No active actions._` when empty.

### Skill & Workflow Opportunities

Give every active action exactly one disposition after inspecting relevant existing skills and
workflows:

```text
#### <action id> — <short opportunity name>
Disposition: <create-skill | create-workflow | update | combine | no-skill>
Candidates: <existing skills/workflows considered, or "none found">
Evidence: <the active action and session evidence that justify the decision>
Rationale: <why this disposition is the smallest durable response>
```

`create-skill` and `create-workflow` name a reusable boundary and trigger, not merely a document
title. `update` names the existing owner. `combine` names every overlapping owner and the unified
boundary. `no-skill` explains why code, tooling, setup, or another target is the better durable
fix.

Write `_No skill or workflow opportunities._` only when there are no active actions.

### Resolved or Superseded

Preserve candidates suppressed from active ranking:

```text
#### <id> — <name>
Resolution: <resolved | superseded>
Checked-at: <timestamp>
Checked-against: <current-state evidence inspected>
Resolution evidence: <what fixed it or what replaced it>
Session evidence: <the historical evidence retained for recurrence memory>
```

Write `_No resolved or superseded candidates._` when empty.

## Completion criteria

The synthesis is complete when every grouped candidate appears exactly once in **Active Actions**
or **Resolved or Superseded**, and every active action has exactly one entry in **Skill & Workflow
Opportunities**. Immediately before commit, refresh any active candidate whose issue, PR, branch,
or installed-guidance evidence may have changed during the run.
