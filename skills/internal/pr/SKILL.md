---
name: pr
description: Create or edit a PR
---

# PR

Apply [technical-writing](../../imported/technical-writing/SKILL.md) to the title
and body.

## Prepare the branch

Use the existing PR's base, the task's specified base, or the repository default.
Rebase the PR branch onto the latest base before analyzing or verifying it.

Consolidate new ADRs where possible. Exclude research and exploration artifacts,
including `docs/research/` and `docs/explorations/`, unless requested.

## Edit branch documentation

When the branch changes documentation, have a subagent edit the full diff
against the base, including pending edits and new files. Apply
[technical-writing](../../imported/technical-writing/SKILL.md) to all changed
docs and [writing-for-agents](../../imported/writing-for-agents/SKILL.md) to
agent-facing instructions. Wait for the subagent and review its edits before
verification and publishing.

## Load PR requirements

Read root `PR.md` when present. Otherwise read user defaults at
`$(mt home)/instructions/PR.md` when available.

Use the repository's PR template from its default branch, or the
[default template](references/default-pr-template.md).

Link the source issue or Spec. Identify material risks, including rollback limits.

## Choose the explanation

For changes to component interactions, state transitions, schemas, API contracts,
or key data structures, invoke `$show-me` for a small GitHub-renderable view.
Use prose alone for simple local changes.

## Choose the evidence

Reuse verification that still covers the change, or run the smallest relevant
checks. Include available before-and-after evidence and material verification
limits.

- For hands-on verification of a locally runnable UI or API, prepare a
  [manual-test handoff](references/manual-test-handoff.md) for the final chat
  response.
- For frontend-visible work, attach a screenshot of each changed view or state,
  or [video](references/browser-video-proof.md) when motion, timing, or a
  workflow carries the claim. Inspect final assets using
  [proof asset review](references/proof-asset-review.md), upload them with
  `$github-image-upload`, and embed the GitHub attachments.
- For correctness that requires deployment, include `## Post-Merge Verification`
  with the environment, deployment gate, and concrete checks.

## Publish and verify

Create or update a ready PR after required checks and media review. Use draft only
when requested. If the user requests CodeRabbit ignore the PR, post exactly
`@coderabbitai ignore` as a PR comment.

Verify the published title, body, and attachments. Report the URL and any
manual-test handoff.
