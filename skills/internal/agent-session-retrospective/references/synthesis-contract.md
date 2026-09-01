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
- `Current-state evidence:` what the current state proves
- `Remaining gap:` the remaining problem, or `none`

For a candidate grounded in repeated asks about code shape, design, quality, or working method,
also audit the active Global agent instructions, the Team coding baseline, and the applicable repo
coding standards. This audit determines whether the implied rule is absent, partial, already
covered, or not a coding standard; an existing rule redirects the candidate toward execution or
enforcement instead of duplicating guidance.

An open tracker is `unresolved`, not resolved. A completed change is `resolved` only when the
current authoritative state contains it and the relevant behavior is verified where practical.
Use `unknown` when current state cannot be inspected. If evidence recurs after a verified
resolution, classify the candidate as an active regression.

## Required synthesis shape

The synthesis file contains these four level-three headings exactly once and in this order.
`commit` rejects a file that omits or duplicates one.

### Active Actions

Include only `unresolved`, `partially-resolved`, and `unknown` candidates, ranked by **value ×
recurrence**. For a partially resolved candidate, recommend only its remaining gap. Keep an unknown
candidate's uncertainty visible rather than presenting its recommendation as settled.

Each action begins with `#### <id> — <problem-focused name>`. Name the failure or risk a reader
needs to understand, not the fix they should apply. Put the decision summary before audit metadata
so the problem is understandable without reverse-engineering the evidence. Include these fields in
this exact order:

```text
Problem: <plain-language statement of what is wrong now>
Impact: <the concrete cost, failure, or risk>
Cause: <why the current system permits the problem>
Proposed fix: <the concrete durable fix>

Target: <code | tooling | setup | infra | deps | docs | agent-skill | AGENTS.md | CLAUDE.md | hook | preflight>
Confidence: <high | medium | low>
Resolution: <unresolved | partially-resolved | unknown>
Checked-at: <timestamp>
Checked-against: <current-state evidence inspected>
Current-state evidence: <what that evidence proves>
Remaining gap: <what remains>
Session evidence: <repo/session/episode refs supporting recurrence>
```

The first nonblank line after the action heading must be `Problem:`. Make its first sentence
understandable without the metadata or source files. Lead with the observable mismatch or failure;
introduce specialized terms only after the plain-language statement and define them when needed.
Keep `Problem`, `Impact`, and `Cause` distinct. For a partially resolved candidate, all four summary
fields describe only the remaining gap. Keep an unknown candidate's uncertainty visible rather than
presenting its cause or fix as settled.

Write `_No active actions._` when empty.

### Standards Opportunities

Give every active action exactly one disposition after inspecting both team-wide/global and
repo-specific coding guidance:

```text
#### <action id> — <short standards opportunity name>
Disposition: <add-team-baseline | add-repo-standard | update-team-baseline | update-repo-standard | already-covered | not-a-standard>
Standards checked: <Global agent instructions, Team coding baseline, and repo standards inspected>
Evidence: <the recurring asks and current standards coverage>
Rationale: <why this is the narrowest authoritative standards surface, or why no standards change belongs here>
Proposed wording: <a concise rule, or "n/a">
```

Use the Team coding baseline for a generally applicable rule and repo coding standards for a rule
that depends on one repo's stack, architecture, or domain. Generality decides scope; the number of
repos is evidence, not a mechanical threshold. Use `already-covered` when current guidance states
the rule adequately, and `not-a-standard` for product requirements, one-off fixes, or problems
better prevented in code or tooling.

Write `_No standards opportunities._` only when there are no active actions.

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
Current-state evidence: <what fixed it or what replaced it>
Session evidence: <the historical evidence retained for recurrence memory>
```

Write `_No resolved or superseded candidates._` when empty.

## Completion criteria

The synthesis is complete when every grouped candidate appears exactly once in **Active Actions**
or **Resolved or Superseded**, and every active action has exactly one entry in **Standards
Opportunities** and **Skill & Workflow Opportunities**. Every active action starts with a
plain-language problem and includes the required summary and audit fields in order. Immediately
before commit, refresh any active candidate whose issue, PR, branch, or installed-guidance evidence
may have changed during the run.
