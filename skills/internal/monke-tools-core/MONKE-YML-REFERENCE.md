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

`cleanupCommand` runs from the source checkout after session worktrees are removed, with resources, command outputs, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH` in its environment. Make it safe to retry: failed finalization retains state and can rerun previously successful commands. See [removal and recovery](SKILL.md#remove-and-recover) for `chop` and `cleanup` behavior.
