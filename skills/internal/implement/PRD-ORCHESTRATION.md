# PRD Orchestration

Use this when /implement is given a PRD that has implementation issues attached.

## Process

1. Fetch the PRD and its comments.
2. Find implementation issues attached to the PRD.
3. Order the issues by their `Blocked by` relationships.
4. For each issue, run /implement with the issue as the work to implement.
5. Include the parent PRD only as background context for that issue.
6. Do not ask the issue implementation thread to implement the whole PRD.
7. Monitor the current issue implementation every five minutes. Let active work continue without steering; intervene only for a blocker, completion, or clear course deviation.
8. After all issues are complete, use /review to review the whole PRD.

Do not implement future issues, neighboring issues, or general PRD scope while working on the current issue.
