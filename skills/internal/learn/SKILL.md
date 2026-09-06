---
name: learn
description: Learn from evidence when asked to explain an incident or improve behavior, workflows, skills, prompts, or instructions.
---

# Learn

Find the supported cause and the smallest change that would make the next run
behave as intended.

## Establish the evidence

Use the user's intended behavior or named improvement as the target. Ask only
when the target is ambiguous. Account for every identified primary artifact,
including messages, tool calls, sessions, files, diffs, logs, and exact wording:
read it or mark it unavailable with the uncertainty that leaves.

For a missed skill, inspect its catalog name and description, which govern
selection. A missing observable trigger makes the description the fix surface.
Inspect the body for behavior after invocation.

## Diagnose and generalize

Explain what happened, what should happen, which instruction or tool behavior
made the wrong path plausible, and why it prevailed. Tie the cause to evidence;
“confusion” alone does not identify a fix.

When observed behavior violates an existing rule, treat that as evidence that
the rule was insufficient in practice. Locate the instruction that shaped the
wrong decision and first consider rewriting it to encode the intended behavior
where that decision originates. Add a downstream check or enforcement only when
evidence explains why correcting that instruction would be insufficient. Prefer
replacing weak wording to accumulating corrective rules. Citing the existing
rule or promising compliance is not a fix.

Choose the smallest fix surface that covers equivalent cases. State the class
of cases the fix applies to; retain particular actors, wording, tools, or sites
only when they define that class.

## Apply and report

Implement when the user asks for a change; otherwise recommend it. Preserve the
target artifact's scope, voice, and structure unless changing them is requested
or the evidence identifies them as the cause. For skill edits, use
`$writing-for-agents` and check the result against it.

Report the cause, the change made or recommended, and remaining uncertainty or
validation gaps. The lesson should tell another agent when and how to apply it.
