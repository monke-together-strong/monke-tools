---
name: create-pr
description: Create a GitHub pull request from the current branch. Use when the user asks to open/create a PR, turn current work into a PR, or prepare a branch for review; include screenshots or videos as proof for frontend work.
---

# Create PR

Create one clear GitHub PR. Keep the body short, prove what changed, and stop
after the PR exists.

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

3. Write the PR body.
   Use this shape unless the repo has a stronger convention:

   ```markdown
   ## Summary
   - ...

   ## Verification
   - ...

   ## Proof
   ...
   ```

   Omit `Proof` only when the work has no user-visible frontend behavior.
   Link the PRD if available (github issues)

4. Create the PR.
   - Push with `git push -u origin HEAD` if the branch has no upstream.
   - Create a ready PR by default with `gh pr create --title ... --body-file
     ...`; use draft only when the user asks.
   - If a PR already exists for the branch, update it instead of creating a
     duplicate.

5. Verify and report.
   - Run `gh pr view --json url,title,body` and confirm the PR contains the
     intended proof links.
   - Report the PR URL and the checks/proof included.
