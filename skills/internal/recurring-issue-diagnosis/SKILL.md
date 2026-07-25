---
name: recurring-issue-diagnosis
description: Continue recurring issue diagnosis from prior attempts. Use when a bug or incident returns after earlier investigation or its tracker shows repeated recurrences.
---

# Recurring Issue Diagnosis

Advance a recurring investigation from its existing evidence frontier instead
of restarting discovery.

## 1. Resolve The Canonical Tracker

Identify the current tracker and any retired predecessors. Read the current body,
linked predecessors, evidence comments, relevant prior agent threads, reports,
deployments, and retained artifacts. Establish the latest evidence boundary
before querying for new occurrences.

Treat the tracker body as the current map and linked primary artifacts as proof.

Completion criterion: the canonical tracker, predecessor history, latest
deployment or time boundary, and available primary evidence are identified.

## 2. Reconstruct The Frontier

Separate conclusions into independent axes:

- causal prevention
- recovery
- continuity and impact
- observability

Classify every earlier intervention as `confirmed`, `failed`, `inconclusive`, or
`superseded`. State remaining unknowns as hypotheses with evidence that would
confirm or falsify them. A result on one axis does not settle the others.

Completion criterion: every material intervention has a result classification,
and every remaining hypothesis is testable.

## 3. Run The Next Discriminating Check

Select the smallest check that separates the leading hypotheses. Define its
evidence source, bounded window, expected observations, and decision rule before
running it. Prefer a check that advances the frontier over another broad
recurrence count.

For diagnosis requests, investigate and report. Implement a corrective change
only when the user's request includes implementation.

Completion criterion: the new evidence changes a hypothesis, intervention
classification, or next action. If available evidence cannot do so, name the
specific missing capability or event to wait for.

## 4. Maintain The Investigation Frontier

When tracker updates are in scope, keep one bounded
`## Investigation frontier` section in the main body:

```md
## Investigation frontier

Last synthesized: <UTC timestamp>
Current state: <one-sentence operational verdict>

### Established

- Causal prevention: <known or unknown>
- Recovery: <known or unknown>
- Continuity and impact: <known or unknown>
- Observability: <known or unknown>

### Tried

| Date / change | Question | Result | Status |
|---|---|---|---|
| ... | ... | ... | confirmed / failed / inconclusive / superseded |

### Open hypotheses

1. <hypothesis> — confirm with <evidence>; falsify with <evidence>

### Next discriminating check

1. <exact action, evidence source, and bounded window>

Decision rule: if <result>, do <action>; otherwise <alternative>.

### Evidence anchors

- <deployment, commit, incident ID, artifact path, report, or timestamp>
```

Put raw recurrence evidence in comments or reports, then update the frontier in
the same run. Replace stale next actions and summarize superseded conclusions;
the append-only artifacts retain the chronology.

When tracker writes are outside the user's request, provide the exact frontier
update as a recommendation.

Completion criterion: a new agent can select the next investigation from the
tracker body without reconstructing earlier threads and can reach the primary
evidence through its anchors.

## 5. Report The Advance

End with:

- the current operational verdict
- what this run newly established or ruled out
- the next discriminating check
- remaining uncertainty or missing capability
- whether the canonical frontier was updated

Completion criterion: the next run can continue without re-arguing this run.
