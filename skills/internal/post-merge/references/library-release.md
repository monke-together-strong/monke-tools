# Library release

A merged library change leaves its version bump in a Release PR, such as
Tegami's `Version Packages` PR.

1. When the Release PR's `reviewDecision` is `REVIEW_REQUIRED`, approve it with
   `gh pr review --approve`.
2. Run `$shepherd-pr` on the Release PR. The user's request to publish
   authorizes merging it once it is green.
3. Merging runs post-merge for the Release PR. Its repository contract names the
   publish job on the base branch and how to confirm the published version.
