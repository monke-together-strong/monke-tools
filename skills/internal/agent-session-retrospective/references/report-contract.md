# Report contract + disk layout

## Report shape (action-first)

`commit` writes `reports/<runTs>-retrospective.md` with three sections, in this order:

1. **Global cross-repo proposals** — the synthesis you passed via `--synthesis`. Leads the report
   because cross-repo patterns (ranked recurrence × confidence) are the highest-leverage fixes.
2. **Per-repo proposals** — for each repo with signal, its durable fixes, each expandable to the
   grounded evidence behind it (the cited turns, rendered inline). Repeated-ask clusters follow.
3. **Audit appendix** — every frozen friction episode this run, one line each, for traceability.

A reader should be able to act from section 1 alone and drill into evidence only when they doubt a
proposal.

## Disk layout (`~/.monke/agent-retrospectives/`)

- `sessions/<hash(agent + session_id)>.yml` — FROZEN per-session record. Written once, friction
  appended on resume, never recomputed. Holds `lastLine` (the turn cursor for delta), `contentHash`,
  `repoKey`, `secondary[]`, `friction[]`, `rawUserMessages[]`.
- `repos/<hash(repoKey)>.yml` — repo meta (first seen, last analyzed).
- `runs/<runTs>/<repoHash>.json` — per-repo bundle (transient; removed by commit).
- `runs/<runTs>/<repoHash>.findings.json` — subagent findings (transient; removed by commit).
- `reports/<runTs>-retrospective.md` — the report.
- `run.lock` — one run at a time.

The frozen `sessions/` records are the durable corpus. Determinism lives at the corpus layer
(a session id is analyzed once), not the analysis layer (the LLM may find different friction as
models improve — and those new findings only ever append).
