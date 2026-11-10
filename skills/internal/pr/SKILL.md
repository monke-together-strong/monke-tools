---
name: pr
description: Create or edit a PR
---

# PR

## Brief a delegate

When a delegate will open the PR, name this skill in the brief, pass facts
rather than body sections, and allow a subagent for each documentation review run.

## Prepare the branch

Use the existing PR's base, the task's specified base, or the repository default.
Rebase the PR branch onto the latest base before analyzing or verifying it.

Exclude research and exploration artifacts,
including `docs/research/` and `docs/explorations/`, unless requested.

## Audit changed tests

When creating a PR whose diff adds or changes tests, run
[test audit](../test-audit/SKILL.md) in cleanup mode on those test files, then
continue here.

## Review branch documentation, comments, and terminology

Run the [documentation review](../../references/internal/DOC_REVIEW.md) before
verification and publishing, and again before pushing any later commit that
changes documentation, comments, or user-facing messages.

## Load PR requirements

Read root `PR.md` when present. Otherwise read user defaults at
`$(mt home)/instructions/PR.md` when available.

Use the repository's PR template from its default branch, or the
[default template](references/default-pr-template.md).

Treat content a brief or another skill requests as facts to cover within this
skill's length, evidence, and history rules, and report anything you left out.

Link the source issue or Spec. Identify material risks, including rollback limits.

## Choose the explanation

Lead with a paragraph of one or two sentences on the problem, then show the
resulting behavior separately. Aim for under 200 words of prose; expand only for
a concrete review decision or required template field. Give each later point its
own short paragraph.

When the change alters behavior along a path, such as control flow, error
handling, state transitions, component interactions, schemas, or key data
structures, apply [show-me](../../imported/show-me/SKILL.md) to show the before
and after, and leave that behavior out of the prose. Use prose for the resulting
behavior only when no such path changes, as in a rename or a configuration value.

For changes to a public API or configuration contract, show code blocks of what
a consumer writes.

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
  with any environment, deployment gate, and concrete checks that root
  `POST_MERGE.md` does not already cover. When it is absent, read the Source
  checkout's root `POST_MERGE.md` if git ignores it there.

## Publish and verify

Create or update a ready PR after required checks and media review. In T3 Code,
create it through `mt prs create` so publishing includes post-merge registration:

```sh
mt prs create --thread <owning-thread-id> --checkout <PR-checkout> -- \
  --base <base> --head <branch> --title <title> --body-file <body-file>
```

If registration fails after creation, follow its recovery command for the
existing PR.
Outside T3 Code, use `gh pr create`. Update existing PRs with `gh pr edit`.
Use draft only when requested. If the user requests CodeRabbit ignore the PR,
post exactly `@coderabbitai ignore` as a PR comment.

Verify the published title, body, and attachments. Report the URL and any
manual-test handoff.
