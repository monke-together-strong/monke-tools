# Backlog Task Authoring

## Creating Tasks

- Include a title, description, and acceptance criteria.
- Do not add an implementation plan during task creation.

## Acceptance Criteria

- Make each criterion outcome-oriented, testable, and concise.
- Avoid implementation-step wording when an outcome can be stated instead.

## Implementation Notes

- Use notes as a time-ordered progress log.
- Record meaningful progress, decisions, and blockers.

## Final Summary

- Write it like a PR description.
- Cover the outcome, key changes, tests run, and follow-ups when relevant.

## Multi-line CLI Input

Use real newlines when passing multi-line content to the CLI.

```bash
bunx backlog.md task edit 42 --plan $'1. Inspect\n2. Implement\n3. Verify'
```

Do not rely on literal `\n` inside normal quotes.
