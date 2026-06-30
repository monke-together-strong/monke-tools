---
name: create-pr
description: Create a GitHub pull request from the current branch. Use when the user asks to open/create a PR, turn current work into a PR, or prepare a branch for review; include screenshots or videos as proof for frontend work.
---

# Create PR

Create one clear GitHub PR. Keep the body short, prove what changed, publish a
self-contained post-merge contract, and stop after the PR exists.

## Workflow

1. Inspect the branch.
   - Check `git status --short`, the current branch, its upstream, and the
     commits/diff against the intended base.
   - If there are uncommitted changes that look relevant, commit them before
     creating the PR. If they look unrelated, ask before touching them.

2. Collect proof.
   - Record the verification commands already run, or run the smallest
     relevant checks before creating the PR.
   - For frontend-visible work, attach proof: screenshots for static states and
     short videos for interactions, animations, responsive behavior, or bugs
     that only show over time.
   - Upload local images/videos with `$github-image-upload`; embed the returned
     GitHub attachment markdown or bare video URLs in the PR body. Do not leave
     local file paths as proof.

3. Draft the post-merge contract.
   - If root `POST_MERGE.md` exists, read it as repo-specific authoring context
     for environments, deployment signals, verification norms, and evidence.
   - Combine that context, the PRD/issue, and the diff into concise checks for
     the merged code in a non-production or production-like environment.
   - The contract is complete when it says `Not required: <reason>` or names
     `Environment`, `Deployment gate`, and `Checks`. Mark unknown details
     explicitly, such as `Environment: ask user`.

4. Write the PR body.
   Use this shape unless the repo has a stronger convention:

   ```markdown
   ## Summary
   - ...

   ## PRD
   - ...

   ## Verification
   - ...

   ## Proof
   ...

   ## Post-Merge Verification
   Environment: ...
   Deployment gate: ...
   Checks:
   - ...
   ```

   Omit `PRD` only when no PRD is present. When present, attach it with a
   GitHub issue URL first, then a repo file link or path. The attachment is
   complete when the PR body lets a reader open the source PRD.
   Omit `Proof` only when the work has no user-visible frontend behavior.

5. Create the PR.
   - Push with `git push -u origin HEAD` if the branch has no upstream.
   - Create a ready PR by default with `gh pr create --title ... --body-file
     ...`; use draft only when the user asks.
   - If a PR already exists for the branch, update it instead of creating a
     duplicate.

6. Verify and report.
   - Run `gh pr view --json url,title,body` and confirm the PR contains the
     intended PRD attachment, proof links, and post-merge contract.
   - Report the PR URL, PRD attachment, verification checks, proof, and
     post-merge contract.
