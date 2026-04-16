# monke-tools

This repo is initialized as a Bun project with Oxlint and Oxfmt wired in as the default linting and formatting tools.

`monke-tools` creates per-session worktrees for one repo or a small dependency graph, rewrites mapped env vars to unique local ports, syncs dependency paths into each worktree's root `.env`, and lets you re-materialize the session when you need to refresh it.

## Quick start

```bash
bun install
bun test
bun run lint
bun run fmt:check
```

## Local install

```bash
bun run install:local
mt create banana
```

## Commands

- `mt create <session>` creates or updates a session from the source checkout. It materializes dependency repos first, seeds configured files, rewrites mapped env vars, and records the session state under `~/.monke` by default.
- `mt materialize` refreshes the current session worktree in place and keeps the existing port assignments sticky.
- `mt cleanup` removes session records whose worktrees no longer exist.
- `mt setup` syncs external repo path env vars into the source checkout root `.env`.
- `mt run --plan "..."` runs Monke's Codex-backed workflow in the current Git checkout: it checkpoints dirty startup work when needed, runs the implementer and reviewer passes in sequence, streams the agent output live, and ends with a short summary.

## `monke.yml`

Each repo that participates in a session graph declares its apps, env rewrites, optional dependency repos, and optional bootstrap or seed behavior in `monke.yml`.

```yaml
seedPaths:
  - scripts/bootstrap.sh
bootstrapCommand: pnpm install && pnpm generate
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
```

## Development

```bash
bun run src/index.ts create banana
bun run src/index.ts materialize
bun run src/index.ts cleanup
bun run src/index.ts setup
bun run src/index.ts run --plan $'1. Update the CLI\n2. Add tests'
```

Repo-specific tooling notes live in [docs/backlog-usage.md](docs/backlog-usage.md).
