---
name: create-pr
description: Create or edit a PR
---

# Create or edit PR

Create or edit short PR explaining the problem, changed behavior, and evidence needed
to review it. Keep the full investigation in the work records.

## Prepare the branch

Resolve the intended base from the existing PR, explicit task instructions, or
repository default. Check the branch and worktree before rebasing; never rebase
the base branch itself. Commit relevant changes and ask before touching unrelated
work. Fetch and rebase onto the latest base before analyzing or verifying the PR;
use `$resolving-merge-conflicts` if needed.

Inspect the rebased commits and diff, and confirm the base is an ancestor of
`HEAD`. Consolidate new ADRs where possible. Exclude research and exploration
notes and artifacts, including `docs/research/` and `docs/explorations/`, unless
the user asks to publish them.

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

## Choose the explanation

Before drafting, if the diff changes interactions between components, processes,
workers, services, or states, invoke `$show-me` and create one small
GitHub-renderable view. It carries ownership, flow, or ordering; prose explains
the problem and significance. Use prose alone for a local change that fits in
two sentences.

Aim for 100–200 words of prose, often less. Expand for a concrete review decision
or required template field; link background material for depth.

## Choose the evidence

Reuse recorded verification that still covers the change, or run the smallest
relevant checks. Scale additional evidence to the behavior:

- For a locally runnable UI or API that benefits from hands-on verification,
  prepare a [manual-test handoff](references/manual-test-handoff.md) for the
  final chat response only. Reuse that running target for PR verification proof.
- For frontend-visible work, attach a screenshot of each changed view or state,
  or [video](references/browser-video-proof.md) when motion, timing, or a
  workflow carries the claim. Inspect final assets using
  [proof asset review](references/proof-asset-review.md), upload them with
  `$github-image-upload`, and embed the GitHub attachments.
- For deployment-dependent correctness, include `## Post-Merge Verification`:
  name the environment, unresolved deployment gate, and observable success
  condition in one to three short bullets. Link an existing runbook for the
  procedure. Otherwise omit this section unless the repo template requires it.

Complete required pre-merge checks and media review before publishing. Reserve
post-merge checks for evidence that requires the target environment.

## Write the body

Lead with the problem and resulting behavior in one or two sentences. Add the
chosen visual and material tradeoffs or risks. Link the source issue or Spec;
the diff carries file details.

Verification should records what CI cannot prove: a decisive
behavior result, a benchmark, or a material limitation such as coverage the
environment blocked. CI runs the checks it is configured for on every PR, so a
reviewer already assumes lint, typecheck, and the suites passed; name one only
when its result would surprise them.

Read the draft as a reviewer: can the opening and visual explain the change?
Keep each fact in one place and remove prose that repeats the visual or diff.
Preserve required template fields.

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
