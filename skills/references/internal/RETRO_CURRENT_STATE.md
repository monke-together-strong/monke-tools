# Check what still needs changing

Apply this check to every retrospective candidate before reporting it as a
current problem. An old failure establishes history, not an outstanding fix.

## Follow the incident through later repairs

1. Establish the intended behavior from the user's request and the instructions
   that applied. Read later clarifications before calling observed behavior a
   defect. Keep changed requirements distinct from failures of the earlier ones.
   Exclude behavior that matched the request; it does not count as a repaired defect.
2. Read the rest of the source thread and follow its handoffs, fix references,
   related PRs, and subsequent changes to the proposed fix location. Search the
   available history for the issue, affected mechanism, and later repairs, even
   when the original thread has no follow-up link. The review window limits which
   incidents to raise, not which later evidence to check.
3. Read the current editable source and inspect the effective installation or
   caller. For Git sources, verify the remote default-branch tip before using
   local refs. Include staged and unstaged edits, open fix PRs, and active
   links or versions. Record revisions or content hashes, check time, and any
   difference between the default branch and the effective copy. For an imported
   skill, identify its upstream and whether a local wrapper owns the change.
4. Split independently repaired parts of a bundled claim. Record the incident's
   outcome separately from the mechanism's repair. A completed ticket does not
   prove prevention, and a remaining instruction gap does not mean the original
   ticket is still unfinished. Credit existing repairs before proposing more.

## Classify each remaining cause

- `missing`: no current mechanism covers the case.
- `unwired`: a repair exists, but the active workflow or installation does not use it.
- `partial`: the effective repair covers only part of the case. State the remaining
  case and propose only that change. A workaround is mitigation unless it is now
  the supported path and covers the case.
- `fixed`: a retained, effective repair covers the observed case. Cite its adoption
  and coverage. A pre-existing rule, commit title, or passing retry alone is insufficient.
- `superseded`: a later decision or removal makes the old requirement inapplicable.
- `unverified`: required source, runtime, or intent evidence is unavailable or conflicts.
  State what would settle the claim. Do not treat missing proof as an active defect.

Keep historical observation, current source inspection, and current behavioral
reproduction distinct. State which supports the remaining gap. An experiment
that enforces a new policy proves its mechanics, not that the user wanted it.

## Carry the result into the report

Only `missing`, `unwired`, and `partial` causes can become active findings. Each
finding must retain the incident evidence, what changed afterward, and current
proof of the remaining case, including verification limits. If no later repair
was found, state the search scope. If the search was unavailable, mark the claim
unverified. Preserve these facts when shortening, deduplicating, or promoting
findings; do not leave them only in worker notes. Refresh them before acting on
an older report.

For example, a direct push left ticket closure and cleanup pending. A later
handoff completed both, and skill edits repaired handoff authorization. The
effective skill still required a merged PR. Report only the remaining direct-push
entry gap as a source mismatch. Do not call the ticket unfinished, propose the
handoff repair again, or claim another failed run without evidence.
