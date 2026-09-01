---
name: agent-session-retrospective
description: Review agent sessions and merged PR trajectories for recurring friction, standards gaps, and durable fixes.
disable-model-invocation: true
---

# Agent session retrospective

Run a report-only audit of two evidence lanes:

- **Session evidence** — friction episodes plus repeated user asks about how code should be written
  or changed.
- **PR trajectories** — corrective changes between a PR's opening snapshot and merged outcome.

Group recurring evidence into **durable fixes**, audit whether each problem still exists, and rank
active candidates by **value × recurrence**. Keep session actions and PR corrective patterns in
separate report lanes. Complete both lanes before synthesis; a PR lane with explicit gaps is
complete, while a transcript-only result is degraded and must name the missing PR evidence.
Let the verified gap, rather than its landing surface, decide the fix: code, tooling, setup, and
infrastructure are first-class alongside skill and workflow changes.

A repeated code-shape, design, or quality ask is evidence even when no task failed and the agent
hit no blocker. Treat it as a standards candidate, then check both the Team coding baseline and the
repo's coding standards. Propose a Team-baseline change when the rule is generally applicable
across repos, and a repo-standard change when it depends on that repo's stack, architecture, or
domain. Generality decides scope; recurrence supplies evidence.

Keep the run report-only: inspect, verify, and propose. The human owns every resulting change.

Run `scripts/run-retrospective.ts` with `bun` from this skill's directory. Persistent state lives
under `~/.monke/agent-retrospectives/`.

## Accepted issues

At the start of every run, read `~/.monke/agent-retrospectives/accepted.md` when it exists and
capture its entries for session-bundle prompts. This file is user-owned; never edit it during a
retrospective. An entry suppresses only the condition it names. A distinct consequence outside
that boundary remains eligible. Keep collection unchanged so the frozen evidence stays complete.

## 1. Collect session evidence

```bash
bun scripts/run-retrospective.ts collect [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--idle-minutes N]
```

For a normal run, omit `--since` and `--until`; the collector resumes after the newest committed
report, or uses the previous two weeks on a first run. Reserve explicit bounds for backfills and
replays.

Collect freezes eligible transcript deltas and emits `runTs`, the resolved window, and one bundle
path per source checkout. When no bundles exist, continue with the organization-scoped PR lane;
stop with "nothing eligible" only when neither lane has evidence available.

**Done when** the emitted values, including an empty bundle list, are captured and
`runs/<runTs>/window.json` exists.

## 2. Analyze session bundles

For every bundle, concurrently dispatch one subagent with the bundle path and
[the finding contract](references/finding-schema.md). Each subagent writes the required sibling
`<repoHash>.findings.json`, including empty arrays when it finds nothing. Use each transcript's
origin and parent link to read delegated side chats as part of their task lineage. Include the
captured accepted entries in every prompt; the contract defines how workers apply them.

**Done when** every bundle has one schema-conforming findings file.

## 3. Analyze PR trajectories

Load [the PR analysis contract](references/pr-analysis.md) and execute it for the same `runTs` and
resolved window. Follow its scope, evidence model, fan-out, aggregation, and gap rules exactly.

**Done when** `runs/<runTs>/pr-analysis.md` exists and every in-scope merged PR is represented by
an analysis or an explicit gap, as defined by the contract.

## 4. Group recurrence

Immediately before grouping, reread `~/.monke/agent-retrospectives/accepted.md` when it exists.
Exclude any current finding or prior session thread whose only problem is an accepted condition;
do not assign it a candidate id or copy it into the report. Distinct consequences remain eligible,
and the frozen session evidence remains unchanged.

Read the remaining findings and group transcript-derived proposals and repeated asks into
run-local candidates with stable ids (`A1`, `A2`, …). Read `runs/<runTs>/pr-analysis.md` for
context, while keeping PR-only observations out of Session Actions.

Treat every repeated ask about code shape, design, quality, or working method as a standards
candidate even when it has no associated friction episode. Correlate these candidates across repo
bundles before deciding whether the implied rule is team-wide or repo-specific. Repeated product
features are not standards candidates merely because their wording recurs.

Then inspect the newest six report sets under `reports/`: each compact retrospective plus its
session and PR source siblings when present. Cross-reference rather than copy forward. Promote a
session thread when this run corroborates prior report sets. A corroborated thread outranks a fresh
one-off even when its earlier evidence was low-signal. Keep PR-only recurrence in the PR
corrective-pattern lane unless session evidence independently supports the same problem.

**Done when** every current session proposal, repeated-ask cluster, and standards candidate, and
every prior session thread considered for promotion, belongs to one candidate, is explicitly
retained as source-only evidence, or is excluded by an accepted entry.

## 5. Audit current resolution

Load [the synthesis contract](references/synthesis-contract.md). For every candidate, inspect the
current authoritative surface that could resolve it. Treat transcript and prior-report claims as
leads; current code, guidance, configuration, tracker state, or direct verification establishes
resolution.

For every standards candidate, explicitly inspect the active Global agent instructions,
[the Team coding baseline](../../references/internal/CODING_STANDARDS.md), and documented repo
coding standards such as `AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, or `CONTRIBUTING.md`.
Record whether the requested rule is absent, only partially expressed, already covered, or not a
coding standard. An already-covered recurring ask points to an execution or enforcement gap rather
than another copy of the rule.

**Done when** every candidate has one resolution status, current-state evidence, and a remaining
gap; every standards candidate also has explicit global and repo coverage evidence. Classify
recurrence after a verified resolution as an active regression.

## 6. Synthesize decisions

Rank active candidates by **value × recurrence**. For each one, inspect relevant existing skills and
workflows and choose the synthesis contract's `create-skill`, `create-workflow`, `update`,
`combine`, or `no-skill` disposition. Write the contract's exact problem-first, four-section
Markdown shape to a synthesis file in the run directory.

**Done when** every candidate appears exactly once in an active or resolved section, every active
candidate has exactly one standards disposition and one skill/workflow disposition, and every
recommendation retains session and resolution evidence.

## 7. Commit the report

Refresh mutable current-state evidence for active candidates, then run:

```bash
bun scripts/run-retrospective.ts commit --run-ts <runTs> --synthesis <synthesisFile>
```

Commit validates citations and required report mechanics, freezes accepted session friction, and
writes the report set. Load [the report contract](references/report-contract.md) only when report
shape or disk layout needs inspection.

**Done when** the printed report path exists and the dropped citation counts have been surfaced; a
high count means subagents cited evidence absent from their bundles.

## 8. Hand back decisions

Read the compact report and present its lead proposals, coverage gaps, and dropped citation counts.
Each proposal must remain named, evidenced, current-state-checked, and confidence-tagged so the
human can decide what to implement.

**Done when** the user has the evidence and current-state context needed to accept, reject, or
reorder every lead proposal.
