---
name: create-pr
description: Create a GitHub PR when asked to open or update a pull request, or prepare a branch for review.
---

# Create PR

Create one self-contained PR describing the problem, resulting behavior, and
verification. Stop after verifying the published PR.

## Prepare the branch

Resolve the intended base from the existing PR, explicit task instructions, or
repository default. Check the branch and worktree before rebasing; never rebase
the base branch itself. Commit relevant changes and ask before touching unrelated
work. Fetch and rebase onto the latest base before analyzing or verifying the PR;
use `$resolving-merge-conflicts` if needed.

Inspect the rebased commits and diff, and confirm the base is an ancestor of
`HEAD`. Consolidate new ADRs where possible. Exclude research notes and artifacts,
including `docs/research/`, unless the user asks to publish them.

## Load PR requirements

Read root `PR.md` when present. Otherwise read user defaults at
`$(mt home)/instructions/PR.md` when available, falling back to the
[default PR instructions](references/default-pr-instructions.md).

Find GitHub-recognized PR templates on the repository's default branch in the
root, `docs/`, `.github/`, and their `PULL_REQUEST_TEMPLATE/` directories. Select
according to `PR.md` or the work. Preserve required template fields and checklists;
without a repo template, use the
[default template](references/default-pr-template.md). The selected guidance and
template determine which evidence and body sections are required.

## Choose the evidence

Reuse recorded verification that still covers the change, or run the smallest
relevant checks. Scale additional evidence to the behavior:

- For frontend-visible work, attach screenshots of the changed state or
  [video](references/browser-video-proof.md) when motion, timing, or a workflow
  carries the claim. Inspect final assets using
  [proof asset review](references/proof-asset-review.md), upload them with
  `$github-image-upload`, and embed the GitHub attachments.
- For a locally runnable UI or API that benefits from hands-on verification,
  prepare a [manual-test handoff](references/manual-test-handoff.md) and reuse
  that running target for proof.
- For changes whose correctness depends on deployment, migration, or the target
  environment, include `## Post-Merge Verification` with `Environment`,
  `Deployment gate`, and concrete `Checks`. Mark unknowns explicitly. Omit this
  section when pre-merge evidence is sufficient, unless repo instructions require
  it; in that case use `Not required: <reason>`.

Before publishing, account for each applicable proof requirement with recorded
checks, inspected attachments, or a post-merge contract. Missing required proof
blocks publication; report what is unavailable. Link the source PRD when one exists.

## Write and publish

Use a GitHub-renderable `$show-me` diagram when it makes relationships or control
flow easier to assess.

Push the branch, setting its upstream if absent. Create a ready PR with
`gh pr create --title ... --body-file ...`, or update the existing PR. Use draft
only when requested. If the user requests CodeRabbit ignore the PR, post exactly
`@coderabbitai ignore` as a PR comment.

Read back `gh pr view --json url,title,body` and verify the intended content and
applicable attachments and contract. Report the URL and any manual-test handoff.
