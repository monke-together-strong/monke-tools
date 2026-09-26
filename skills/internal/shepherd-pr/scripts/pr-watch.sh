#!/usr/bin/env bash
# Exit when the PR's head, checks, reviews, or comments change (including edits),
# when max-seconds pass, or with status 1 when GitHub can't be read.
# Usage: pr-watch.sh <owner/repo> <pr> [interval-seconds] [max-seconds]
set -uo pipefail
repo=$1 pr=$2 interval=${3:-60} max=${4:-}

state() {
  gh pr view "$pr" -R "$repo" --json state,headRefOid,statusCheckRollup,reviews -q '[.state, .headRefOid,
    (.statusCheckRollup[] | [.name // .context, .status // .state, .conclusion // ""] | join(":")),
    (.reviews[] | [.id, .state, .body] | join(":"))] | join(" ")' || return 1
  gh api --paginate "repos/$repo/issues/$pr/comments" -q '.[] | "\(.id)@\(.updated_at)"' || return 1
  gh api --paginate "repos/$repo/pulls/$pr/comments" -q '.[] | "\(.id)@\(.updated_at)"' || return 1
}

fail() {
  echo "PR $repo#$pr: GitHub read failed" >&2
  exit 1
}

prev=$(state) || fail
while sleep "$interval"; do
  cur=$(state) || fail
  if [ "$cur" != "$prev" ]; then
    echo "PR $repo#$pr changed"
    exit 0
  fi
  if [ -n "$max" ] && [ "$SECONDS" -ge "$max" ]; then
    echo "PR $repo#$pr unchanged after ${max}s"
    exit 0
  fi
done
