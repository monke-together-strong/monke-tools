---
name: agent-session-retrospective
description: Study local Codex + Claude agent transcripts for recurring friction and repeated user asks, then emit report-only, evidence-grounded proposals for the highest-value durable fixes — wherever they land (code, tooling/setup, infra, deps, docs, or the agent harness). Use when the user wants a retrospective on their agent sessions, asks what keeps going wrong or getting redone across sessions, or wants durable fixes grounded in transcript evidence.
---

# Agent session retrospective

Find where agents hit **friction** — an agent hit an issue, then had to do something
else — and where the same user ask recurs across sessions, then propose the
highest-value **durable fixes** a human executes, ranked by **value × recurrence**.
Evidence → recurring friction → durable fix, **wherever it lives**: a missing `mt create`
step the agent works around every run, a flaky query, or a broken setup is as valuable as
a skill or AGENTS.md change — value, not where the fix lands, decides what leads. Report-only:
never auto-edit, never draft artifacts.

The work splits into a deterministic script (two brackets that own all disk I/O) and one
fuzzy middle (per-repo subagents that read transcripts and find friction). Run the brackets;
fan out the middle host-natively.

This skill needs `bun` and runs its script from this skill's own directory. The script lives
at `scripts/run-retrospective.ts`; all state lives under `~/.monke/agent-retrospectives/`.

## 1. Collect

Run the collect bracket from this skill's directory:

```bash
bun scripts/run-retrospective.ts collect [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--idle-minutes N]
```

It normalizes every eligible transcript, groups sessions by repo (one **primary** repo per
session plus any **secondary** repos its tool calls touched), and writes one bundle per repo.
A session is eligible once it has been idle past the cutoff (default 45 min) and is either new
or has grown since it was last frozen — **analyze-once-and-freeze** means frozen friction is
never recomputed, only appended to on resume.

Collect prints a JSON `runTs` and a `bundles` list. **Done when** you have the `runTs` and the
per-repo bundle paths. If `bundles` is empty, stop and report that nothing was eligible.

## 2. Fan out — one subagent per bundle

Spawn one subagent per bundle, concurrently. Give each subagent its bundle path and
[references/finding-schema.md](references/finding-schema.md). Each subagent:

- reads its bundle JSON (normalized sessions with citable `t<n>` turn refs),
- analyzes only turns at or past each session's `firstNewTurnIndex`,
- finds **friction episodes** and clusters **repeated asks** freely from the prose,
- writes its findings JSON to the bundle's sibling path: replace `<repoHash>.json` with
  `<repoHash>.findings.json` in the same run directory.

**Done when** every bundle has a sibling `.findings.json` file. A subagent that finds nothing
still writes a findings file with empty arrays.

## 3. Global synthesis

Read every per-repo findings file. Synthesize the **cross-repo** durable fixes — patterns that
recur across repos (e.g. "stop minting `codex/` branches everywhere"), ranked by **value ×
recurrence**. Write them as Markdown to a synthesis file (e.g. in the run directory). Lead each
proposal with a `Target:` line — *where the fix lands*: `code` / `tooling` / `setup` / `infra` /
`deps` / `docs` / `agent-skill` / `AGENTS.md` / `CLAUDE.md` / `hook` / `preflight`, or
`already-tracked:<ref>` / `none` only when there is genuinely no new fix to make — and a
`Confidence:` line. Rank by value, not by whether the fix touches the agent harness; a code or
tooling fix can be the highest-value item in the report. **Done when** the synthesis file is written.

## 4. Commit

Run the commit bracket:

```bash
bun scripts/run-retrospective.ts commit --run-ts <runTs> --synthesis <synthesisFile>
```

It validates every cited turn ref and episode ref against the bundle (hallucinated citations are
dropped and counted), freezes each session's friction, and writes the action-first report. See
[references/report-contract.md](references/report-contract.md) for the report shape. **Done when**
commit prints the report path; surface the `dropped` counts — a high drop count means the
subagents are citing turns that do not exist.

## 5. Hand back

Read the report and surface the lead proposals to the user. Every proposal is a named, evidenced,
confidence-tagged thing a human decides on — propose, never apply.
