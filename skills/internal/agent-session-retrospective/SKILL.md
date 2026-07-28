---
name: agent-session-retrospective
description: Use only when the user explicitly asks for an agent or session retrospective. Review local Codex + Claude sessions and merged PRs, verify current resolution state, and propose evidenced durable fixes plus skill and workflow opportunities. Never invoke proactively.
disable-model-invocation: true
---

# Agent session retrospective

Find where agents hit **friction** — an agent hit an issue, then had to do something
else — and where the same user ask recurs across sessions. Audit whether each grouped
problem still exists, then propose the highest-value **durable fixes** a human executes,
ranked by **value × recurrence**, including explicit skill and workflow opportunities.
Evidence → recurring friction → durable fix, **wherever it lives**: a missing `mt spawn`
step the agent works around every run, a flaky query, or a broken setup is as valuable as
a skill or AGENTS.md change — value, not where the fix lands, decides what leads. Report-only:
return a decision report and leave every proposed change for a human to execute.

The work has two required evidence lanes:

1. **Agent transcript analysis** — deterministic collect/commit brackets around per-repo subagents
   that read transcripts and find friction.
2. **PR analysis** — a host-native orchestrator that analyzes merged **Implementation
   trajectories** from PR opening snapshot to merged outcome.

Run both lanes before synthesis. The final report set keeps Agent transcript actions and PR
trajectory patterns in separate lanes; transcript-only synthesis is a degraded result and must say
what PR analysis was missing.
The PR lane's operational contract lives in
[references/pr-analysis.md](references/pr-analysis.md); load it when you reach step 3.

This skill needs `bun` and runs its script from this skill's own directory. The script lives
at `scripts/run-retrospective.ts`; all state lives under `~/.monke/agent-retrospectives/`.
By default, a retrospective run analyzes the window from the previous completed retrospective run
to now. The first run defaults to the previous two weeks. Use explicit `--since` / `--until` only
for backfills or bounded replays.

## 1. Collect

Run the collect bracket from this skill's directory:

```bash
bun scripts/run-retrospective.ts collect [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--idle-minutes N]
```

If `--since` is omitted, resolve it to the previous completed retrospective run, or the previous
two weeks when no completed run exists. If `--until` is omitted, use now.
Use the newest committed report under `reports/` as the previous completed run cursor.

It normalizes every eligible Agent transcript, groups Agent transcripts by **Source checkout** (one
**Primary repo** per transcript plus any **Secondary repos** its tool calls touched), and writes one
bundle per Source checkout. An Agent transcript is eligible once it has been idle past the cutoff
(default 45 min) and is either new or has grown since it was last frozen —
**analyze-once-and-freeze** means frozen friction is never recomputed, only appended to on resume.

Collect prints JSON with `runTs`, `window: { since, until, sinceSource, untilSource }`, and a
`bundles` list. `sinceSource` is `explicit`, `previous-report`, or `first-run-default`;
`untilSource` is `explicit` or `now`. **Done when** you have the `runTs`, resolved window, and
per-repo bundle paths. It also writes the resolved window to `runs/<runTs>/window.json` so PR
analysis and commit use the same boundary. If `bundles` is empty and no repository set is available
for PR analysis, stop and report that nothing was eligible.

## 2. Fan out — one subagent per bundle

Spawn one subagent per bundle, concurrently. Give each subagent its bundle path and
[references/finding-schema.md](references/finding-schema.md). Each subagent:

- reads its bundle JSON (normalized Agent transcripts with citable `t<n>` turn refs),
- analyzes only turns at or past each session's `firstNewTurnIndex`,
- finds **friction episodes** and clusters **repeated asks** freely from the prose,
- writes its findings JSON to the bundle's sibling path: replace `<repoHash>.json` with
  `<repoHash>.findings.json` in the same run directory.

**Done when** every bundle has a sibling `.findings.json` file. A subagent that finds nothing
still writes a findings file with empty arrays.

## 3. PR trajectory analysis — required

Load [references/pr-analysis.md](references/pr-analysis.md), then run the required PR analysis lane
for the same resolved retrospective window. The PR lane is organization-scoped and independent of
which repositories had eligible Agent transcript bundles. Use the reference as the single source of truth
for repository scope, author scope, opening snapshots, post-opening deltas, per-PR headings, gap
reporting, aggregate report shape, and validation boundary.

Start the PR lane from this skill's directory:

```bash
bun scripts/run-retrospective.ts pr-collect --run-ts <runTs> [--repo-cache tmp/agent-retrospective-pr-analysis]
```

`pr-collect` reads `runs/<runTs>/window.json`, resolves the GitHub user, enumerates in-scope
repositories and merged PRs, uses a `tmp/agent-retrospective-pr-analysis` repo cache for local git
diffs unless `--repo-cache` overrides it, writes `runs/<runTs>/pr-analysis/manifest.json`, and
writes one `runs/<runTs>/pr-analysis/prs/*.json` work item per PR. Each work item includes the path
where its per-PR agent must write Markdown: `analysisPath`.

Spawn one subagent per work item, concurrently. Give each subagent the work item JSON path and
[references/pr-analysis.md](references/pr-analysis.md). Each subagent writes Markdown to the
work item's `analysisPath` with the exact headings required by the reference.

After every per-PR subagent has written its analysis, aggregate the lane:

```bash
bun scripts/run-retrospective.ts pr-aggregate --run-ts <runTs>
```

**Done when** `runs/<runTs>/pr-analysis.md` exists and every in-scope merged PR is represented by
either a per-PR analysis entry or an explicit PR analysis gap.

## 4. Group — this run plus prior reports

Read every per-repo findings file and group transcript-derived durable fixes and repeated asks into
run-local candidate actions. Give each candidate a stable id (`A1`, `A2`, …). Also read
`runs/<runTs>/pr-analysis.md` so you understand the PR lane, but do not fold one-off PR trajectory
observations into Session Actions. The compact report surfaces recurring PR corrective patterns
separately from `pr-analysis.md`, and the full PR lane remains available in PR sources.

Then read the **newest few report sets** under `reports/` (cap ~6): each
`<runTs>-retrospective.md` compact report plus sibling `<runTs>-session-sources.md` and
`<runTs>-pr-sources.md` files when present. Together they are this skill's memory of patterns
already named. **Cross-reference, don't copy forward**: match this run's transcript findings
against session-action threads in those report sets and **promote** any thread recurring across
them — a pattern corroborated across report sets outranks a fresh one-off, even when each prior
sighting was low-signal on its own. Keep PR-only recurrence in the PR repeated-corrective-patterns
lane unless the same issue also appears in transcript/session findings. Recurrence spans both this
window and prior report sets.

**Done when** every current per-repo proposal and repeated-ask cluster, plus every prior-report
thread considered for promotion, is assigned to one candidate or explicitly retained only as
source evidence.

## 5. Resolution audit — current state before ranking

Load [references/synthesis-contract.md](references/synthesis-contract.md). For every candidate,
inspect the current authoritative surface that could have resolved it. A transcript or old report
saying a change landed is a lead to verify, not proof that the current state still contains the
fix. Record the required resolution status and evidence before ranking candidates.

**Done when** every candidate has one resolution status, current-state evidence, and a residual gap;
any recurrence after a verified resolution is identified as a regression.

## 6. Synthesis — active actions and reusable opportunities

Rank only active candidates by **value × recurrence**. For every active candidate, inspect relevant
existing skills and workflows, then choose the synthesis contract's `create-skill`,
`create-workflow`, `update`, `combine`, or `no-skill` disposition. Write the exact three-section
Markdown shape from [references/synthesis-contract.md](references/synthesis-contract.md) to a
synthesis file in the run directory.

**Done when** every candidate appears once in the active or resolved section, every active action
has one skill/workflow disposition, and every recommendation retains its session and resolution
evidence.

## 7. Commit

Refresh mutable current-state evidence for active candidates as required by the synthesis contract,
then run the commit bracket:

```bash
bun scripts/run-retrospective.ts commit --run-ts <runTs> --synthesis <synthesisFile>
```

It validates every cited turn ref and episode ref against the bundle (hallucinated citations are
dropped and counted), rejects synthesis missing a required section, lightly validates PR analysis
mechanics, freezes each Agent transcript's friction, and writes the action-first report. See
[references/report-contract.md](references/report-contract.md) for the report shape. **Done when**
commit prints the report path; surface the `dropped` counts — a high drop count means the
subagents are citing turns that do not exist.

## 8. Hand back

Read the report and surface the lead proposals to the user. Every proposal is a named, evidenced,
current-state-checked, confidence-tagged thing a human decides on; leave application to the human.
