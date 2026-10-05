# Session synthesis contract

This contract owns candidate decisions and the Markdown passed to `commit --synthesis`.

## Resolution and recurrence

Give each candidate a run-local id (`A1`, `A2`, …). Inspect the current authoritative code,
guidance, configuration, tracker, or smallest relevant verification. Transcript and prior-report
claims are leads, not current-state proof. Identify the inspected revision or installed surface;
a change in an isolated worktree does not establish that the active workflow received it.

Use `unresolved`, `partially-resolved`, `resolved`, `superseded`, or `unknown`. An open issue is
unresolved. Use unknown when the necessary state cannot be inspected. For partial repairs,
describe only the remaining gap. Distinguish source-verified repair from observed effectiveness;
no recorded recurrence alone does not prove success.

Link the previous matching finding when present. Record whether this run is new, continuing,
regressed after verified resolution, or resolved. Separate new independent task lineages from
historical corroboration; report unknown counts honestly. Preserve first-seen evidence through
prior-report links rather than introducing a separate tracking database.

## Prioritization

Prioritize observed consequences, independent recurrence, and the likely benefit and effort of
the remaining change. Explain the ordering briefly. A consequential one-off may outrank recurring
inconvenience. Use measured costs where available; label rough effort estimates and leave unknowns
explicit. Do not invent scores or estimates to fill the report.

When actions may share a cause, check whether one change could address them. Consolidate only
when evidence supports the common mechanism; otherwise retain separate actions and name the
hypothesis and the evidence needed to establish it.

## Required synthesis shape

Use these four level-three headings exactly once, in order. `commit` validates this structure.

### Recommended Decisions

Put the small shortlist worth acting on this week here, in priority order. Explain the selection
in one short paragraph. Each candidate has one full entry here or in Remaining Active Actions,
never both. There is no minimum quota; write `_No recommended decisions._` when appropriate.

### Remaining Active Actions

Put other unresolved, partially resolved, or unknown candidates here using the same action shape.
Write `_No remaining active actions._` when empty.

Each active entry starts with `#### <id> — <plain-language problem>` and `Problem:`. Require only
these six fields; the other five may appear in any order:

```text
Problem: <observable mismatch and its consequence>
Proposed fix: <concrete remaining change or investigation and its owner>
Done when: <one observable closure condition>
Evidence: <source links plus current-state inspection, revision or installed surface, and time checked>
Confidence: <high | medium | low; identify the assessed claim and remaining uncertainty>
Resolution: <unresolved | partially-resolved | unknown>
```

Keep the problem understandable without metadata. Give each field its own Markdown paragraph
so it remains readable in HTML. Use evidence anchors for decisive excerpts; identify user statements,
tool results, source inspection, and assistant claims distinctly. A valid citation locates evidence;
it does not establish that the cited claim is true.

### Resolved or Superseded

Keep a concise entry for each suppressed candidate: id, resolution, checked-at, checked-against,
current-state evidence, prior finding link, and session evidence. State whether effectiveness was
observed or remains unmeasured. Write `_No resolved or superseded candidates._` when empty.

### Supporting Evidence

Keep detailed standards and workflow audits here, linked from the action, using
`<details><summary>Audit for A1</summary>` with blank lines around the Markdown body.
For standards candidates, inspect Global instructions, the Team coding baseline, and applicable
repo guidance. Record coverage, authoritative owner, rationale, and proposed wording when needed.
Generally applicable rules belong in the Team baseline; stack/domain rules belong in repo guidance.
An already-covered ask calls for investigating execution or enforcement, not another copy.

For each active action, inspect relevant skills/workflows before choosing its disposition. Name
existing owners; a new skill or workflow needs a reusable boundary and trigger. Keep this reasoning
in the audit; mention the chosen owner in the proposed fix. Retain source-only candidate dispositions here
or in linked session sources so low-signal evidence remains available to later runs.

## Completion

Every candidate has one active or resolved entry, current-state evidence, and linked transcript or
repository support. Every active action has an observable closure condition and explicit
uncertainty. Put standards and workflow reasoning in its supporting audit when relevant. Refresh
mutable evidence immediately before commit.
