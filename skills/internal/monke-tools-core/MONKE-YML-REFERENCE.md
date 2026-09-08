# monke.yml Reference

Each participating repo declares its session behavior in a root `monke.yml`.

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
  values:
    DISCORD_CHANNEL: mt-${user}-${session}
cleanupCommand: bun run cleanup:e2e
```

## Env and dependencies

`apps` maps owned port keys to env variables. App `path` is repo-relative and may be `.`; `envFile` is app-relative and defaults to `.env`. Set it explicitly for files such as `.env.local`.

`external` points to dependency repo roots, each with its own `monke.yml`. `pathEnv` writes the dependency checkout path into the current repo's root `.env`. Each external mapping must name a port owned by that dependency and an app in the declaring repo. In this example, `dep` must own `DEP_POSTGRES_PORT`.

## Seed and bootstrap

`seedPaths` copies source files or directories into session worktrees without overwriting session-local content. Missing seed paths warn; copy failures stop preparation.

`bootstrapCommand` runs in the session worktree after env/path and deterministic resource values are written. Dynamic resource commands run afterward so their modules can use installed dependencies.

Generate outputs for the actual worktree. If a generator embeds absolute paths, disable caching for that task; for example, a Turbo task generating Prisma clients should use `"cache": false`.

## Resources

`resources.values` contains literal strings with `${session}` and `${user}` placeholders. Values are persisted and written to the session root `.env`.

For dynamic values, add `resources.commands` under the same `resources` section:

```yaml
resources:
  commands:
    slot:
      run: scripts/session-slot.ts
      outputs: [SLOT_ID]
      timeoutSeconds: 60
```

The repo-relative JS/TS module exports a function receiving remembered values from other retained sessions for this repo and command:

```ts
export default function ({ previous }: { previous: { SLOT_ID: string[] } }) {
  let slot = 1;
  while (previous.SLOT_ID.includes(String(slot))) slot += 1;
  return { SLOT_ID: String(slot) };
}
```

Return exactly the declared output names as nonempty strings; stdout/stderr are diagnostic logs. The timeout defaults to 60 seconds. Literal values and outputs must use distinct env names. Matching commands are serialized across sessions, and outputs cannot reuse remembered values for the same name. Complete saved outputs are reused on materialization.

## Cleanup

`cleanupCommand` runs root-first before any Session worktree is removed, from each repo's Session worktree. If that worktree is already missing, it runs from the source checkout for recovery. It receives saved resources, command outputs, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH`. A failure stops teardown and retains state and remaining worktrees. Commands must be safe to retry; successful commands may rerun.

### Docker cleanup

When writing `monke.yml` for a repo that starts Docker containers, include teardown in `cleanupCommand`. Inspect the actual startup command to match its Compose files, project name, env files, profiles, and services. Run application cleanup before stopping infrastructure it needs, joining required steps with `&&` so failures propagate.

For a repo using the default Compose project identity and a `db` service:

```yaml
cleanupCommand: >-
  test -d "$MONKE_WORKTREE_PATH" &&
  docker compose --project-directory "$MONKE_WORKTREE_PATH"
  -f "$MONKE_WORKTREE_PATH/docker-compose.yml" down db
```

Use the actual service names and enable required profiles. Preserve volumes by default. Dependencies with the same worktree basename can share a Compose project name: explicitly name this repo's services and omit `--remove-orphans` in that case. Use `--remove-orphans` only when startup establishes a project exclusive to this repo and Session.

The worktree guard deliberately fails during missing-worktree recovery instead of targeting the source checkout's containers. To support that recovery, a repo needs teardown based on a persisted Session resource identity that works without its worktree. Never suppress Docker failures with `|| true`; retained state is needed for retry. See [removal and recovery](SKILL.md#remove-and-recover).
