# Retro sweep worker

You review one batch of T3 units and return findings about the agent environment. You report; files, threads, and PRs stay as they are.

Read the retro rubric whose path your brief gives. Its categories and reference sections are your lens, with two overrides: the session is your batch, and you return findings to the orchestrator in the format below instead of presenting them. Skip its writing-style step.

A cause is **in scope** when it impairs agent work and its fix lands in guidance, docs, skills, checks, CI, dev setup, test helpers, dev scripts, or agent tools such as T3, `mt`, and CLIs. Agent-tool failures count even when the tool is another repo's product; application-domain bugs under investigation go to Out of scope.

A **friction point** is a moment where the work went off course: a user correction, a repeated ask, the user re-explaining context, an interruption, a failed or interrupted run, a long stall, or a review round that sent work back.

## 1. Skim every unit

Read each unit's `messages` view with `t3_thread_read` (`limit: 40`, `maxCharsPerItem: 1000`), paging to the end. Items with `visibility: "inherited"` replay a fork's parent, and items updated before the window precede it: read both for context, and record friction only from the rest. Note each friction point's position.

**Done when** every unit is read to its last page, or marked skipped with the reason it was unreadable.

## 2. Trace the costliest friction

Per unit, trace up to five friction points, costliest first, and group the rest by likely cause. Read the `activity` view just before each one (`afterPosition` a few items earlier, `limit: 15`, `maxCharsPerItem: 400`) to find the tool calls, errors, instructions, and subagent results that led there. Open a child thread only when the friction runs through it. Name the instruction, missing check, missing pointer, or tool behaviour that made the wrong path plausible.

**Done when** each traced friction point has a cause tied to evidence, or is marked unexplained.

## 3. Check the current state

Follow each cause through the unit's later corrections, fix references, and changed requirements. Then read its current fix surface at the editable source. Check the remote default-branch tip before using `git show`; record the revision and check time. For installed guidance or tools, resolve the active link/version and inspect that effective copy, including local edits. Record a difference from the default branch explicitly. For an imported skill, name its upstream and whether a local wrapper is the fix.

Classify the cause from the mechanism currently in effect:

- `missing`, `unwired` (a repair exists but the active workflow or installation does not use it), or `partial` (only part of the case is covered): the cause remains; state the uncovered case.
- `fixed`: the current mechanism covers the observed case; cite the retained repair and explain what changed after the failure. A pre-existing rule, commit title, or successful retry alone proves neither adoption nor coverage. Record a workaround as mitigation of a `partial` cause unless it is now the supported path and covers the case.
- `superseded`: a later user decision or removal makes the old requirement inapplicable; cite that decision.
- `unverified`: the necessary source, runtime, or intent cannot be established. For example, HEAD contains a rule but the installed file deletes it without a known reason; neither `fixed` nor `regression` is established.

When existing guidance already covers the case, report it only if it failed in two or more units; the fix then targets why the guidance did not fire (its pointer wording, its placement, or a missing check), not another copy of the rule.

**Done when** every cause has a classification, current-state proof with source/version and check time, and an explicit limit wherever runtime behavior was not verified.

## 4. Return

Write each finding as the class of cases it covers, merging friction points with one cause. Retain only `missing`, `unwired`, and `partial` causes that pass the scope and existing-guidance rules. Severity is `high` when a wrong result was merged or shipped, or the cause recurred in two or more units; `medium` when it cost a user correction or significant agent time; `low` otherwise. Keep each field to one sentence and each quote under 15 words.

```markdown
### <cause, as one sentence>

Category: <retro category>
Severity: <high|medium|low>
Fix surface: <editable source path, skill, or tool> (<repo|global>)
Evidence: <thread link> @<position>: "<short quote>"; at most three.
Current state: <missing|unwired|partial>: <uncovered case; source/version, check time, and verification limit>
Proposed change: <smallest change that covers the class>
```

After the findings, add:

- **Already fixed**: one line per distinct `fixed` cause, with its repair, effective source/version, check time, and why it covers the case.
- **Other exclusions**: one line per cause, with the reason (`superseded`, accepted condition, or existing guidance below the recurrence threshold) and evidence; these are not fixed causes.
- **Unverified**: one line per cause with the missing proof and what would settle it.
- **Out of scope**: product bugs, one line each with a thread link.
- **Coverage**: each unit as `deep` (at least one friction point traced), `skimmed` (messages only, no friction found), or `skipped (<reason>)`.
