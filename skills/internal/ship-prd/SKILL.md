---
name: ship-prd
description: Ship a completed post-grill PRD through implementation, mandatory autoreview, pull request creation, and PR shepherding. Use after a grill-me session when the user wants to turn captured decisions into a PR.
---

# Ship PRD

Use the current Codex thread as the orchestrator. This workflow starts after a
grill-me session has already completed; do not run grill-me.

This is a control-plane skill: keep the current Codex thread focused on PRD
reference resolution, orchestration, evidence packaging, and handoff. Put
implementation in `mt work`, and put cold review and PR shepherding in separate
Codex threads.

## Workflow

1. Resolve the PRD reference.
   - If the user explicitly passed a PRD issue, path, or link, use it. Do not
     run `/to-prd`.
   - Otherwise, run `/to-prd` in the current Codex thread, then make sure all
     decisions from the grill-me session have been captured. Update the PRD
     before continuing if anything important is missing.
2. Identify the durable PRD reference: issue URL/number, local file path, or
   document link. Do not start implementation from a chat-only PRD.
3. Choose the implementation path.
   - Default to the single PRD path.
   - Use the issue path when the user explicitly says "with issues", "use
     issues", "break into issues", "run to-issues", or similar. This is a
     routing override, not a suggestion.
   - Also use the issue path when the PRD is very obviously large.
4. If there are completely unrelated changes on the branch create a new worktree
5. Run implementation.
   - Single PRD path: run `mt work --plan "Implement the PRD at <reference>."`
   - Issue path: run `/to-issues` in the current Codex thread, then run
     `mt work --prd "<parent PRD reference>"`
6. Run `/autoreview` on a separate Codex thread. Wait for it to finish before
   creating the PR.
7. Create a ready-for-review PR from the current Codex thread.
8. Run `/shepherd-pr` on a separate Codex thread, then stop. The shepherding
   thread owns polling and follow-up until merge-ready. It must not merge.

## Monitoring

Monitor delegated work every five minutes. Let active work continue without
steering; intervene only for a blocker, completion, or clear course deviation.

## Issue Path

"With issues" means: run `/to-issues`, then run `mt work --prd` against the
parent PRD reference. Do not use the single PRD path when the user asks for the
issue path.

## Boundaries
- Do not paste the full PRD body into `mt work`; pass the durable reference.
- Do not create extra code commits from this orchestration thread.
- Let `mt work` own implementation commits.
- Let `/autoreview` own closeout fixes and reruns.
- Let `/shepherd-pr` own PR polling and reviewer follow-up after the PR exists.
