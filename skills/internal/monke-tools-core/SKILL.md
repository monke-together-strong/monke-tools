---
name: monke-tools-core
description: Use monke-tools for session worktrees, env rewrites, cleanup.
---

# monke-tools Core

Use this skill when the current repo uses `mt` / monke-tools.

## Prerequisite

The `mt` command must be available on `PATH`:

```bash
command -v mt
```

If it is missing or stale, ask the user to refresh the local install from the monke-tools checkout with `bun run install:local`.

## Commands

- `mt create <session>`: run from a source checkout to create or update a session worktree and its dependency worktrees.
- `mt materialize`: run inside a session worktree to refresh env rewrites, dependency paths, resources, and bootstrap behavior.
- `mt setup`: run from a source checkout to write dependency path env vars into the source checkout root `.env`.
- `mt cleanup`: remove dead session-state records and run configured cleanup commands.
- `mt skills configure`: update which Agent skill roots receive monke-tools Distributed skills.
- `mt work --plan "..."`: run the single-pass implementer/reviewer agent workflow in the current checkout.
- `mt work --prd "..."`: run the PRD issue loop across planned task issues.

## Config

Each participating repo declares its session behavior in `monke.yml`.

```yaml
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
seedPaths:
  - scripts/bootstrap.sh
bootstrapCommand: pnpm install
resources:
  DISCORD_CHANNEL: mt-${user}-${session}
cleanupCommand: bun run cleanup:e2e
```

Key fields:

- `apps`: app env files whose mapped variables monke-tools rewrites.
- `external`: dependency repos, dependency path env vars, and dependency-owned port mappings.
- `seedPaths`: files or directories copied into newly created session worktrees.
- `bootstrapCommand`: repo setup command run after env/path/Resource value writes; dynamic Resource commands run afterward when bootstrap exists.
- `resources`: literal per-session values; supports `${session}` and `${user}`.
- `cleanupCommand`: teardown command used by `mt cleanup`.

Bootstrap commands run inside the session worktree after monke-tools writes env files, dependency paths, and deterministic Resource values. Dynamic Resource command outputs are resolved after bootstrap when a bootstrap command exists, so resource modules can import packages installed or linked by bootstrap. Prefer commands whose outputs are valid for that exact worktree. If a generator writes absolute paths into generated files, configure that generator task so caches cannot restore outputs from another worktree. For example, Prisma clients generated through Turbo should use a non-cached `generate` task (`"cache": false`) so `bootstrapCommand: pnpm install && pnpm generate` stays safe.

## Rules

- Follow the consumer repo's own `AGENTS.md`, branching, task, and test rules.
- Do not run `mt materialize` from a source checkout; use `mt create` or `mt setup` there.
- Do not hand-edit monke-tools session state unless explicitly debugging state corruption.
- If `mt` behavior seems stale after monke-tools source changes, refresh the local install from the monke-tools checkout with `bun run install:local`.
