---
name: shepherd-pr
description: 'Use when the user says things like "shepherd this PR", "babysit this PR", "get this PR merge-ready", "poll for reviews"'
---

# Shepherd PR

Your job is to shepherd this PR all the way to **merge-ready** - reviewed, addressed, verified, and CI green. Merge after readiness only when the user explicitly authorized that terminal action; otherwise hand off at merge-ready.

Create the PR (or pick up the one just created), then mark it as ready for review if needed.

## Check terminal state first

On initial pickup and every heartbeat or re-entry, check PR state before CI or reviews:

```bash
gh pr view https://github.com/OWNER/REPO/pull/NUMBER --json state,mergedAt,closedAt,mergeCommit
```

If `state` is `MERGED` or `CLOSED`, delete the heartbeat, report the terminal state (including merge time and commit when available), and stop—even if jobs remain active. Only `OPEN` continues.

## Keep the PR head rebased

After every `OPEN` check, fetch the live base and PR head. If the base is not an ancestor of the head, rebase a clean PR checkout onto it, push with `--force-with-lease`, and restart. Continue to CI and reviews only after ancestry passes; a rebase resets latest-head review state.

1. **Stabilize CI first:** Inspect CI immediately. If the latest commit has a failed check, diagnose and fix it before manually triggering or waiting for automatic reviewers. Reviews that started automatically may continue, but do not spend a manual review request on a commit with unresolved CI because the fix would make that review stale.

   Read the failing logs, run the smallest relevant target when practical, and classify each failure as a PR regression, deterministic baseline defect, repo-owned flake, or external infrastructure failure.
   - Use retries as diagnostic probes. A passing retry supplies evidence but does not resolve a repo-owned flake.
   - For a suspected flake, locate the unstable boundary and attempt the smallest durable fix: remove the race or shared state, isolate the test, reduce unnecessary work, or calibrate a resource limit to the intended workload. Verify the fix with repeated targeted runs.
   - Rerun without a code change only when evidence identifies an external infrastructure failure, or while diagnosis remains explicitly open.
   - If the durable fix would materially expand the PR, report the diagnosis and ask whether to expand scope instead of declaring the PR merge-ready.

   This step is complete when every observed CI failure has an evidence-backed classification and either a verified repo-owned fix or a concrete external cause.

2. **Wait for reviewers:** Once the latest commit has no unresolved CI failure, inspect each reviewer's latest-head state before triggering a missing automatic review. Read mutable bot comments directly, including their full body and update time, together with command replies and commit coverage; a check context alone does not establish reviewer state. Explicit processing or in-progress text, or an accepted trigger for the latest head, means the review has started. Run `/polling` with an eight-minute heartbeat until every required reviewer and every automatic reviewer that started on the latest commit has finished. Do not act on partial feedback.

  Treat non-required reviewer integrations as best-effort. Inspect and triage any comments they already produced, but when a latest-commit suite never starts after two heartbeat intervals, record the integration as unavailable and continue. Do not create empty commits, toggle PR state, or post another trigger solely to wake an optional reviewer. For a required reviewer that cannot start, report the blocker instead of retriggering it. If rate limit is hit, do no manually try to trigger another review, just continue polling and working through other reviews/issues.

   This step is complete when every required review and every latest-head review that started has finished, while each optional non-starter has been recorded as unavailable.

3. **Triage their feedback:** Once all reviewers are done, verify each finding against the real code path before acting. Fix everything medium severity and beyond. For low-severity suggestions, fix small local comments that improve repository consistency, naming, style, readability, cleanup, typing, or DRY, especially when they touch code changed by this PR. Reject or skip low-severity suggestions only when they are speculative, depend on an unrealistic/nonexistent scenario, require broad rewrites or extra abstraction, add defensive complexity without a real caller, or address repo-wide/out-of-scope issues not introduced by this PR. When skipping, briefly explain the concrete reason and continue autonomously.

Nitpick is a severity label, not a dismissal. Prefer fixing consistency polish; prefer rejecting imaginary-scenario complexity.

4. **Commit and push:** After implementing changes, commit and push. Treat that push as the review trigger: the reviewers will automatically queue a re-review. 

5. **Loop:** Repeat until a full cycle passes with nothing meaningful left to address from either reviewer.

6. **Double-verify merge-ready:** Rerun the terminal-state and rebase gates first. Then verify twice that (a) every required reviewer and every automatic reviewer that started on the latest commit has finished, while unavailable best-effort reviewers are recorded and their existing comments are triaged, (b) no outstanding required changes remain, and (c) every observed CI failure completed step 1, current CI is green, and the PR is mergeable.

7. **Complete the authorized terminal action.** When the current request explicitly authorizes merging after readiness, invoke `/merge-pr` and follow it through terminal verification. Otherwise report merge-ready and wait.

## Hard rule: merge only with explicit approval

- Approval may be fresh or standing. Treat a direct instruction such as "merge when ready", "merge once green", or "shepherd and merge; don't ask again" as standing approval. After step 6 passes, merge without asking again.
- Generic shepherding, merge-readiness requests, status acknowledgements, thumbs-up reactions, and "all checks green" do not authorize merging.
- If approval is absent or ambiguous, report merge-ready and ask for an explicit merge instruction.

"Pushed a fix" is not done. "All green" reaches the terminal-action decision in step 7.

**Do not stop early while the PR remains open.**

Done means the PR is externally terminal (monitor removed and state reported) or open and merge-ready because merge authorization was absent.
