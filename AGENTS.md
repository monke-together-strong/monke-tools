# monke-tools

monke-tools is a Bun CLI for creating and refreshing per-session repo worktrees, syncing dependency paths, and rewriting env-based ports for isolated local sessions.

## Essentials

- Package manager: `bun`
- Test: `bun test`
- Lint: `bun run lint`
- Format check: `bun run fmt:check`
- Follow git flow.
- Do not create `codex/` branches.
- Put clean source clones created for testing under `tmp/`.

## Task-Specific Guides

- [Git workflow](docs/agents/git-workflow.md)
- [Backlog.md overview](docs/agents/backlog.md)
- [Backlog task lifecycle](docs/agents/backlog-task-lifecycle.md)
- [Backlog task authoring](docs/agents/backlog-task-authoring.md)
- [Backlog CLI usage](docs/backlog-usage.md)
