---
id: TASK-14
title: 'PRD: Add mt cleanup --merged for merge-cleanable sessions'
status: To Do
assignee: []
created_date: '2026-06-16 17:19'
updated_date: '2026-06-16 17:19'
labels:
  - ready-for-agent
dependencies: []
references:
  - docs/adr/0003-remove-only-worktrees-for-merge-cleanable-session-cleanup.md
  - tmp/merged-worktree-cleanup-real-gh/NOTES.md
  - tmp/merged-worktree-cleanup-real-gh/scratch/results.json
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem Statement

Developers using monke-tools accumulate Session worktrees after their Session branches have been merged. Today, `mt cleanup` only removes Session state for Dead worktrees; it does not help identify or remove live worktrees that are safe to discard. The user wants `Cleanup` to reclaim finished Session checkouts automatically without losing dirty changes, local commits, ignored session artifacts unexpectedly outside the agreed worktree boundary, or ambiguous branch history.

## Solution

Add a conservative `mt cleanup --merged` flow for **Merge-cleanable Sessions**. The command uses same-repository **Merged PR** evidence from GitHub plus local Git checks to decide whether each recorded **Session worktree** can be removed. The first interaction is `mt cleanup --merged --dry-run`, which reports eligible and skipped Sessions with explicit reasons. `mt cleanup --merged` removes only eligible Session worktree directories, including ignored files inside those directories, and then relies on existing `Cleanup` behavior to run Cleanup commands and remove now-dead Session state. Local branches are preserved in v1.

The validated predicate is:

```text
worktree cleanup is eligible only when:
  session worktree path exists
  path is the root of a Git worktree
  worktree belongs to the expected Git repository
  worktree branch equals the session branch
  normal Git status is clean, including untracked files
  GitHub returns exactly one same-repository merged PR for head=session and base=defaultBranch
  local HEAD equals that merged PR's headRefOid
```

Anything outside that predicate is skipped with an explicit reason.

## User Stories

1. As a developer, I want to preview Merge-cleanable Sessions, so that I can see what monke-tools would remove before it deletes any worktree directories.
2. As a developer, I want `mt cleanup --merged` to remove only proven-safe Session worktrees, so that I can reclaim local disk space without losing active work.
3. As a developer, I want skipped Sessions to include clear reasons, so that I know whether the blocker is dirty files, local commits, ambiguous PRs, missing GitHub data, or a broken worktree path.
4. As a developer, I want dirty tracked files to block cleanup, so that uncommitted work is not deleted.
5. As a developer, I want untracked files to block cleanup, so that scratch work is not deleted accidentally.
6. As a developer, I want local commits after a Merged PR to block cleanup, so that post-merge local work survives.
7. As a developer, I want local branches that are behind or diverged from the Merged PR head to block cleanup, so that only exact proven branch content is removed.
8. As a developer, I want ignored files inside an eligible Session worktree to be removed with the worktree, so that cleanup reclaims the whole session checkout once the safety predicate passes.
9. As a developer, I want local branch refs preserved in v1, so that worktree cleanup does not cross into branch lifecycle policy.
10. As a developer, I want branch-name reuse to skip cleanup, so that monke-tools does not guess which Merged PR represents the Session.
11. As a developer, I want forked or cross-repository PR matches to skip cleanup, so that same branch names in other repositories cannot prove local cleanup eligibility.
12. As a developer, I want detached worktrees to skip cleanup, so that monke-tools does not remove a checkout whose Session identity is not proven.
13. As a developer, I want branch mismatches to skip cleanup, so that monke-tools does not remove a worktree that no longer matches Session state.
14. As a developer, I want wrong-repository paths to skip cleanup, so that stale or corrupted Session state cannot remove unrelated checkouts.
15. As a developer, I want missing worktree paths to continue through existing Dead worktree cleanup, so that merged cleanup composes with current Cleanup behavior.
16. As a developer, I want Cleanup commands to run after eligible worktrees are removed, so that repo-owned teardown still gets its existing retry semantics.
17. As a developer, I want GitHub authentication or availability failures to skip safely, so that cleanup never falls back to guessing.
18. As a developer, I want the command output to summarize removed and skipped Sessions, so that I can trust what changed.
19. As a developer maintaining monke-tools, I want the cleanup predicate isolated behind testable decision logic, so that new GitHub/Git edge cases can be added without rewriting command behavior.
20. As a developer maintaining monke-tools, I want CLI-level tests to cover the user-facing behavior, so that the command contract remains stable.
21. As a developer maintaining monke-tools, I want same-repository Merged PR lookup covered by fakes or fixtures, so that tests do not require live GitHub access.
22. As a developer maintaining monke-tools, I want the implementation to respect existing Session state and Cleanup terminology, so that the feature fits the current domain model.

## Implementation Decisions

- Add `--merged` and `--dry-run` flags to `mt cleanup`.
- Keep default `mt cleanup` behavior unchanged: remove only Dead Session state and run existing Cleanup commands when recorded worktree paths are already gone.
- Implement merged cleanup as a core lifecycle behavior, not only as an agent skill or standalone helper.
- Do not delete local branches in v1. ADR 0003 records that branch deletion is a separate policy even though the prototype found a safe branch predicate.
- Remove the entire eligible Session worktree directory. Ignored files inside the eligible Session worktree are considered part of that disposable checkout.
- Preserve the local branch ref as the recovery boundary after worktree removal.
- Use GitHub PR metadata as the merge proof. Git ancestry is not a valid proof for squash-merged branches.
- Query same-repository merged PRs by session branch and default branch. The GitHub result must include `headRefOid`.
- Require exactly one matching Merged PR. Zero matches, multiple matches, non-default-base matches, open PRs, and closed-unmerged PRs skip.
- Require the local Session worktree branch to equal the Session name.
- Require local `HEAD` to equal the matching Merged PR `headRefOid`.
- Require normal Git status to be clean, including untracked files.
- Validate that the recorded worktree path exists, is a Git worktree root, and belongs to the expected source repository before considering removal.
- After removing eligible worktree paths, reuse existing Cleanup behavior so Cleanup commands run and Session state is removed only after teardown succeeds.
- Report every decision as removed, would-remove, or skipped with explicit reasons.
- Keep PR receipts out of v1. The command derives proof from GitHub at cleanup time.
- The real-GitHub prototype's decision-rich predicate is the source of truth for the first implementation:

```text
eligible only if:
  session worktree path exists
  path is the root of a Git worktree
  worktree belongs to the expected Git repository
  worktree branch equals the session branch
  normal Git status is clean, including untracked files
  GitHub returns exactly one merged PR for head=session and base=defaultBranch
  local HEAD equals that merged PR's headRefOid
```

## Testing Decisions

- Test external behavior through the CLI wherever possible: command output, worktree removal, Session state cleanup, Cleanup command retry behavior, and dry-run no-op behavior.
- Prefer existing cleanup/recovery tests as prior art because they already verify Dead worktree cleanup, Cleanup commands, and retry semantics.
- Add focused tests for the decision logic with fake GitHub PR metadata and fake local Git/worktree snapshots, covering the full skip/eligible matrix without live GitHub calls.
- Test that `mt cleanup` without `--merged` keeps existing behavior unchanged.
- Test that `mt cleanup --merged --dry-run` reports eligible worktrees but does not remove directories or Session state.
- Test that `mt cleanup --merged` removes only eligible Session worktree directories and then lets existing Cleanup remove eligible Session state.
- Test that dirty tracked files, untracked files, local HEAD differing from `headRefOid`, branch mismatch, detached worktree, missing PR, multiple PR matches, wrong repo, and non-worktree paths all skip with clear reasons.
- Test that ignored files inside an otherwise eligible Session worktree do not block cleanup and are removed with the worktree.
- Test GitHub failure or unavailable metadata as a safe skip rather than a hard destructive fallback.
- Do not rely on live GitHub in normal test runs. The real-GitHub prototype remains evidence for behavior that would be expensive or flaky in the test suite.

## Out of Scope

- Deleting local branches.
- Force-deleting branches.
- Creating or storing PR receipts in Session state.
- Supporting forked or cross-repository PR proofs.
- Choosing the latest PR when branch names are reused.
- Cleaning arbitrary non-monke worktrees.
- Changing Default branch create mode.
- Changing existing Resource cleanup or Cleanup command semantics beyond composing with removed worktrees.
- Replacing the Backlog task `TASK-4`; this PRD defines the narrower, validated `mt cleanup --merged` behavior.

## Further Notes

- ADR 0003 records the worktree-only policy and the rejected branch-deletion options.
- A local Git prototype and a real-GitHub prototype validated the safety predicate before this PRD was written.
- The final real-GitHub prototype run covered 21/21 expected decisions, including clean squash merge, dirty changes, local commits, branch divergence, ambiguous PRs, non-default-base PRs, deleted remote head branch, detached worktree, wrong repo, duplicate worktree branch use, and ignored files.
- The latest real-GitHub prototype artifacts live under `tmp/merged-worktree-cleanup-real-gh/` in the local checkout. They are throwaway evidence, not production code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 mt cleanup without --merged keeps the existing Dead worktree cleanup behavior.
- [ ] #2 mt cleanup --merged --dry-run reports eligible and skipped Merge-cleanable Sessions without removing worktrees or Session state.
- [ ] #3 mt cleanup --merged removes only eligible Session worktree directories and preserves local branch refs.
- [ ] #4 Eligible cleanup requires exactly one same-repository Merged PR for the session branch/default branch and local HEAD equal to that PR headRefOid.
- [ ] #5 Dirty tracked files, untracked files, local commit drift, branch mismatch, detached worktrees, wrong repo paths, missing PRs, and multiple matching PRs all skip with explicit reasons.
- [ ] #6 Ignored files inside an otherwise eligible Session worktree are removed with the whole worktree.
- [ ] #7 After eligible worktree removal, existing Cleanup commands and Session state retry semantics are preserved.
- [ ] #8 Automated tests cover the user-facing CLI behavior and the cleanup decision matrix without requiring live GitHub access.
- [ ] #9 Merged PR proof verifies the PR head repository matches the local source repository; forked or cross-repository PR matches skip.
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-06-16 17:19
---
Validation follow-up: same-repository matching was already captured in the PRD/ADR, and this acceptance criterion makes the required head-repository verification explicit so branch-name lookup is not treated as sufficient by itself.
---
<!-- COMMENTS:END -->
