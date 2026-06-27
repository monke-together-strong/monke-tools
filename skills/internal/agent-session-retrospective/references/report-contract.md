# Report contract + disk layout

The PR lane's operational details live in [pr-analysis.md](pr-analysis.md). This file owns only the
final report shape and disk layout.

## Report shape (action-first)

`commit` writes a compact action report at `reports/<runTs>-retrospective.md` and two adjacent
source files:

- `reports/<runTs>-session-sources.md`
- `reports/<runTs>-pr-sources.md`

The main report has a report title, a `Window:` line showing the resolved retrospective window, a
`Sources:` line linking those two files, and two sections, in this order:

1. **Session Actions** — the transcript-derived synthesis passed via `--synthesis`. Leads the
   report because cross-repo session patterns (ranked by **value × recurrence**) are the
   highest-leverage fixes.
2. **PR Repeated Corrective Patterns** — only recurring corrective-change patterns from the
   required PR analysis lane, plus a short pointer when explicit PR gaps exist.

The source files hold the bulky evidence:

- **Session sources** — per-repo proposals, repeated asks, inline cited-turn evidence, and the audit
  appendix of frozen friction episodes.
- **PR sources** — the full PR trajectory aggregate, including one-off patterns, explicit gaps, and
  per-PR analyses.

A reader should be able to act from the main report alone and drill into linked sources only when
they need evidence or provenance.

## Report sets are the cross-run memory

The synthesis step reads the newest few compact reports and their linked source files, then promotes
patterns recurring across those report sets. The compact report is the action surface; the source
files are the evidence and low-signal memory that future runs can promote. Two rules keep that read
worth doing:

- **Never drop low-signal findings.** A `low`-confidence proposal or a lone episode is the seed a
  later run promotes once it recurs — omit it from both the compact report and source files and the
  thread is invisible next time.
- **Always keep the `Confidence:` tag**, so a later read can tell "was low, now corroborated."

Keep the section order above stable so cross-referencing prior report sets stays cheap.

## Disk layout (`~/.monke/agent-retrospectives/`)

- `sessions/<hash(agent + session_id)>.yml` — FROZEN per-session record. Written once, friction
  appended on resume, never recomputed. Holds `lastTurnIndex` (the turn cursor for delta), `contentHash`,
  `repoKey`, `secondary[]`, `friction[]`, `rawUserMessages[]`.
- `repos/<hash(repoKey)>.yml` — repo meta (first seen, last analyzed).
- `runs/<runTs>/window.json` — resolved retrospective window with `since`, `until`, `sinceSource`,
  and `untilSource` (transient; embedded in the final report).
- `runs/<runTs>/<repoHash>.json` — per-repo bundle (transient; removed by commit).
- `runs/<runTs>/<repoHash>.findings.json` — subagent findings (transient; removed by commit).
- `runs/<runTs>/pr-analysis/manifest.json` — PR lane manifest with expected PRs, work-item paths,
  analysis paths, opening refs, final refs, commit SHAs, and PR analysis gaps.
- `runs/<runTs>/pr-analysis/prs/*.json` — one per-PR work item handed to a subagent.
- `runs/<runTs>/pr-analysis/prs/*.analysis.md` — one per-PR Markdown analysis written by a
  subagent.
- `runs/<runTs>/pr-analysis.md` — aggregate PR analysis report for the trajectory window
  (transient; embedded or summarized in the final report; content contract in
  [pr-analysis.md](pr-analysis.md)).
- `reports/<runTs>-retrospective.md` — the report.
- `reports/<runTs>-session-sources.md` — transcript-derived supporting detail for the report.
- `reports/<runTs>-pr-sources.md` — PR-derived supporting detail for the report.
- `run.lock` — one run at a time.

The frozen `sessions/` records are the durable corpus. Determinism lives at the corpus layer
(a session id is analyzed once), not the analysis layer (the LLM may find different friction as
models improve — and those new findings only ever append).
