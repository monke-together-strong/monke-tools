# Spec Orchestration

Use this when `$implement` is given a Spec that has implementation issues attached.

The goal is the entire Spec implemented on one integration branch. The Spec
`$implement` agent coordinates tickets; each ticket runs `$implement` and owns
its implementation, code review, and fixes.

The tickets are not a list of steps. They are a **task graph** with blocking
relationships. The **frontier** is the set of tickets whose blockers are complete
and integrated; tickets without blockers are ready immediately.

Communication to and from subagents should be sparse. Communicate primarily
through **context pointers**: to the Spec, tickets, research notes, and previous
commits. Keep the information in those sources rather than restating it in
handoffs.

Run **implementer subagents** in the background where possible for maximum
concurrency.

One worker may use the current checkout and branch; give every additional
concurrent worker its own worktree and branch, starting from a commit on the
integration branch that includes its completed dependencies. Only that worker
may change its checkout while implementing and reviewing. The coordinator merges
completed work into the integration branch only while no worker is using that
checkout.

## Process

1. Use the Spec and discovered implementation tickets to understand the task
   graph.
2. (Optional) Use an exploration subagent for codebase or documentation research
   shared by the tickets. Save its notes outside the repo, accessible to future
   implementers, and pass a pointer to them.
3. Record the integration review base before any ticket starts, for the final
   shipping review.
   Use the user-supplied review base, or the branch point from the intended PR
   base branch. Resolve and record its full commit SHA with
   `git rev-parse <review base>^{commit}`; stop to ask if none can be identified.
4. Launch a fresh native implementer subagent for each ticket on the frontier,
   using the delegation prompt below.
   Wait for native completion notifications or use the host's wait tool; resume
   incomplete work.
5. After a worker finishes implementation, review, and fixes, collect its commit
   SHA, concise verification summary, and remaining integration work. Merge
   completed tickets one at a time into the integration branch, waiting for any
   worker using that checkout to finish first.
   Work already on that branch needs no merge. Check that the combined changes
   work before treating a ticket as integrated.
6. If integration changes the frontier, launch implementer subagents for the
   newly ready tickets immediately, while unrelated tickets continue. A blocked
   ticket pauses only its dependents. Record newly discovered dependencies
   before scheduling affected tickets. Repeat until all tickets are integrated.
7. Track deferred cross-ticket findings with their source issue and the ticket
   or integration check that will address them.
8. Complete remaining Spec acceptance and integration work using scoped checks;
   assign code fixes to an implementer. Resolve each deferred finding through
   a fix, verification, or explicit user acceptance of exclusion from scope.
   Return the integration branch, final commit SHA, recorded review base SHA,
   and concise verification summary.

## Delegation prompt

```text
$implement <ticket URL>

Parent Spec: <Spec URL>
Checkout: <absolute checkout path>
```
