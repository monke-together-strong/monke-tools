# Require PR analysis in agent retrospectives

## Status

Accepted.

## Decision

Agent retrospectives have two required evidence lanes: Agent transcript analysis and PR analysis.
Agent transcript analysis finds transcript friction and repeated asks. PR analysis studies merged
**Implementation trajectories** from PR opening snapshot to merged outcome, so the retrospective can
learn from corrective changes that happened after a PR opened and before it merged.

The PR lane is required for every run. Transcript-only synthesis is degraded and must explicitly
report what PR analysis was missing.

The operational source of truth for PR-analysis mechanics is
[the skill reference](../../skills/internal/agent-session-retrospective/references/pr-analysis.md).
That reference owns repository scope, author scope, window handling, opening snapshot confidence,
post-opening delta evidence, per-PR headings, gap reporting, aggregate report shape, and validation
boundary.

## Consequences

Retrospective runs default to the window from the previous completed retrospective run to now. The
first run defaults to the previous two weeks, and explicit `--since` and `--until` values are for
backfills or bounded replays.

The collect bracket owns window resolution and writes `runs/<runTs>/window.json`. PR analysis and
commit use that resolved window instead of recomputing it. The final report prints the resolved
window near the top so PR inclusion and exclusion are auditable.

Retrospective runs now depend on GitHub metadata and local git evidence where available. Missing or
inaccessible PR evidence is reported as PR analysis gaps rather than silently falling back to
transcript-only synthesis.

PR analysis produces observations and recurring corrective-change patterns, not final durable-fix
proposals. Final synthesis owns durable-fix proposal wording and ranking after combining PR
trajectory patterns with Agent transcript findings.

Final reports include a dedicated `PR trajectory analysis` section after global cross-repo proposals
and before Agent transcript-derived per-repo proposals.
