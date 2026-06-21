---
name: ship-prd
description: Ship a completed post-grill PRD through implementation, mandatory autoreview, pull request creation, and PR shepherding. Use after a grill-me session when the user wants to turn captured decisions into a PR.
---

# Ship PRD

Use the current thread as the orchestrator. This workflow starts after a
grill-me session has already completed; do not run grill-me.

This is a control-plane skill: keep the current thread focused on PRD
reference resolution, orchestration, evidence packaging, and handoff. Put
implementation in a separate thread using `/implement`, and put cold
review and PR shepherding in separate threads.

## Workflow

1. Resolve the PRD reference.
   - If the user explicitly passed a PRD issue, path, or link, use it. Do not
     run `/to-prd`.
   - Otherwise, run `/to-prd` in the current thread, then make sure all
     decisions from the grill-me session have been captured. Update the PRD
     before continuing if anything important is missing.
2. Identify the durable PRD reference: issue URL/number, local file path, or
   document link. Do not start implementation from a chat-only PRD.
3. Decide whether to create task issues before implementation.
   - If the user explicitly says "with issues", "use issues", "break into
     issues", "run to-issues", or similar, run `/to-issues` before
     implementation. This is a routing override, not a suggestion.
4. If the current checkout has unrelated changes that are not part of the PRD
   implementation, create and enter a clean worktree from the intended base
   branch before continuing. In repos that use monke-tools, use the Monke
   worktree flow.
5. Run implementation in a separate thread with only:
   `/implement <durable PRD reference>`
   - Do not restate repo, branch, test, or completion instructions already
     owned by `/implement`, repo docs, or the PRD.
   - If `/to-issues` was run, pass the same parent PRD reference after the
     issues are created.
   - Let `/implement` decide whether to implement the PRD directly or
     orchestrate attached issues.
   - If `/implement` stops after setup, planning, or branch creation without
     commits and verification, treat it as incomplete and resume or report the
     blocker.
6. After implementation completes, commit if needed then run `/autoreview` on a separate
   thread, pass it the PRD. Wait for it to finish before creating the PR.
   - Always run this. Do not treat `/implement`, `/review`, tests, lint, or
     screenshots from implementation as a substitute.
7. Create a ready-for-review PR from the current thread.
8. Run `/shepherd-pr` on a separate thread, then stop. The shepherding
   thread owns polling and follow-up until merge-ready. It must not merge.

## Thread Titles

Choose one short title for the current work, then reuse it in every thread
title from this workflow.

- Orchestrator: `[<short-title-of-current-work>] orchestrate`
- Implementation: `[<short-title-of-current-work>] implement`
- Review: `[<short-title-of-current-work>] review`
- Shepherd: `[<short-title-of-current-work>] shepherd PR #<number>`

Example: `[search-hotkey] orchestrate`, `[search-hotkey] implement`,
`[search-hotkey] review`, `[search-hotkey] shepherd PR #123`.

Rename the current orchestrator thread when its thread id is available or can be
discovered unambiguously. Set delegated review and shepherding thread titles at
creation time; do not create them with generic titles and rename later.

## Monitoring

Monitor delegated work every three minutes. Be patient: after confirming a
worker is active, wait about 180 seconds between polls; do not short-poll with
60-second sleeps. Let active work continue without steering; intervene only for
a blocker, completion, or clear course deviation.

## Task Issues

"With issues" means: run `/to-issues` before launching `/implement`, then run
`/implement` against the parent PRD reference. Do not choose task ordering in
this skill; `/implement` owns direct PRD implementation versus attached issue
orchestration.

## Boundaries
- Do not paste the full PRD body or extra constraints into `/implement`; use
  the slash command with the durable reference.
- Do not create extra code commits from this orchestration thread.
- Let `/implement` own implementation commits.
- Let `/autoreview` own closeout fixes and reruns.
- Let `/shepherd-pr` own PR polling and reviewer follow-up after the PR exists.
