---
name: create-pr
description: Create a GitHub pull request. Use when the user asks to open a PR or prepare the current branch for review; include media proof for frontend work.
---

# Create PR

Create one clear GitHub PR. Keep the body short, prove what changed, publish a
self-contained post-merge contract, and stop after the PR exists.

## Workflow

1. Rebase onto the latest intended base.
   - Determine the intended base from an existing PR when one exists;
     otherwise use the repository default branch unless the task names a
     different base.
   - Check `git status --short` and the current branch before rebasing. Never
     rebase the base branch itself.
   - If there are uncommitted changes that look relevant, commit them before
     rebasing. If they look unrelated, ask before touching them.
   - Run `git fetch origin <base>` and `git rebase origin/<base>` before any PR
     analysis or verification.
   - If the rebase conflicts, follow `$resolving-merge-conflicts`; do not push
     until the rebase is complete and verified.

2. Inspect the rebased branch.
   - Check the branch upstream and the commits/diff against the intended base.
   - Confirm the latest intended base is an ancestor of `HEAD`.
   - Consolidate new ADRs into as few as possible.
   - Exclude research notes and artifacts, including `docs/research/`, unless
     the user explicitly asks to publish them. Research may inform the PR, but it is not part of the deliverable by default.

3. Collect proof.
   - Record the verification commands already run, or run the smallest
     relevant checks before creating the PR.
   - For work with a locally runnable user-visible surface, prepare a
     [manual-test handoff](references/manual-test-handoff.md) and reuse its
     target for proof.
   - For frontend-visible work, attach proof. Use screenshots when one final
     state proves the change; use
     [browser video proof](references/browser-video-proof.md) when the behavior
     is workflow-shaped, timing-sensitive, or hard to trust from screenshots
     alone. There can be more than 1 screenshot or video.
   - Before upload, pass every final media asset through the
     [proof asset review](references/proof-asset-review.md).
   - Upload local media with `$github-image-upload`; embed the returned
     GitHub attachment markdown or bare video URLs in the PR body. Do not leave
     local file paths as proof.

   Proof collection is complete when relevant checks are recorded and every
   required media asset passes the Evidence Gate and is embedded from GitHub.

4. Load PR instructions and write the PR body.
   - Read root `PR.md` when present.
   - Otherwise load optional user defaults with
     `monke_home_path="$(mt home 2>/dev/null)" && user_pr_path="$monke_home_path/instructions/PR.md" && [ -f "$user_pr_path" ] && cat "$user_pr_path" || true`.
   - If neither exists, use the
     [default PR instructions](references/default-pr-instructions.md).
   - Always search the repository's default branch for GitHub-recognized
     `pull_request_template.md` files in the root, `docs/`, `.github/`, and
     `PULL_REQUEST_TEMPLATE/` directories. If several exist, follow `PR.md` or
     use the one matching the work.
   - Preserve the selected template's structure and checklists. If no
     repository template exists, use the
     [default PR template](references/default-pr-template.md). Fill matching
     fields and add only required content the template does not cover.
   - Combine the selected instructions, the PRD/issue, and the diff into
     concise checks for the merged code in a non-production or production-like
     environment.
   - The contract is complete when it says `Not required: <reason>` or names
     `Environment`, `Deployment gate`, and `Checks`. Mark unknown details
     explicitly, such as `Environment: ask user`.
   - The body is complete when it follows the selected instructions and
     template, including every required field and checklist.

5. Create the PR.
   - Push with `git push -u origin HEAD` if the branch has no upstream.
   - Create a ready PR by default with `gh pr create --title ... --body-file
     ...`; use draft only when the user asks.
   - If a PR already exists for the branch, update it instead of creating a
     duplicate.
   - If the user asks CodeRabbit to ignore the PR, add a PR comment containing
     exactly `@coderabbitai ignore`.

6. Verify and report.
   - Run `gh pr view --json url,title,body` and confirm the PR contains the
     intended PRD attachment, proof, and post-merge contract.
   - Report the PR URL and those same artifacts. Include the manual-test
     handoff when one was prepared.
