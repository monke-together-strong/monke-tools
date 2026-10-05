---
name: workflow-retro
description: Review agent transcripts and PR history for workflow improvements, with cited evidence, current-state checks, and persistent reports.
disable-model-invocation: true
---

# Workflow retrospective

Run a report-only retrospective in one of two modes:

- **Periodic** — audit eligible transcript deltas and merged PR trajectories across projects.
- **Focused** — review one full transcript selected by native session id; PR analysis is optional.
  Focused reports leave periodic transcript cursors and the periodic time window unchanged.

The evidence lanes are:

- **Session evidence** — friction episodes, direct transcript or repository observations, and
  repeated user asks about how code should be written or changed.
- **PR trajectories** — corrective changes between a PR's opening snapshot and merged outcome.

Group recurring evidence into **durable fixes**, audit whether each problem still exists, and rank
active candidates using the synthesis contract’s prioritization. Keep session actions and PR
corrective patterns in separate report lanes. Periodic runs complete both lanes before synthesis;
a PR lane with explicit gaps is complete. Focused runs may omit the PR lane intentionally.
Let the verified gap, rather than its landing surface, decide the fix: code, tooling, setup, and
infrastructure are first-class alongside skill and workflow changes.

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
bun scripts/run-retrospective.ts collect --session <native-session-id>
```

For a normal run, omit `--since` and `--until`; the collector resumes after the newest committed
report, or uses the previous two weeks on a first run. Reserve explicit bounds for backfills and
replays. Use `--session` for a focused replay, including an already analyzed or active transcript.
The collector reports an unknown or ambiguous session id instead of broadening the selection.
Focused runs default to the selected transcript's start and last activity for optional PR context;
explicit date bounds change that PR window while the full transcript remains the analysis input.

Collect snapshots eligible transcript evidence and emits `runTs`, the resolved window and mode, and one bundle
path per source checkout. When no bundles exist, continue with the organization-scoped PR lane;
stop with "nothing eligible" only when neither lane has evidence available. Recently active
transcripts are deferred until idle; their identities survive an advancing periodic window.

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

For periodic runs, load [the PR analysis contract](references/pr-analysis.md) and execute it for the same `runTs` and
resolved window. Follow its scope, evidence model, fan-out, aggregation, and gap rules exactly.
For focused runs, execute this lane only when PR context is requested.

**Done when** `runs/<runTs>/pr-analysis.md` exists and every in-scope merged PR is represented by
an analysis or an explicit gap, as defined by the contract, or the focused run intentionally omits PR analysis.

## 4. Group recurrence

Immediately before grouping, reread `~/.monke/agent-retrospectives/accepted.md` when it exists.
Exclude any current finding or prior session thread whose only problem is an accepted condition;
do not assign it a candidate id or copy it into the report. Distinct consequences remain eligible,
and the frozen session evidence remains unchanged.

Read the remaining findings and group transcript-derived proposals and repeated asks into
run-local candidates with stable ids (`A1`, `A2`, …). Read `runs/<runTs>/pr-analysis.md` for
context when that file exists, while keeping PR-only observations out of Session Actions.

Treat every repeated ask about code shape, design, quality, or working method as a standards
candidate even when it has no associated friction episode. Correlate these candidates across repo
bundles before deciding whether the implied rule is team-wide or repo-specific. Repeated product
features are not standards candidates merely because their wording recurs.

Then inspect the newest six report sets under `reports/`: each compact retrospective plus its
session and PR source siblings when present. Cross-reference rather than copy forward. Promote a
session thread when this run corroborates prior report sets. Use corroboration to strengthen evidence.
Keep PR-only recurrence in the PR corrective-pattern lane unless session evidence independently supports the same problem.

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

Apply the synthesis contract’s prioritization and weekly-change rules. Load
[the report contract](references/report-contract.md) for presentation and selective `$show-me` use.
For each candidate, inspect relevant existing skills and workflows and choose the synthesis
contract’s workflow disposition. Write the contract's decision-first, four-section
Markdown shape to a synthesis file in the run directory.

**Done when** every candidate appears exactly once in an active or resolved section, every active
candidate has a concrete fix, a closure condition, evidence, confidence, and resolution. Every
recommendation retains session and resolution evidence.

## 7. Commit the report

Refresh mutable current-state evidence for active candidates, then run:

```bash
bun scripts/run-retrospective.ts commit --run-ts <runTs> --synthesis <synthesisFile>
```

Commit validates citations and required report mechanics and writes the Markdown, HTML, and
supporting sources. Periodic commits also freeze accepted session friction and advance transcript
cursors. Invalid findings block commit with repair instructions; fix the findings file and retry
the same run. Its evidence and cursors stay intact until validation succeeds.

**Done when** validation succeeds and the printed report path exists.

## 8. Hand back decisions

Inspect the generated HTML and Markdown,
and present the recommended decisions and coverage gaps.
Each proposal must remain named, evidenced, current-state-checked, and confidence-tagged so the
human can decide what to implement.

**Done when** the user has the evidence and current-state context needed to accept, reject, or
reorder every lead proposal.
