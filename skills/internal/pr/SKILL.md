---
name: pr
description: Create or edit a PR
---

# PR

## Prepare the branch

Use the existing PR's base, the task's specified base, or the repository default.
Rebase the PR branch onto the latest base before analyzing or verifying it.

Exclude research and exploration artifacts,
including `docs/research/` and `docs/explorations/`, unless requested.

## Edit branch documentation
Consolidate new ADRs where possible and have a subagent edit the full diff
against the base, including pending edits and new files. Apply
[technical-writing](../../imported/technical-writing/SKILL.md) to all changed
docs and [writing-for-agents](../../imported/writing-for-agents/SKILL.md) to agent facing docs.

## Load PR requirements

Read root `PR.md` when present. Otherwise read user defaults at
`$(mt home)/instructions/PR.md` when available.

Use the repository's PR template from its default branch, or the
[default template](references/default-pr-template.md).

Link the source issue or Spec. Identify material risks, including rollback limits.

## Choose the explanation

Lead with the problem and resulting behavior. A simple change usually needs one
or two sentences. Aim for under 200 words; expand only for a concrete review
decision or required template field.

For changes to component interactions, state transitions, schemas, API contracts,
or key data structures, invoke `$show-me` for a small GitHub-renderable view.
Use prose alone for simple local changes.

Describe the final implementation. Keep investigation history and reviewer
bookkeeping in work records. Keep each fact in one place and remove prose that
repeats the diff or visual.

Apply [technical-writing](../../imported/technical-writing/SKILL.md) to the title
and body.

## Choose the evidence

Reuse verification that still covers the change, or run the smallest relevant
checks. Report verification only when it adds information beyond routine CI
results: a decisive behavior result, a meaningful benchmark, or a material
verification limitation. Keep test counts, repeated runs, and routine lint,
formatting, typecheck, and test results in work records unless required by the
template or unexpected in a way that affects review.

- For hands-on verification of a locally runnable UI or API, prepare a
  [manual-test handoff](references/manual-test-handoff.md) for the final chat
  response.
- For frontend-visible work, attach a screenshot of each changed view or state,
  or [video](references/browser-video-proof.md) when motion, timing, or a
  workflow carries the claim. Inspect final assets using
  [proof asset review](references/proof-asset-review.md), and use
  `$github-media-upload` to attach them when publishing. Keep screenshots and
  videos expanded; do not put them in collapsed sections. Caption each screenshot
  with the behavior it demonstrates. Use matched, labeled before/after pairs for
  comparisons and group multiple screenshots by claim. Number workflow states.
  Choose side-by-side or stacked layouts based on readability.
- For correctness that requires deployment, include `## Post-Merge Verification`
  with the environment, deployment gate, and concrete checks.

## Publish and verify

Create or update a ready PR after required checks and media review. Use draft only
when requested. If the user requests CodeRabbit ignore the PR, post exactly
`@coderabbitai ignore` as a PR comment.

Verify the published title, body, and attachments. Report the URL and any
manual-test handoff.
