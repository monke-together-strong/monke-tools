# Retro sweep worker

You review one batch of T3 units and return findings about the agent environment. You report; files, threads, and PRs stay as they are.

Read the retro rubric whose path your brief gives. Its categories and reference sections are your lens, with two overrides: the session is your batch, and you return findings to the orchestrator in the format below instead of presenting them. Skip its writing-style step.

A cause is **in scope** when it impairs agent work and its fix lands in guidance, docs, skills, checks, CI, dev setup, test helpers, dev scripts, or agent tools such as T3, `mt`, and CLIs. Agent-tool failures count even when the tool is another repo's product; application-domain bugs under investigation go to Out of scope.

A **friction point** is a moment where the work went off course: a user correction, a repeated ask, the user re-explaining context, an interruption, a failed or interrupted run, a long stall, or a review round that sent work back.

## 1. Skim every unit

Read the `messages` view of each unit's thread and each of its sidechats with `t3_thread_read` (`limit: 40`, `maxCharsPerItem: 1000`), paging to the end. Items with `visibility: "inherited"` replay a fork's parent, and items updated before the window precede it: read both for context, and record friction only from the rest. Note each friction point's position.

When the parent supplies context only, read just its tail before the sidechat's fork. Bisect `afterPosition` with `limit: 1` on the `messages` view for the first message whose `runId` ordinal exceeds `fork_run`'s, then read the 10 messages before it; reads page forward only, so start about 50 positions earlier.

**Done when** every unit thread and sidechat is read to its last page (a context-only parent to its fork), or marked skipped with the reason it was unreadable.

## 2. Trace the costliest friction

Per unit, trace up to five friction points, costliest first, and group the rest by likely cause. Read the `activity` view just before each one (`afterPosition` a few items earlier, `limit: 15`, `maxCharsPerItem: 400`) to find the tool calls, errors, instructions, and subagent results that led there. Open a child thread only when the friction runs through it. Name the instruction, missing check, missing pointer, or tool behaviour that made the wrong path plausible.

**Done when** each traced friction point has a cause tied to evidence, or is marked unexplained.

## 3. Check the current state

Apply [the current-state check](../../references/internal/RETRO_CURRENT_STATE.md)
to each cause. Keep the incident outcome, subsequent repairs, and remaining gap
separate in your return so the orchestrator can preserve them in the report.

When existing guidance already covers the case, report it only if it failed in two or more units; the fix then targets why the guidance did not fire (its pointer wording, its placement, or a missing check), not another copy of the rule.

**Done when** every cause has a classification, current-state proof with source/version and check time, and an explicit limit wherever runtime behavior was not verified.

## 4. Return

Write each finding as the class of cases it covers, merging friction points with one cause. Retain only `missing`, `unwired`, and `partial` causes that pass the scope and existing-guidance rules. Severity is `high` when a wrong result was merged or shipped, or the cause recurred in two or more units; `medium` when it cost a user correction or significant agent time; `low` otherwise. Keep each field to one sentence and each quote under 15 words.

```markdown
### <remaining cause, as one sentence>

Category: <retro category>
Severity: <high|medium|low>
Fix surface: <editable source path, skill, or tool> (<repo|global>)
Evidence: <thread link> @<position>: "<short quote establishing the incident and intended behavior>"; at most three.
Since then: <incident outcome, later repairs or decisions, and their evidence>.
Remaining: <missing|unwired|partial>: <uncovered case, effective source/version, check time, and verification limit>
Proposed change: <smallest change that covers the remaining case>
```

After the findings, add:

- **Already fixed**: one line per distinct `fixed` cause, with its repair, effective source/version, check time, and why it covers the case.
- **Other exclusions**: one line per cause, with the reason (`superseded`, behavior matched the request, accepted condition, or existing guidance below the recurrence threshold) and evidence; these are not fixed causes.
- **Unverified**: one line per cause with the missing proof and what would settle it.
- **Out of scope**: product bugs, one line each with a thread link.
- **Coverage**: each unit as `deep` (at least one friction point traced), `skimmed` (messages only, no friction found), or `skipped (<reason>)`.
