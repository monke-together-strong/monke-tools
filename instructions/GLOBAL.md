## Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Tests are good. Endless smoke tests, "regression tests" for feature deletions, etc. are not. Tests should be focused, not slop.

## General preferences

- If asked to do too much work at once, stop and state that clearly.
- Never remove TODO comments unless sure that it has been properly addressed

## Verification

- Use the smallest proof that the change works: tests for the files or behavior
  changed, plus targeted lint and typecheck for the changed scope.
- **Do not run repo-wide checks** unless explicitly asked. CI owns full suite.

## Branching

Follow git flow.
Do not create `codex/` branches.
