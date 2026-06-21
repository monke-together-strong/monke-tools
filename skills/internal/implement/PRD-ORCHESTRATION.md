# PRD Orchestration

Use this when /implement is given a PRD that has implementation issues attached.

The PRD `/implement` thread is a coordinator. Do not implement attached issues
inline in the PRD thread.

## Process

1. Fetch the PRD and its comments.
2. Find implementation issues attached to the PRD.
3. Record the final-review fixed point before any slice work starts. Prefer the
   branch point from the target integration branch; if the user supplied a
   review base, use that. Verify it with `git rev-parse <fixed point>` and stop
   to ask if no stable fixed point can be identified.
4. Order the issues by their `Blocked by` relationships.
5. For each issue, create a separate thread using the delegation prompt
   template below.
6. Monitor the current issue implementation every three minutes. Be patient:
   after confirming the worker is active, wait about 180 seconds between
   polls; do not short-poll with 60-second sleeps. Let active work continue
   without steering; intervene only for a blocker, completion, or clear course
   deviation.
7. When a worker or slice review reports a finding deferred to a later slice or
   final integration, add it to a PRD closeout list in the orchestrator thread.
   Include the source slice, the finding, and the expected later slice or gate.
8. After all issues are complete, run the final PRD closeout gate below. The
   orchestration is not complete until every material closeout finding is fixed
   or explicitly accepted as out of scope.

## Final PRD Closeout

Run `/review <final-review fixed point> <parent PRD URL>`.

Before closing the orchestration thread, reconcile the PRD closeout list against
the final review. Every deferred finding must have one of these dispositions:

- fixed in the accumulated branch
- covered by a final review finding that is then fixed
- explicitly accepted as out of scope with the reason recorded

## Delegation prompt

When creating a thread for an implementation slice, use this template and do
not add generic repo/process reminders.

```text
/implement <slice issue URL>

Parent PRD: <parent PRD URL>. Use it as background context for product intent and constraints only, do not implement the entire PRD.
```
