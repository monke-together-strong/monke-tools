---
name: retro
description: Review a coding session and propose environment improvements that are still needed.
disable-model-invocation: true
---

# Retro

Read and follow [the base retrospective workflow](../../references/imported/retro/MAIN.md)
for its evidence gathering, categories, and reference guidance. Before presenting
its candidates, apply [the current-state check](../../references/internal/RETRO_CURRENT_STATE.md)
to each cause. This check governs which candidates become findings.

Report only the remaining gaps, ordered by severity. Use this format for each:

```markdown
### <remaining cause> (<severity>)

Evidence: <primary source and position establishing the incident and intended behavior>.
Since then: <incident outcome, later repairs or decisions, and their evidence>.
Remaining: <missing|unwired|partial>: <uncovered case, effective source/version, check time, and verification limit>.
Fix: <editable source>: <smallest change that covers the remaining case>.
```

After the findings, list exclusions with their reasons and evidence, including
fixed or superseded causes and behavior that matched the request. List unverified
candidates separately with the missing proof. If nothing remains, say so. The
review proposes changes; the user chooses what to implement.
