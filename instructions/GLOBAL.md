## Code Style

- Always strive for concise, simple solutions.
- Ground proposed changes in actual callers, data, and behavior. Before adding complexity, show a concrete case that requires it and compare the simpler existing solution. If the requirement is uncertain, run a focused experiment; delegate to a subagent when it can investigate independently.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Tests are good. Endless smoke tests, "regression tests" for feature deletions, etc. are not. Tests should be focused, not slop.

## General preferences

- Never remove TODO comments unless sure that it has been properly addressed
- Do not just default to browser use when failing at a non-browser task, especially if there are explicit instructions to use non-browser tools for the task. Figure out why it's not working. Only fallback to browser if you really can't get it working, and mention the reason.

## Verification

- For ordinary changes, run focused tests, lint, and typecheck.
- For CI fixes, iterate with focused checks, then run every failed job's full
  verification with its setup, builds, workflow commands, runtime, and
  configuration. Use a matching runner if needed. Report blockers; claim
  verification only when all failed jobs pass.
- Run other repo-wide checks only when asked.

## Branching

By default, name branches with git flow prefixes: `feature/`, `bugfix/`, `hotfix/`, `release/`.

## Matt Pocock skills issue tracking

While projects may use their own issue tracking, skills such as `/wayfinder`, `to-spec`, `to-tickets` should use Github issues, using personal fork of the repository when it exists.

## UI changes

When making UI changes take screenshots and show me so I can see the outcome. Also provide a link to view it. If the local app is login gated,
use `agent:login` repo/project command. Set it up if needed per `~/.monke/skill-registry/skills/references/internal/AGENT_LOGIN.md`.
