---
name: retro-sweep
description: Run a retrospective across every T3 thread since the last sweep or the past week, reporting repo and global environment fixes.
disable-model-invocation: true
---

# Retro sweep

Apply the [retro](../../imported/retro/SKILL.md) rubric to the threads the user started recently, and report fixes to the agent **environment**: repo guidance, checks, docs, skills, global instructions, and tools. The sweep is report-only; the human decides what to change. Product bugs met along the way go to the report's Out of scope list as one-liners.

State lives in `~/.monke/agent-retrospectives/`:

- `reports/`: one `*-retro-sweep.md` report per sweep, beside legacy `*-retrospective.md` reports and their companion files. Each report has a `Window: <start> to <end>` line in ISO UTC.
- `*-retro-sweep-evidence.md`: companion worker returns and disposition ledger; these files do not advance the window.
- `accepted.md`: user-owned conditions the sweep must not raise again. Read it; leave it unchanged.

## 1. Resolve the window

The end is now. The start is the later of seven days ago and the end of the newest `*-retro-sweep.md` or legacy `*-retrospective.md` report's window. A start or end the user gives overrides either.

**Done when** both bounds are ISO UTC timestamps.

## 2. Inventory units

A **unit** is a T3 thread with `createdBy: user`, including forks, together with the subagent threads it spawned. List units for every project from `t3_project_list` with `t3_thread_list` (`includeSubagents: false`, `limit: 100`), paging until `updatedAt` falls before the start. Take units updated inside the window, plus the newest report's Deferred units. Exclude the current thread. Units still `running`, `waiting`, `queued`, or `starting` become Deferred.

Each T3 project is one repo; its worktrees already map to it. "No project" units form the global group. Batch each project's units: at most 8 units with `itemCount` of 50 or more, and at most 15 units in total, per batch. Pool projects with 3 or fewer units into one shared batch.

**Done when** every in-window unit sits in exactly one batch or in Deferred.

## 3. Review batches

Dispatch one worker per batch with your native subagent tool on your own model, each in a fresh context with its brief in the prompt. Start them all at once; when the host caps concurrency, start the rest as slots free. Brief each worker with:

- the absolute path of [the worker brief](WORKER.md) and of the retro rubric, to read first;
- the window;
- each project's name and `workspaceRoot`;
- each unit's link, status, `itemCount`, and PR URLs;
- the text of `accepted.md`.

**Done when** every worker has returned findings and coverage, or its failure is recorded as a coverage gap.

## 4. Combine

Combine once, after every worker returns, because promotion needs every repo's findings.

1. **Dedupe all dispositions**: split independently repaired mechanisms within bundled claims, then merge the same cause and fix surface across workers, including Already fixed and exclusions, keeping their evidence; reconcile conflicting states against the current effective surface before counting or reporting them.
2. **Promote to Global** a finding whose fix surface is global (a skill, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, T3, `mt`, harness config), or whose cause shows up in two or more repos. One global fix replaces the repo copies.
3. **Recurrence**: drop findings an `accepted.md` entry covers. Compare the rest with the newest three reports; mark each `new`, `recurring` (raised before, still unfixed), or `regression` (fixed since, back again).
4. **Verify Global findings yourself**: reopen each cited item with `t3_thread_read` and check the current effective fix surface using the worker's current-state criteria. Apply those criteria to every suppression: reopen incomplete or conflicting proof; put unresolved claims in coverage gaps.

Save the worker returns and a disposition ledger to the companion evidence file: one row per distinct cause with an ID, cause and fix surface, state, current-state proof, and report ID or exclusion reason. Count `fixed` rows for Coverage; keep superseded, accepted, and unverified causes separate. Only confirmed active causes become findings. An open fix PR or a repair absent from the effective installation stays active with that qualification; a resolved incident alone does not establish a fixed cause.

**Done when** every candidate maps to one ledger row, every retained finding and fixed suppression has current-state proof, and every Global finding is independently verified.

## 5. Write the report

Write `reports/<end as YYYY-MM-DDTHH-MM-SSZ>-retro-sweep.md`. The template below is the whole report, written for a human deciding in five minutes. Order findings by severity; keep at most 5 Global and 3 per repo in full, and list the rest as one-liners under each section's **Minor** heading. Keep each field to one sentence and each quote under 15 words, with at most three quotes per finding.

```markdown
# Retro sweep: <end date>

Window: <start> to <end>

Coverage: <units> units across <repos> repos (<deep> deep, <skimmed> skimmed); <deferred> deferred; <fixed> causes already fixed; gaps: <what was unreadable, and sessions outside T3>.

Evidence: <companion file link containing worker returns and the disposition ledger>.

## Global

### G1. <cause, as one sentence> (<severity>, <new|recurring|regression>)

Evidence: <thread link> @<position>: "<short quote>"; at most three.
Fix: <surface>: <smallest change that covers the class>.

## <repo>

### <repo>-1. …

## Out of scope

- <thread link>: <product bug, one line>

## Deferred

- <thread link> (<status>)
```

**Done when** the report fits in about 150 lines, every finding carries evidence, a fix surface, and a status, and its counts match the companion ledger.

## 6. Hand back

Give the user the report path and the Global findings with their fixes, then the top finding per repo. The user picks findings to act on and runs [learn](../learn/SKILL.md) on each one.
