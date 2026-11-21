---
name: ship-spec
description: Ship an agreed Spec, given as its URL or the thread that agreed it, through implementation, independent review, PR creation, and shepherding. Use when asked to ship a Spec or the work agreed in a thread.
---

# Ship a Spec

1. Read the supplied Spec or source thread, and any Spec it links. Use the
   agreed requirements and acceptance criteria as the Spec.
2. Spawn the implementation checkout with `$monke-worktrees`:
   `mt spawn <repo-conforming-branch-name>`. If the Spec names a
   `Working branch:`, start from that branch (or spawn it directly) so its
   committed docs are included. Use the returned checkout path.
3. Run `$implement <Spec URL or source thread reference>` directly.
   - If `$implement` stops after setup, planning, or branch creation without
     commits and verification, treat it as incomplete and resume or report the
     blocker.
4. After implementation, code review, and fixes finish, start
   [$autoreview](../../imported/autoreview/SKILL.md) and
   [$behavior-validator](../../imported/behavior-validator/SKILL.md)
   concurrently on the committed HEAD from this thread, both on the reviewer
   model (`mt models get reviewer`).
   Use the recorded review base for AutoReview and the Spec as the behavior
   contract. Delegate behavior validation to a fresh source-blind subagent.
   Freshness applies to agent context. Select and own the validation
   environment in this thread, reuse suitable runtimes and fixtures, and confirm
   the code version under test. Create new environments only when the contract
   or isolation requires them. Clean up temporary resources after validation.
   Resolve findings and verify completion using
   [Review fixes](../../references/internal/REVIEW_FIXES.md).

   Always run both checks. Do not treat `$implement`, `$code-review`, tests,
   lint, or screenshots from implementation as a substitute.
5. Create the PR with `$pr` and shepherd it with `$shepherd-pr`.
