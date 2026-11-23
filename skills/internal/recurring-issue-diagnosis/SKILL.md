---
name: recurring-issue-diagnosis
description: Diagnose a recurring bug or incident from prior investigation evidence. Use when an issue returns or its tracker records earlier attempts.
---

# Recurring issue diagnosis

Continue from established evidence and run the next check that separates the remaining hypotheses.

## Reconstruct

Read the canonical tracker, retired predecessors, evidence comments, prior threads, deployments, reports, and retained artifacts. Establish the latest deployment or time boundary before checking for recurrences. When deployment identity matters, check the repo's documented read-only runtime version endpoint before relying on deployment-provider metadata, and recheck after intervening releases because an endpoint missing earlier may now exist. A current runtime SHA proves the current service version, not the image an earlier log host ran.

Classify material interventions as `confirmed`, `failed`, `inconclusive`, or `superseded`. Keep causal prevention, recovery, continuity and impact, and observability separate, because evidence on one does not settle another. Build the deepest supported causal chain from trigger through mechanism to impact. When the initiating trigger remains unknown, name the diagnosed boundary, the evidence ruling out earlier boundaries, and what would confirm or falsify each remaining hypothesis.

## Advance

Pick the smallest discriminating check. State its evidence source, bounded window, expected observations, and decision rule before running it. Run the check, update hypotheses and intervention classifications, and continue running any newly exposed discriminating checks until remaining uncertainty depends on unavailable evidence or access, an unapproved side effect, or a future event. Verify that boundary before handing off.

Investigate and recommend unless implementation is in scope. When fixing, target the root cause per [principle-fix-root-causes](../../imported/principle-fix-root-causes/SKILL.md).

## Update tracker and report

When tracker updates are in scope, maintain one `## Investigation frontier` section in the canonical body containing:

- Last synthesized time, current verdict, and deployment or time boundary.
- Established facts across prevention, recovery, impact, and observability.
- Material interventions and their classifications.
- Open hypotheses with confirming or falsifying evidence and the next check's decision rule.
- Links to primary evidence.

Replace stale next actions and keep raw chronology in linked comments or reports. **Handoff test.** Can a new agent choose the next check from the tracker body alone without rereading prior threads? When writes are out of scope, propose the update instead.

In your final response, lead with the causal chain, decisive evidence, unresolved boundary, and ruled-out alternatives. Follow with ordered next steps separating recommendations from changes made, and end with tracker update status and links so the response stands alone.
