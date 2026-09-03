# Spec Orchestration

Use this when `$implement` is given a Spec that has implementation issues attached.

The Spec `$implement` thread is a coordinator.

A separate thread is only a conversation boundary. Keep work in the current
checkout/worktree by default. Do not create or switch branches/worktrees unless
the user explicitly asks for filesystem isolation.

## Process

1. Fetch the Spec and its comments.
2. Find implementation issues attached to the Spec.
3. Record the final-review fixed point before any attached-issue work starts.
   Prefer the branch point from the target integration branch; if the user
   supplied a review base, use that. Resolve and record its full commit SHA with
   `git rev-parse <fixed point>^{commit}`; stop to ask if none can be identified.
4. Order the issues by their `Blocked by` relationships.
5. For each attached issue, create a fresh separate thread, not a fork, using
   the delegation prompt template below.
6. Monitor the current issue implementation with `$polling` using an
   eight-minute heartbeat. A blocker or clear course deviation is work to do;
   completion ends that issue's polling loop; otherwise keep waiting.
7. When a worker or review reports a finding deferred to a later attached issue
   or final integration, add it to a Spec closeout list in the orchestrator
   thread. Include the source issue, the finding, and the expected later issue
   or gate.
8. After all issues are complete, return to `SKILL.md` and close out the parent
   Spec as the Work target.

## Delegation prompt

When creating a thread for an attached issue, use this template and do
not add generic repo/process reminders.

```text
$implement <attached issue URL>

Parent Spec: <parent Spec URL>. Use it as background context for product intent and constraints only, do not implement the entire Spec.
```
