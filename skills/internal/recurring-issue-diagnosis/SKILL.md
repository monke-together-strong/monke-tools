---
name: recurring-issue-diagnosis
description: Diagnose a recurring bug or incident from prior investigation evidence. Use when an issue returns or its tracker records earlier attempts.
---

# Recurring Issue Diagnosis

Continue from established evidence and run the next check that separates the
remaining hypotheses.

## Reconstruct the investigation

Find the canonical tracker and retired predecessors. Read their bodies, evidence
comments, relevant prior threads, deployments, reports, and retained artifacts.
Establish the latest deployment or time boundary before looking for recurrences.

Classify material interventions as `confirmed`, `failed`, `inconclusive`, or
`superseded`. Distinguish causal prevention, recovery, continuity and impact, and
observability: evidence on one does not settle the others.

Build the deepest supported chain from trigger through mechanism to failure,
recovery, and impact. If the initiating cause remains unknown, name the diagnosed
boundary and evidence that rules out earlier boundaries. State what would confirm
or falsify each remaining hypothesis.

## Advance it

Choose the smallest discriminating check. Before running it, identify the evidence
source, bounded window, expected observations, and how each result changes the
next action. Run the check and record how its evidence changes a hypothesis,
intervention classification, or next action. If no available check can advance
the investigation, name the missing capability or event needed.

Investigate and recommend for diagnosis requests. Implement a correction only
when implementation is in scope.

## Maintain the tracker

When tracker updates are in scope, keep one `## Investigation frontier` section
in the canonical body containing:

- Last synthesized time, current verdict, and deployment or time boundary.
- Established facts about prevention, recovery, impact, and observability.
- Material interventions and their result classifications.
- Open hypotheses, their confirming or falsifying evidence, and the next check
  with its decision rule.
- Links to primary evidence.

Replace stale next actions and summarize superseded conclusions. Keep raw evidence
and chronology in linked comments or reports. A new agent should be able to choose
the next check from the body without rereading earlier threads. When writes are
outside scope, provide the proposed update instead.

## Report

Explain the causal chain and decisive evidence first, including the unresolved
boundary and alternatives ruled out. Then give ordered next steps with reasons,
distinguishing recommendations from changes made. Finish with whether the tracker
was updated and its evidence link. Make the diagnosis understandable from the
final response alone.
