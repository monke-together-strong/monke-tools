---
name: agent-session-retrospective
description: Use only when the user explicitly asks for an agent or session retrospective. Study local Codex + Claude agent transcripts for recurring friction and repeated user asks, then emit report-only, evidence-grounded proposals for the highest-value durable fixes. Never invoke proactively.
disable-model-invocation: true
---

# Agent session retrospective

Find where agents hit **friction** — an agent hit an issue, then had to do something
else — and where the same user ask recurs across sessions, then propose the
highest-value **durable fixes** a human executes, ranked by **value × recurrence**.
Evidence → recurring friction → durable fix, **wherever it lives**: a missing `mt spawn`
step the agent works around every run, a flaky query, or a broken setup is as valuable as
a skill or AGENTS.md change — value, not where the fix lands, decides what leads. Report-only:
never auto-edit, never draft artifacts.

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

## 4. Synthesis — this run plus prior reports

Read every per-repo findings file, then synthesize the **Session Actions**: transcript-derived
cross-repo durable fixes and repeated-ask fixes that recur across repos (e.g. "stop minting
`codex/` branches everywhere"). Rank them by **value × recurrence**. Also read
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

Write the result as Markdown to a synthesis file (e.g. in the run directory), ranked by **value ×
recurrence**. Lead each proposal with a `Target:` line — *where the fix lands*: `code` / `tooling`
/ `setup` / `infra` / `deps` / `docs` / `agent-skill` / `AGENTS.md` / `CLAUDE.md` / `hook` /
`preflight`, or `already-tracked:<ref>` / `none` only when there is genuinely no new fix to make —
and a `Confidence:` line. **Done when** the synthesis file is written and any cross-report
recurrence is promoted into it.

## 5. Commit

Run the commit bracket:

```bash
bun scripts/run-retrospective.ts commit --run-ts <runTs> --synthesis <synthesisFile>
```

It validates every cited turn ref and episode ref against the bundle (hallucinated citations are
dropped and counted), lightly validates PR analysis mechanics when available, freezes each Agent
transcript's friction, and writes the action-first report. See
[references/report-contract.md](references/report-contract.md) for the report shape. **Done when**
commit prints the report path; surface the `dropped` counts — a high drop count means the
subagents are citing turns that do not exist.

## 6. Hand back

Read the report and surface the lead proposals to the user. Every proposal is a named, evidenced,
confidence-tagged thing a human decides on — propose, never apply.
