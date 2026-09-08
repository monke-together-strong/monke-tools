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

`resources.values` contains literal strings with `${session}`, `${user}`, and `${id}` placeholders. `${id}` is a stable 32-character lowercase hex identifier derived from the repo source path and full Session name, suitable for resource names that cannot contain branch slashes. Values are persisted and written to the session root `.env`.

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

`cleanupCommand` runs root-first before any Session worktree is removed, from each repo's Session worktree. It receives saved resources, command outputs, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH`. A failure stops teardown and retains state and remaining worktrees. Commands must be safe to retry; successful commands may rerun.

If a worktree with a required command is missing, no cleanup commands run. Restore it and retry. For deliberate recovery only, `mt chop <session> --cleanup-from-source` permits running the recorded command from a source checkout when its worktree is missing. Check every command first: a source checkout has different code, env files, and Compose configuration. Automatic Cleanup never makes this substitution.

### Docker cleanup

Give each repo and Session its own Compose project before starting containers:

```yaml
resources:
  values:
    COMPOSE_PROJECT_NAME: myapp-${id}
cleanupCommand: docker compose --profile '*' down
```

Compose reads the persisted project name from the Session root `.env`; cleanup receives that same saved value. Match startup's Compose files and env loading, and ensure startup does not override the project name with `-p` or a different environment value. Enable the profiles the repo uses (`'*'` enables all). Preserve volumes by default. Avoid `--remove-orphans` unless all containers in the project belong to this repo and Session.

For application cleanup followed by Docker teardown, put the sequence in a repo script and use `cleanupCommand: bun run session:cleanup`. Run application cleanup before stopping infrastructure it needs, joining required steps with `&&` so failures propagate. Worktree guards and absolute paths are unnecessary in normal cleanup.

Apply project naming to new Sessions. Existing Sessions keep recorded commands and resource values; adding a project name to an existing Session changes the container and volume namespace. Clean up or explicitly migrate its old project before materializing the new configuration. Never suppress Docker errors with `|| true` or use source recovery blindly: failed cleanup retains state for retry.
