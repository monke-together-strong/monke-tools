# Spec Orchestration

Use this when `$implement` is given a Spec that has implementation issues attached.

The Spec `$implement` agent is a coordinator.

One worker may use the current checkout and branch; give every additional
concurrent worker its own worktree and branch, starting from a commit on the
original branch that includes its completed dependencies. Only that worker may
change its checkout until closeout finishes. The coordinator merges completed
work into the original branch only while no worker is using that checkout.

## Process

1. Fetch the Spec and its comments.
2. Find implementation issues attached to the Spec.
3. Record the review base (the final-review fixed point) before any slice starts.
   Prefer the branch point from the target integration branch; if the user
   supplied a review base, use that. Resolve and record its full commit SHA with
   `git rev-parse <fixed point>^{commit}`; stop to ask if none can be identified.
4. Read which issues block each slice. A slice is ready when all
   its blockers are complete and integrated; slices with no blockers are ready
   immediately.
5. Launch ready slices in parallel within the host's concurrency limit, reserving
   three descendant slots per worker for its verifier and two reviewers. Use a
   fresh native subagent for each slice, not a fork, with the delegation prompt
   below. Queue remaining ready slices until capacity is free. Wait for native
   completion notifications or use the host's wait tool. Resume incomplete work;
   a blocked slice pauses only its dependents. Record newly discovered
   dependencies before scheduling affected slices.
6. After a worker passes slice closeout, collect its final commit SHA and
   verification evidence. Merge completed slices one at a time into the
   original branch, waiting for any worker using that checkout to finish first.
   Work already on that branch needs no merge. Check that the combined changes
   work before treating a slice as integrated.
7. Launch newly ready slices as soon as their blockers are integrated, without
   waiting for unrelated slices. Repeat until all slices are integrated.
8. When a worker or review reports a finding deferred to a later attached issue
   or final integration, add it to a Spec closeout list in the orchestrator
   context. Include the source issue, the finding, and the later issue or final
   check that will address it.
9. After all issues are integrated, return to `SKILL.md` and close out the parent
   Spec as the Work target, keeping the original review base.

## Delegation prompt

When creating a subagent for an attached issue, use this template and do
not add generic repo/process reminders.

```text
$implement <attached issue URL>

Checkout: <absolute checkout path>
Parent Spec: <parent Spec URL>. Use it as background context for product intent and constraints only, do not implement the entire Spec.
```
