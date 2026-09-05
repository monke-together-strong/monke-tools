---
name: create-pr
description: Create a GitHub PR when asked to open or update a pull request, or prepare a branch for review.
---

# Create PR

Create one self-contained PR. Finish by verifying the published result and
reporting it to the user.

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
`$(mt home)/instructions/PR.md` when available. Apply the writing guidance below
alongside these repository or user requirements.

Find GitHub-recognized PR templates on the repository's default branch in the
root, `docs/`, `.github/`, and their `PULL_REQUEST_TEMPLATE/` directories. Select
according to `PR.md` or the work. Preserve required template fields and checklists;
without a repo template, use the
[default template](references/default-pr-template.md). The selected guidance and
template determine which evidence and body sections are required.

## Choose the evidence

Reuse recorded verification that still covers the change, or run the smallest
relevant checks. Scale additional evidence to the behavior:

- For a locally runnable UI or API that benefits from hands-on verification,
  prepare a [manual-test handoff](references/manual-test-handoff.md) and reuse
  that running target for proof.
- For frontend-visible work, attach screenshots of the changed state or
  [video](references/browser-video-proof.md) when motion, timing, or a workflow
  carries the claim. Inspect final assets using
  [proof asset review](references/proof-asset-review.md), upload them with
  `$github-image-upload`, and embed the GitHub attachments.
- For changes whose correctness depends on deployment, migration, or the target
  environment, include `## Post-Merge Verification` with `Environment`,
  `Deployment gate`, and concrete `Checks`. Mark unknowns explicitly. Omit this
  section when pre-merge evidence is sufficient, unless repo instructions require
  it; in that case use `Not required: <reason>`.

Evidence is complete when required pre-merge checks have recorded results,
required media has passed asset review and is embedded from GitHub, and
environment-dependent checks have a post-merge contract. A post-merge contract
covers only checks that depend on that environment. Report missing required
pre-merge evidence and resolve it before publishing.

## Write the body

Write for a reviewer who has not seen the conversation. Lead with the problem
and resulting behavior. Select implementation details that explain correctness,
a tradeoff, or a review decision; group broad changes by purpose. Link the source
PRD or issue when available. A small PR usually needs one or two sentences and
relevant checks.

Summarize verification supporting the final change, consolidating repeated runs
into relevant checks and results. Retain material limitations and unresolved
uncertainty. Describe the final implementation rather than the work chronology,
superseded approaches, or reviewer bookkeeping.

When understanding the change requires tracking multiple owners, stages, states,
or ordering constraints, use `$show-me` to choose the smallest GitHub-renderable
view. Let the visual carry those relationships, with adjacent prose explaining
their significance. Simple changes can stay in prose.

Before publishing, edit the body until each paragraph or bullet contributes a
distinct explanation, review decision, or piece of evidence. Keep optional
sections only when they contain substantive content; explain skipped checks only
when they leave a material verification gap. Preserve required template fields.

## Publish and verify

Push normally, setting the upstream if absent. If rebasing rewrote the published
branch, push with `git push --force-with-lease`. Create a ready PR with
`gh pr create --title ... --body-file ...`, or update the existing PR. Use draft
only when requested. If the user requests CodeRabbit ignore the PR, post exactly
`@coderabbitai ignore` as a PR comment.

Read back `gh pr view --json url,title,body`. Correct discrepancies until the
published title and body match the prepared description, required template
fields are filled, and applicable attachments and post-merge checks are present.
Report the URL and any manual-test handoff.
