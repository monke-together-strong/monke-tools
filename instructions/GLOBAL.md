## Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Tests are good. Endless smoke tests, "regression tests" for feature deletions, etc. are not. Tests should be focused, not slop.

## General preferences

- If asked to do too much work at once, stop and state that clearly.
- Never remove TODO comments unless sure that it has been properly addressed
- Do not just default to browser use when failing at a non-browser task, especially if there are explicit instructions to use non-browser tools for the task. Figure out why it's not working. Only fallback to browser if you really can't get it working, and mention the reason.

## Verification

- Use the smallest proof that the change works: tests for the files or behavior
  changed, plus targeted lint and typecheck for the changed scope.
- **Do not run repo-wide checks** unless explicitly asked. CI owns full suite.

## Branching

Follow git flow.
Do not create `codex/` branches.

## Matt Pocock skills issue tracking

While projects may use their own issue tracking, skills such as `/wayfinder`, `to-spec`, `to-tickets` should use Github issues, using personal fork of the repository when it exists.
