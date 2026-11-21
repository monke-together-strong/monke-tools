---
name: pr
description: Create or edit a PR, or brief a delegate that opens one.
---

# PR

## Brief a delegate

Name this skill in the brief, pass facts instead of drafted sections, and allow subagents for documentation review and drafting.

## Prepare the branch

Rebase onto the existing PR base, specified base, or repository default before analyzing or verifying. Exclude exploration artifacts, including `docs/research/` and `docs/explorations/`, unless requested.

- **Changed tests.** When creating a PR whose diff adds or changes tests, run [test audit](../test-audit/SKILL.md) in cleanup mode on those files.
- **Documentation review.** Run [documentation review](../../references/internal/DOC_REVIEW.md) before verification and publishing, and again before pushing later edits to docs, comments, or user-facing messages.

## Load PR requirements

Read root `PR.md` when present, or `$(mt home)/instructions/PR.md` when available. Use the repository PR template from the default branch, or [default template](references/default-pr-template.md). Fit facts requested by a brief or another skill within this skill's rules, and report anything omitted. Link the source issue or Spec and state material risks, including rollback limits.

## Choose the explanation

Lead with one or two sentences on the problem, then show the resulting behavior separately. Aim for under 200 words of prose, expanding only for a concrete review decision or required template field. Give each later point its own short paragraph.

- **Path-change test.** Did behavior change along a path (control flow, error handling, state transitions, component interactions, schemas, or key data structures)? Show before and after with [show-me](../../imported/show-me/SKILL.md) and omit that behavior from prose. Use prose for resulting behavior only when no path changed, such as a rename or configuration value.
- **Contract changes.** Show code blocks of what a consumer writes for public API or configuration contract changes.
- Describe only the final implementation. Keep investigation history and review bookkeeping in work records. Keep each fact in one place and cut prose that repeats the diff or visuals. Apply [technical-writing](../../imported/technical-writing/SKILL.md) to the title and body.

## Choose the evidence

Reuse verification that still covers the change, or run the smallest relevant checks. Report verification only when it adds information beyond routine CI: a decisive behavior result, a meaningful benchmark, or a material limitation. Keep test counts, repeated runs, and routine lint, format, typecheck, and test output in work records unless required or unexpected.

- **Locally runnable UI or API.** Prepare a [manual-test handoff](references/manual-test-handoff.md) for the final chat response.
- **Frontend-visible work.** Attach an expanded screenshot for each changed view or state, or a [video](references/browser-video-proof.md) when motion, timing, or a workflow carries the claim. Inspect final assets with [proof asset review](references/proof-asset-review.md) and upload with `$github-media-upload`. Caption each screenshot with the behavior shown, pair labeled before-and-after comparisons, group shots by claim, number workflow states, and pick side-by-side or stacked layout for readability.
- **Deployment-dependent work.** Add extra verification using [post-merge contract](../post-merge/SKILL.md#load-the-contracts).

## Draft the title and body

Use the writer model (`mt models get writer`). Draft directly when you already run on its first available model or subagents are barred. Otherwise spawn a writer subagent with the diff against base, PR requirements, facts (source issue or Spec, risks, evidence, and media), and pointers to [Choose the explanation](#choose-the-explanation) and [Choose the evidence](#choose-the-evidence), returning the draft without publishing.

Verify every claim in the draft against the diff and evidence before publishing. Send unsupported claims back to the writer with corrections and verify the revision the same way.

## Publish and verify

Open a ready PR after required checks and media review. Use draft only when requested. In T3 Code, publish through `mt prs create` so post-merge tracking registers:

```sh
mt prs create --thread <owning-thread-id> --checkout <PR-checkout> -- \
  --base <base> --head <branch> --title <title> --body-file <body-file>
```

If creation fails, check whether the PR already exists before retrying. Run the reported `mt prs track` command when only registration fails. Outside T3 Code, use `gh pr create`. Update existing PRs with `gh pr edit`. If the user asks CodeRabbit to ignore the PR, post `@coderabbitai ignore` as a PR comment.

Verify the published title, body, and attachments, then report the URL and any manual-test handoff.
