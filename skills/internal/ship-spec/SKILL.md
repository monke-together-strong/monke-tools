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
4. After implementation, code review, and fixes finish, launch a fresh review
   subagent in the implementation checkout to run `$autoreview` against the Spec
   using the recorded review base. When the change has a user-visible surface
   (UI, CLI, API, generated artifact), that agent also runs `$behavior-validator`,
   using the Spec as the behavior contract. That agent owns review fixes.
   Wait for review and any fixes to finish before creating the PR.
   - Always run this. Do not treat `$implement`, `$code-review`, tests, lint, or
     screenshots from implementation as a substitute.
5. Create the PR and shepherd it.
