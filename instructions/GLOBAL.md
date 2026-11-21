## Code style

- Ground proposed changes in actual callers, data, and behavior. Before adding complexity, show a concrete case that requires it and compare the simpler existing solution. If the requirement is uncertain, run a focused experiment. Delegate to a subagent when it can investigate independently.
- Propose broad or unconventional changes when they clearly improve maintainability or outcomes.
- Write focused behavioral tests. Skip repetitive smoke tests and regression tests for deleted features.

## General preferences

- Keep TODO comments until you verify the underlying work is complete.
- When a non-browser tool fails, diagnose the failure before switching to a browser, especially when instructions require non-browser tools. Fall back to a browser only when the non-browser path cannot work, and state the reason.

## Verification

- For ordinary changes, run focused tests, lint, and typecheck.
- For CI fixes, iterate with focused checks, then run every failed job's full
  verification with its setup, builds, workflow commands, runtime, and
  configuration. Use a matching runner if needed. Report blockers. Claim
  verification only when all failed jobs pass.
- Run other repo-wide checks only when asked.

## Branching

By default, name branches with Git Flow prefixes: `feature/`, `bugfix/`, `hotfix/`, `release/`.

## Matt Pocock skills issue tracking

Use GitHub Issues for skills such as `to-spec` and `to-tickets`, even when a project uses another tracker. Target a personal fork of the repository when one exists.

## UI changes

When making UI changes, attach screenshots of the result and link directly to each changed view or state rather than the app or folder root. If the local app is login-gated, use the repo's `agent:login` script. Set up `agent:login` if needed using `references/internal/AGENT_LOGIN.md` from your Monke guidance installation.
