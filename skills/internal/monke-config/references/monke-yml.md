# monke.yml reference

Commit `monke.yml` to share it, or gitignore it in the Source checkout to keep it
local. Spawn uses the local file when the branch has none and copies it into the
Session worktree. List gitignored resource modules in `seedPaths`.

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
bootstrapCommand: bun install --frozen-lockfile
```

## Env and dependencies

`apps` maps owned port keys to env variables. App `path` is repo-relative and may be `.`. `envFile` is app-relative and defaults to `.env`. Set it explicitly for files such as `.env.local`.

`external` points to dependency repo roots, each with its own `monke.yml`. `pathEnv` writes the relative dependency checkout path into the current repo's root `.env`. Each external mapping must name a port owned by that dependency and an app in the declaring repo. In this example, `dep` must own `DEP_POSTGRES_PORT`.

## Seed and bootstrap

List extra local files or directories in `seedPaths`. Spawn seeds env files,
`CLAUDE.local.md`, and `AGENTS.override.md`, plus root
`.claude/settings.local.json`, `PR.md`, and `monke.yml` automatically. It
preserves existing Session files.

`bootstrapCommand` runs in the Session worktree after port mappings, dependency paths, and deterministic resource values are written. Automatic resource commands run afterward so their modules can use installed dependencies.

If bootstrap generates files with absolute paths, disable shared caching for
that task. For example, set `"cache": false` on a Turbo task that generates
Prisma clients into the worktree.

## Resources

`resources.values` contains literal strings with `${user}`, `${id}`, and
`${session}` placeholders. Use `${id}` for a value that must be stable and distinct per checkout.
Use `${session}` only for Session worktrees. Setup and Spawn write the resolved
values to root `.env`.

```yaml
resources:
  values:
    RESOURCE_NAME: test-${id}
  commands:
    slot:
      acquire: explicit
      run: scripts/slot.ts
      outputs: [SLOT_ID]
      timeoutSeconds: 60
```

A repo-relative JavaScript or TypeScript module exports `acquire` and, for external resources,
`release`:

```ts
type Owner = {
  id: string;
  sourceRoot: string;
  checkoutPath: string;
  session?: string;
};

export function acquire({ previous }: {
  owner: Owner;
  previous: { SLOT_ID: string[] };
}) {
  let slot = 1;
  while (previous.SLOT_ID.includes(String(slot))) slot += 1;
  return { SLOT_ID: String(slot) };
}
```

Return a nonempty string for each declared output and return only those outputs.
`previous` contains other retained checkouts' outputs for the same repo and command.
Acquisition receives deterministic values through the environment. For an external
allocation, export `release({ owner, outputs, values })` and release only the
resource identified by the recorded outputs. Make both exports safe to retry.

Automatic acquisition (`acquire: automatic`, the default) runs after Session
bootstrap. For a resource that needs additional setup, choose `acquire: explicit`
and follow the [resource procedure](../../../references/internal/RESOURCES.md).

## Cleanup

`cleanupCommand` tears down Session infrastructure after resource release and
before worktree removal. It receives saved deterministic values, `MONKE_SESSION`,
`MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH`. Keep external-resource teardown in
the modules' `release` functions. A failure retains state and remaining worktrees.
Commands must be safe to retry.

For legacy default-export modules, [release allocations before migrating](../../../references/internal/RESOURCES.md).
For a missing Session worktree, follow
[cleanup recovery](../../../references/internal/CLEANUP_RECOVERY.md#discovery-and-recovery).

### Docker cleanup

Give each checkout its own Compose project before starting containers:

```yaml
resources:
  values:
    COMPOSE_PROJECT_NAME: banana-${id}
cleanupCommand: docker compose --profile '*' down
```

Run `mt setup` before starting containers in a Source checkout. Spawn prepares
the values for a Session worktree. Point Compose at the checkout's root `.env`
so startup uses the same project name that Session cleanup receives.

Match startup's Compose files and env loading. Do not override the project name
during startup with `-p` or a different environment value. Enable the profiles
the repo uses (`'*'` enables all). Preserve volumes by default. Use `--remove-orphans`
only when all containers in the project belong to this checkout.

If migrating an existing Session to a new Compose project name, tear down or
migrate its old project first. The project name changes the container and
volume namespace. Let Docker failures propagate so Monke retains the failed
teardown for retry.

## Imported guidance

Use `skills` to publish committed Git guidance with the repo. See
[Monke skills](../../monke-skills/SKILL.md) to register a local link or installer
in a machine-local registry.

```yaml
skills:
  - source: kepano/obsidian-skills
    commit: 3ccff5338ea700537839b21900aa5358a0402c98
    modelInvocation: deny
    skills:
      - obsidian-bases
      - slug: json-canvas
        kind: reference
      - slug: obsidian-markdown
        modelInvocation: allow
        description: Use when editing Obsidian Markdown notes.
```

Omit `commit` for a new source, then run `mt skills update --repo` to pin and
write its files. To rename a skill locally, set `slug` to the local name and
`selector` to the upstream name. Per-skill `modelInvocation` overrides the source
default. Choose `kind: reference` for files that another skill should read
without making them invocable.

Restore writes skills into `skills/imported/` and references into
`skills/references/imported/`. Link to a restored reference's `MAIN.md`.
Make changes to selection or metadata in `monke.yml`. Restore replaces local
edits to generated files and prunes undeclared guidance.

Consumers that import or link the repo receive its own skills and one level of
declared imports. For clone-local agent links, follow
[Project installs](../../monke-skills/SKILL.md#project-installs).
