---
name: merge-pr
description: Merge a GitHub PR after an explicit "merge" request.
---

# Merge PR

A direct "merge this PR" / "merge PR #123" is approval.

## Checklist

1. Resolve the PR: explicit number or URL wins; otherwise use `gh pr view`. Ask if no single PR resolves.
2. Run [check-ci](scripts/check-ci.ts) immediately before untracking:

   ```sh
   bun <skill-dir>/scripts/check-ci.ts --repo <owner/name> --pr <number>
   ```

   Continue only on exit 0. It reports the current head and all reported checks,
   including optional checks on repositories without branch protection.
   For `pending`, keep tracking and wait for CI. For `failed`, investigate the
   failed checks. `no_checks` or `no_success` needs an explicit user waiver.
   A read error leaves CI unverified; resolve the error before proceeding.

   To waive CI, the user must explicitly approve the reported check state for
   that head. A merge request alone is not a waiver. Rerun with
   `--waive-head <full-head-sha> --waiver '<user approval and reference>'`.
   A waiver applies only to that head and never bypasses a read error.
3. Run `mt prs untrack <url>` so the external-merge poller leaves this PR to you.
   Squash-merge with the head returned by check-ci:

   ```sh
   gh pr merge <number> --repo <owner/name> --squash --match-head-commit <head>
   ```

   Completion requires the merge command to succeed and
   `gh pr view <number> --repo <owner/name> --json state` to report `MERGED`.
   If the merge fails or the state is not `MERGED`, track it again with the
   thread and checkout that `untrack` printed. If the head changed, repeat the
   CI check for the new head before retrying.
4. Run [post-merge](../post-merge/SKILL.md) for the merged PR.

Report the PR URL, merge method, checked head, CI result, and any waiver with
post-merge's hand-off or report.
