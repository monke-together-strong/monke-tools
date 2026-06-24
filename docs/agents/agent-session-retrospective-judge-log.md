# agent-session-retrospective — build + judge-improvement log

How the skill at `skills/internal/agent-session-retrospective/` was built from the locked design,
tested on a real week of transcripts, judged by a separate LLM, and improved. Dated 2026-06-24.

## What was built

A monke-tools internal Distributed skill that studies local Codex + Claude transcripts, detects
**friction episodes** and **repeated user asks**, and emits report-only, action-first durable-fix
proposals. Two deterministic brackets own all disk I/O; the fuzzy middle is host-native subagent
fan-out, one per repo.

- `SKILL.md` — orchestration (collect → fan out → synthesize → commit → hand back), each step with
  a checkable "Done when".
- `scripts/run-retrospective.ts` + `scripts/lib/*` — `collect`/`commit`, canonical model, Codex +
  Claude collectors, normalization, idle-gate + delta, citation validation, freeze, report.
- `references/finding-schema.md`, `references/report-contract.md` — subagent + report contracts.
- `__tests__/agent-session-retrospective.test.ts` — 16 tests over the deterministic layers.

## Test run (week of 2026-05-25, idle-gate disabled for back-testing)

`collect` over `~/.codex` + `~/.claude`: ~1.7k transcripts scanned, **42 sessions in window across
10 repos**, 66 duplicate (resumed/archived) files collapsed. Fanned out one subagent per repo →
37 friction episodes, 24 durable fixes, 11 repeated-ask clusters → cross-repo synthesis → `commit`.

Dominant cross-repo pattern: **clean-worktree verification has no bootstrap** (recurs in
winters-echo, frostbite-crawler, gbrain, jungle-os) — directly relevant to monke-tools' own
worktree story. Others: browser-harness helper hallucination + macOS setup, unexpanded
`$CODEX_HOME` in automation memory paths, Railway CLI trial-and-error, git at multi-project roots.

## LLM-as-judge

A separate general-purpose agent scored the report + skill against the 16 locked decisions and
writing-great-skills principles. Scorecard: Groundedness 4/5, Action-first 4/5, Dedup 3/5, Design
fidelity 3/5, Contract clarity 4/5, Robustness 2/5. Biggest weakness: an index-confusion between
the line-count and turn-count cursors, and a validated episode that rendered `(missing)` in the
shipped report (proving the citation guarantee was not airtight).

## Improvements applied (with disposition)

| #   | Sev  | Finding                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                    |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | high | `lastLine` meant JSONL line count on `CanonicalSession` but turn cursor on the frozen record — same name, two scales                        | **Fixed (clarity).** Not a live bug (the cursor consistently uses turn count on both ends and the `lastTurnIndex >= turns.length` check short-circuits), but renamed to `sourceLineCount` / `lastTurnIndex` to kill the trap.                                                                  |
| 2   | high | A "validated" episode rendered `(missing)` evidence                                                                                         | **Fixed.** Root cause was duplicate session entries in a bundle (live + archived copy): validation keyed the last entry, render keyed the first. Resolved by the dedupe-by-`(agent, session_id)` fix (keep most-complete copy). Regression test asserts the report never contains `(missing)`. |
| 3   | high | Secondary-repo subagents could author episodes for a session whose primary lives elsewhere → frozen nowhere, double-counted in the appendix | **Fixed.** `validateFindings` now accepts episodes only for `primary`-role sessions (friction is authored once, by the session's primary repo); appendix deduped by `(sessionId, sorted refs)`; `finding-schema.md` tells subagents not to author for secondary sessions.                      |
| 4   | med  | `parseExitCode` matched only two phrasings                                                                                                  | **Fixed.** Broadened to four patterns (`exit code:`, `exit status:`, `process exited with status`).                                                                                                                                                                                            |
| 5   | med  | `collectTouchedRoots` shells `git` for every path string; slow + time-of-analysis dependent                                                 | **Fixed (bounded).** Per-session distinct-dir cap (64) + visited-set; documented that secondary membership is best-effort and frozen-once (stable thereafter).                                                                                                                                 |
| 6   | med  | "No tests exist"                                                                                                                            | **Already satisfied** (judge looked only in `scripts/lib/`); tests live in `__tests__/`. Added the cases it asked for (secondary-drop, render-consistency, repeated-ask filtering, `parseFixHeader`).                                                                                          |
| 7   | med  | Per-repo proposals dumped one `<details>` per cited episode and a raw body                                                                  | **Fixed.** One merged evidence block per proposal; `Target:`/`Confidence:` parsed into a clean `**target** · _confidence_` header. Report tightened 536 → 333 lines on the same corpus.                                                                                                        |
| 9   | low  | Run lock had no PID/timestamp and never evicted                                                                                             | **Fixed.** Lock now records PID + acquiredAt and evicts when the owner is gone (ESRCH) or older than 60s.                                                                                                                                                                                      |
| 10  | low  | `repeatedAsks.exampleSessionIds` unvalidated; boundary-spanning friction undefined                                                          | **Fixed.** Unknown session ids stripped in `validateFindings`; schema now tells subagents how to handle friction arcs that begin before `firstNewTurnIndex`.                                                                                                                                   |
| 8   | med  | Codex `hasEventProse` heuristic could drop prose if a transcript's only prose lives in the non-selected channel                             | **Deferred (documented limitation).** Real transcripts emit `event_msg` user/agent prose reliably; a cross-channel merge risks duplicating `agent_message`/`output_text`. Left as a known limitation rather than ship a fragile dedupe.                                                        |

## Verification after improvements

Re-ran `collect` → fan-out → `commit` on the same week with the fixed code:

- **Idempotency holds**: a second `collect` on the frozen store yields **0 bundles** (analyze-once-and-freeze works across runs); 66 duplicate files collapse every run.
- **Citation integrity**: report has **0 `(missing)`**; `commit` reported `dropped: {episodes:0, fixes:0}`, `appendedSessions:0` on a fresh store (no double-freeze).
- **Dedup**: jungle-os 16→12 and browser-harness 6→4 session entries after collapsing resumed copies; audit appendix has no duplicate evidence lines.
- 246 tests pass (`bun test`), `bun run lint` and `bun run fmt:check` clean.
