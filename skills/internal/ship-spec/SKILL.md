---
name: ship-spec
description: Ship a completed post-grill Spec through implementation, mandatory autoreview, pull request creation, and PR shepherding. Use after a grill-me session when the user wants to turn captured decisions into a PR.
---

# Ship Spec

Use the current agent as the orchestrator. This workflow starts after a
grill-me session has already completed; do not run grill-me.

Use native subagents and wait for completion notifications or the host's wait
tool. In each handoff, include: "Checkout: <absolute path>. Read its repo
instructions, use absolute file paths, and anchor every command to this checkout."

## Workflow

1. Resolve the Spec reference.
   - If the user explicitly passed a Spec issue, path, or link, use it. Do not
     run `$to-spec`.
   - Otherwise, run `$to-spec` in the current agent. Then make sure all
     decisions from the grill-me session have been captured. Update the Spec
     before continuing if anything important is missing.
2. Identify the durable Spec reference: issue URL/number, local file path, or
   document link. Do not start implementation from a chat-only Spec.
3. Decide whether to create task issues before implementation.
   - If the user explicitly says "with issues", "use issues", "break into
     issues", "run to-tickets", or similar, run `$to-tickets` before
     implementation. This is a routing override, not a suggestion.
4. Spawn the implementation checkout with `$monke-tools-core`:
   `mt spawn <repo-conforming-branch-name>`. Use the returned checkout path.
5. Launch a fresh native implementation subagent with
   `$implement <durable Spec reference>` and the checkout instructions above.
   - Do not restate repo, branch, test, or completion instructions already
     owned by `$implement`, repo docs, or the Spec.
   - If `$to-tickets` was run, pass the same parent Spec reference after the
     issues are created.
   - If `$implement` stops after setup, planning, or branch creation without
     commits and verification, treat it as incomplete and resume or report the
     blocker.
6. After implementation, code review, and fixes finish, launch a fresh review
   subagent in the implementation checkout to run `$autoreview` against the Spec
   using the recorded review base. When the change has a user-visible surface
   (UI, CLI, API, generated artifact), that agent also runs `$behavior-validator`,
   using the Spec as the behavior contract. Wait for review and any fixes to
   finish before creating the PR.
   - Always run this. Do not treat `$implement`, `$code-review`, tests, lint, or
     screenshots from implementation as a substitute.
7. Create a ready-for-review PR from the implementation checkout.
8. Launch a native `$shepherd-pr` subagent with the same checkout and the PR
   reference. It owns PR polling and follow-up until merge-ready. It must not
   merge. Wait for its result and resume it if work remains.

## Agent names

Choose one short title for the current work and use it in each subagent's name
or description at creation time:

- Implementation: `[<short-title-of-current-work>] implement`
- Code review: `[<short-title-of-current-work>] code-review`
- Shepherd: `[<short-title-of-current-work>] shepherd PR #<number>`

## Task Issues

"With issues" means: run `$to-tickets` before launching `$implement`, then run
`$implement` against the parent Spec reference. Do not choose task ordering in
this skill; `$implement` owns direct Spec implementation versus attached issue
orchestration.

## Boundaries
- Invoke `$implement` with the durable Spec reference and checkout instructions;
  leave product and process requirements in the Spec and owning skills.
- Do not create extra code commits from the orchestrator.
- Let `$implement` own implementation commits.
- Let the review agent own fixes and reruns for `$autoreview` and
  `$behavior-validator` findings.
- Let `$shepherd-pr` own PR polling and reviewer follow-up after the PR exists.
