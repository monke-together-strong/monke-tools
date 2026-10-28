# Library release

A merged library change leaves its version bump in a release PR, such as
Tegami's `Version Packages` PR.

1. Approve the release PR with `gh pr review --approve` when its
   `reviewDecision` is `REVIEW_REQUIRED`.
2. Run `$shepherd-pr` on the release PR. The user's request to publish
   authorizes merging it once it is green.
3. Merging runs post-merge for the release PR. Its repository contract names the
   publish job on the base branch and how to confirm the published version.
