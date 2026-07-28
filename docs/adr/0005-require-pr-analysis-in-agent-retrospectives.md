# Require PR analysis in agent retrospectives

## Status

Accepted.

## Decision

Agent retrospectives have two required evidence lanes: Agent transcript analysis and PR analysis. Agent transcript analysis finds transcript friction and repeated asks. PR analysis studies merged **Implementation trajectories** from PR opening snapshot to merged outcome, so the retrospective can learn from corrective changes that happened after a PR opened and before it merged.

The PR lane is required for every run. Transcript-only synthesis is degraded and must explicitly report what PR analysis was missing.

The operational source of truth for PR-analysis mechanics is [the skill reference](../../skills/internal/agent-session-retrospective/references/pr-analysis.md). That reference owns repository scope, author scope, window handling, opening snapshot confidence, post-opening delta evidence, per-PR headings, gap reporting, aggregate report shape, and validation boundary.

## Consequences

Retrospective runs default to the window from the previous completed retrospective run to now. The first run defaults to the previous two weeks, and explicit `--since` and `--until` values are for backfills or bounded replays.

The collect bracket owns window resolution and writes `runs/<runTs>/window.json`. PR analysis and commit use that resolved window instead of recomputing it. The final report prints the resolved window near the top so PR inclusion and exclusion are auditable.

Retrospective runs now depend on GitHub metadata and local git evidence where available. Missing or inaccessible PR evidence is reported as PR analysis gaps rather than silently falling back to transcript-only synthesis.

PR analysis produces observations and recurring corrective-change patterns, not final durable-fix proposals. Session-action synthesis owns transcript-derived durable-fix proposal wording and ranking; recurring PR corrective patterns stay in the PR repeated-patterns lane unless the same issue is also evidenced in Agent transcript findings.

Final report sets include a compact action report plus linked source files. The compact report keeps session-derived durable-fix actions first and includes a dedicated PR repeated-corrective-patterns section. The linked PR source file preserves the full PR trajectory analysis, including per-PR analyses and gaps, and the linked session source file preserves transcript-derived per-repo proposals, repeated asks, evidence, and audit detail.
