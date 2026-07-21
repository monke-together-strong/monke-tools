---
name: learn
description: Learn from evidence. Use when the user wants an incident explained or a behavior, skill, prompt, tool workflow, process, or instruction improved.
---

# Learn

Turn an observed misfire into a durable lesson: the smallest true cause and the
smallest change that would make the next run behave as intended.

## 1. Name The Target

Identify which branch the user gave you:

- **Intended-behavior branch**: the user says what should have happened.
  Reconstruct what actually happened, then explain the gap.
- **Direct-learning branch**: the user names what to learn or improve, without
  separately stating intended behavior. Treat that behavior, skill, prompt, tool
  workflow, process, or instruction as the learning target.

If the target is ambiguous, ask one concise clarifying question. Otherwise,
state the target and proceed.

Completion criterion: the incident has exactly one stated target, or the user has
been asked for the missing target.

## 2. Rebuild The Incident

Read every available primary artifact the user points to: thread messages and
tool calls, referenced sessions, local files, diffs, commits, logs, test output,
and exact user wording. Prefer raw evidence over memory; do not diagnose before
it supports the cause.

Completion criterion: every available artifact the user pointed at has been read
or explicitly marked unavailable.

## 3. Diagnose

Write a compact cause chain:

1. **Actual behavior**: what happened, grounded in evidence.
2. **Intended behavior or learning target**: what should be true next time.
3. **Trigger**: the instruction, skill text, tool behavior, missing distinction,
   default habit, or ambiguous wording that made the wrong path plausible.
4. **Why it won**: why that trigger overrode or bypassed the intended behavior.
5. **Fix surface**: the smallest artifact or process that should change.

Avoid vague causes such as "confusion" or "miscommunication" unless you can name
the concrete instruction or missing distinction that created it.

Completion criterion: the chain names the concrete trigger, why it won, and the
smallest fix surface.

## 4. Apply Or Recommend The Fix

If the user asks to update something, implement the smallest durable fix. The fix
may be a skill edit, prompt edit, documentation change, test, checklist, tool
usage rule, or process change.

If the user only asks what happened, report the diagnosis and recommend the fix
without editing.

When creating or updating a skill, invoke `/writing-great-skills` before editing
and verify the finished skill against it.

Completion criterion: either the fix is implemented and verified when practical,
or the recommended fix is concrete enough for another agent to apply.

## 5. Report The Lesson

End with:

- the cause in one or two sentences
- what changed, or what should change
- any remaining uncertainty or validation gap

Completion criterion: the final answer makes the lesson reusable without
re-arguing the whole incident.
