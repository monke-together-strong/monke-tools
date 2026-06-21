# PRD Orchestration

Use this when /implement is given a PRD that has implementation issues attached.

The PRD `/implement` thread is a coordinator. Do not implement attached issues
inline in the PRD thread.

## Process

1. Fetch the PRD and its comments.
2. Find implementation issues attached to the PRD.
3. Order the issues by their `Blocked by` relationships.
4. For each issue, create a separate Codex thread using the delegation prompt template below.
5. Monitor the current issue implementation every three minutes. Be patient:
   after confirming the worker is active, wait about 180 seconds between
   polls; do not short-poll with 60-second sleeps. Let active work continue
   without steering; intervene only for a blocker, completion, or clear course
   deviation.
6. After all issues are complete, use /review to review the whole PRD.

## Delegation prompt

When creating a thread for an implementation slice, use this template and do not add generic repo/process reminders.

```text
/implement <slice issue URL>

Parent PRD: <parent PRD URL> . Use it as background context for product intent and constraints only, do not implement the entire PRD.
