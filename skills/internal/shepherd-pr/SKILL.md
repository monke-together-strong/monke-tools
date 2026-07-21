---
name: shepherd-pr
description: 'Shepherd a GitHub pull request all the way to merge-ready by relentlessly polling status and only acting once all automatic reviewers have finished. NEVER merges without explicit human approval. Use when the user says things like "shepherd this PR", "babysit this PR", "get this PR merge-ready", "poll for Coderabbit", "wait for Coderabbit", or asks to drive a PR through review.'
---

# Shepherd PR

Your job is to shepherd this PR all the way to **merge-ready** - reviewed, addressed, verified, and CI green. **Not merged.** Merging is a human decision.

Create the PR (or pick up the one just created), then mark it as ready for review if needed.

## Check terminal state first

On initial pickup and every heartbeat or re-entry, check PR state before CI or reviews:

```bash
gh pr view https://github.com/OWNER/REPO/pull/NUMBER --json state,mergedAt,closedAt,mergeCommit
```

If `state` is `MERGED` or `CLOSED`, delete the heartbeat, report the terminal state (including merge time and commit when available), and stop—even if jobs remain active. Only `OPEN` continues.

1. **Wait for reviewers:** Run `/polling` with an eight-minute heartbeat until all automatic reviewers have finished reviewing the latest commit. Do not act on partial feedback.

2. **Triage their feedback:** Once all reviewers are done, verify each finding against the real code path before acting. Fix everything medium severity and beyond. For low-severity suggestions, fix small local comments that improve repository consistency, naming, style, readability, cleanup, typing, or DRY, especially when they touch code changed by this PR. Reject or skip low-severity suggestions only when they are speculative, depend on an unrealistic/nonexistent scenario, require broad rewrites or extra abstraction, add defensive complexity without a real caller, or address repo-wide/out-of-scope issues not introduced by this PR. When skipping, briefly explain the concrete reason and continue autonomously.

Nitpick is a severity label, not a dismissal. Prefer fixing consistency polish; prefer rejecting imaginary-scenario complexity.

3. **Commit and push:** After implementing changes, commit and push. Then go back to step 1 - the reviewers will automatically re-review your new push.

4. **Loop:** Repeat until a full cycle passes with nothing meaningful left to address from either reviewer.

5. **Double-verify merge-ready:** Before declaring the PR merge-ready, verify twice that (a) all reviewers have re-run on the latest commit, (b) no outstanding required changes remain, and (c) CI is green and the PR is mergeable.

6. **Stop. Hand off to human.** Report that the PR is merge-ready and wait. **Do not merge.**

## Hard rule: never merge without explicit approval

- NEVER run `gh pr merge`, the GitHub merge API, or any equivalent action on your own.
- "All checks green" is NOT permission to merge. It is permission to stop and report.
- Even if the user originally said "get this PR merged", treat that as "get this PR merge-ready" and ask for explicit confirmation before merging.
- Only merge if the user replies with an explicit, unambiguous YES to merge after you've reported merge-ready (e.g. "yes merge it", "go ahead and merge"). A thumbs-up or "ok" is not enough - ask again if unclear.
- If in doubt, do not merge. Ask.

"Pushed a fix" is not done. "All green" is not done either - it's the handoff point.

**Do not stop early while the PR remains open. Do not merge on your own.**

Done means the PR is externally terminal (monitor removed and state reported) or open and merge-ready (double-checked and handed off).
