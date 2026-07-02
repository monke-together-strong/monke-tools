# monke.yml Reference

Each participating repo declares its session behavior in `monke.yml`.

```yaml
apps:
  api:
    path: apps/api
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

An app `path` may be `.` when the app lives at the repo root; `envFile` is resolved relative to that app path. `envFile` defaults to `.env`, so omit it for apps that use `.env` and set it only for non-default files like `.env.local`.

Bootstrap commands run inside the session worktree after monke-tools writes env files, dependency paths, and deterministic Resource values. Dynamic Resource command outputs are resolved after bootstrap when a bootstrap command exists, so resource modules can import packages installed or linked by bootstrap.

Prefer commands whose outputs are valid for that exact worktree. If a generator writes absolute paths into generated files, configure that generator task so caches cannot restore outputs from another worktree. For example, Prisma clients generated through Turbo should use a non-cached `generate` task (`"cache": false`) so `bootstrapCommand: pnpm install && pnpm generate` stays safe.
