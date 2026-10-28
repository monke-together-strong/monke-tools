---
name: shepherd-pr
description: 'Use when the user says things like "shepherd this PR", "babysit this PR", "get this PR merge-ready", "poll for reviews"'
---

# Shepherd PR

Create or pick up the PR and mark it ready for review. Track CI and review
coverage against its current head commit.

Use `watch_pull_request` while waiting for CI or reviews.

## Observe

On each run, check PR state before CI or reviews.

If merged or closed, report the terminal state and available merge details,
and stop.

For an open draft, run `gh pr ready <pr>`. Fetch the live base and head. If the
base is not an ancestor of the head, rebase a clean PR checkout, push with
`--force-with-lease`, and restart
observation. Review and CI evidence must cover the new head after any push.

## Resolve CI failures

Diagnose failed checks before requesting or waiting for reviews. Read the logs
and use targeted checks to distinguish a PR regression, baseline defect,
repo-owned flake, or external infrastructure failure.

Fix repo-owned failures at their root cause per
[principle-fix-root-causes](../../imported/principle-fix-root-causes/SKILL.md).
Verify flake fixes with repeated targeted runs; a passing retry alone does not
resolve a flake. Retries without code changes are diagnostic probes or recovery
from an evidenced external failure. If a durable fix would materially expand
scope, report the diagnosis and ask about that scope.

## Gather complete reviews

Once CI has no unresolved failure, inspect each reviewer's coverage before
triggering a missing review. Read mutable bot comment bodies and update times,
command replies, and covered commits; a check context alone is insufficient.
Processing text or an accepted trigger for this head means review has started.

Optional integrations are best-effort. Record an optional reviewer as
unavailable for this head when it has not started by the time CI finishes. A
check description or comment can report a rate limit even on a passing check:
for CodeRabbit, follow [CodeRabbit rate limits](RATE-LIMITS.md); record any
other reviewer as unavailable. Triage existing comments from unavailable
reviewers. Avoid empty commits, PR-state toggles, and repeated triggers to wake
reviewers. A required reviewer that cannot start is a blocker.

## Address feedback

Verify findings against the real code path. Fix confirmed medium-or-higher
findings and small local improvements to consistency, naming, readability,
typing, and duplication. Skip speculative scenarios, unnecessary abstractions,
broad rewrites, and unrelated issues with a concrete reason. Low severity alone
is not a reason to dismiss a useful fix.

Commit and push fixes, then return to observation; the push normally triggers
re-review. Inspect reviewer state before requesting anything manually.

## Finish

Before declaring readiness, refresh PR state, base, and head. If they changed,
return to observation. For the current head, require all of the following:

- The PR is not a draft.
- CI is green and every observed failure has a verified repo-owned fix or an
  evidenced external cause.
- Required reviews and automatic reviews that started have finished. Optional
  non-starters are recorded as unavailable, and existing feedback is triaged.
- Every reviewer thread you replied to has an answer, or five minutes have
  passed without one.
- No required changes or meaningful findings remain, and the PR is mergeable.

With explicit merge authorization, including standing instructions such as
"merge when ready," run `$merge-pr`.
Otherwise report merge-ready. Shepherding requests, acknowledgements, and green
checks alone do not authorize merging.
