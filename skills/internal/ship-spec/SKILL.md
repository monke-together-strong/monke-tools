---
name: ship-spec
description: Ship an agreed Spec from a supplied thread through implementation, independent review, PR creation, and shepherding. Use when asked to ship the work agreed in a thread.
---

# Ship Spec

## Workflow

1. Read the supplied source thread and any linked Spec. Use its agreed
   requirements and acceptance criteria as the Spec.
2. Spawn the implementation checkout with `$monke-worktrees`:
   `mt spawn <repo-conforming-branch-name>`. Use the returned checkout path.
3. Run `$implement <source thread reference>` directly.
   - If `$implement` stops after setup, planning, or branch creation without
     commits and verification, treat it as incomplete and resume or report the
     blocker.
4. After implementation, code review, and fixes finish, launch one fresh review
   subagent in the implementation checkout. Provide the checkout path and repo
   instructions, the Spec reference, recorded review base, runtime access, and
   the absolute path to [Review fixes](../../references/internal/REVIEW_FIXES.md)
   for the agent to follow. Use this exact prompt:

   > Start `$autoreview` and `$behavior-validator` concurrently on the committed HEAD. Keep the validator source-blind. Resolve findings using the provided Review fixes reference before creating the PR.

   Wait for its completion before creating the PR.
   - Always run this. Do not treat `$implement`, `$code-review`, tests, lint, or
     screenshots from implementation as a substitute.
5. Create the PR and shepherd it.
