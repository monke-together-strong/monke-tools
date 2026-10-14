# monke.yml reference

Each repo declares Session behavior, checkout resources, and published guidance
in a root `monke.yml`. All sections are optional.

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
```

## Env and dependencies

`apps` maps owned port keys to env variables. App `path` is repo-relative and may be `.`; `envFile` is app-relative and defaults to `.env`. Set it explicitly for files such as `.env.local`.

`external` points to dependency repo roots, each with its own `monke.yml`. `pathEnv` writes the dependency checkout path into the current repo's root `.env`. Each external mapping must name a port owned by that dependency and an app in the declaring repo. In this example, `dep` must own `DEP_POSTGRES_PORT`.

## Seed and bootstrap

`seedPaths` copies source files or directories into session worktrees without overwriting session-local content. Missing seed paths warn; copy failures stop preparation.

`bootstrapCommand` runs in the session worktree after env/path and deterministic resource values are written. Dynamic resource commands run afterward so their modules can use installed dependencies.

Generate outputs for the actual worktree. If a generator embeds absolute paths, disable caching for that task; for example, a Turbo task generating Prisma clients should use `"cache": false`.

## Resources

`resources.values` contains literal strings with `${user}`, `${id}`, and
`${session}` placeholders. `${id}` is a stable 32-character lowercase hex
identifier derived from canonical Source and checkout paths, suitable for both
Source checkouts and Session worktrees. `${session}` requires a Session.
Deterministic values are persisted and written to root `.env`.

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

A repo-relative JS/TS module exports `acquire` and, for external resources,
`release`:

```ts
type Owner = {
  id: string;
  sourceRoot: string;
  checkoutPath: string;
  session?: string;
};

export function acquire({ owner, previous }: {
  owner: Owner;
  previous: { SLOT_ID: string[] };
}) {
  let slot = 1;
  while (previous.SLOT_ID.includes(String(slot))) slot += 1;
  return { SLOT_ID: String(slot) };
}

export async function release({ owner, outputs, values }: {
  owner: Owner;
  outputs: { SLOT_ID: string };
  values: Record<string, string>;
}) {
  // Delete only the resource identified by outputs.SLOT_ID.
  // Use values for deterministic context, such as RESOURCE_NAME.
}
```

Return exactly the declared output names as nonempty strings. `previous` contains
other retained checkouts' outputs for the same repo and command. Deterministic
values arrive through env during acquisition; release receives them explicitly as
`values`. Stdout/stderr are diagnostic logs. The timeout defaults to 60 seconds.
A module without a `release` export is suitable for allocations with no external
cleanup. Acquisition and release must be safe to retry.

Commands default to `acquire: automatic`, which runs after Session bootstrap.
Use `acquire: explicit` for resources that need additional setup. For acquisition,
execution, and retry commands, read [resource commands](../../../references/internal/RESOURCES.md).

## Cleanup

`cleanupCommand` tears down Session infrastructure after resource release and
before worktree removal. It receives saved deterministic values, `MONKE_SESSION`,
`MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH`. Keep external-resource teardown in
the modules' `release` functions. A failure retains state and remaining worktrees.
Commands must be safe to retry.

Legacy default-export modules retain their recorded aggregate cleanup contract,
including `MONKE_RESOURCE_OUTPUTS` (JSON of recorded dynamic outputs). Their
cleanup may still tear down infrastructure during `mt resources release` until
they are migrated to named exports.

A missing worktree blocks required cleanup before any repo cleanup begins.
Restore it, or deliberately use `mt chop <session> --cleanup-from-source` after
checking that the Source checkout's code, env and Compose configuration are safe.
Automatic Cleanup never makes this substitution.

### Docker cleanup

Give each checkout its own Compose project before starting containers:

```yaml
resources:
  values:
    COMPOSE_PROJECT_NAME: myapp-${id}
cleanupCommand: docker compose --profile '*' down
```

Run `mt setup` before starting containers; Spawn already prepares the Session
worktree's values. Compose reads the project name from the checkout's root `.env`.
Session cleanup receives that same saved value. Source infrastructure teardown
remains a repo command; `mt resources release` only releases resource allocations.

Match startup's Compose files and env loading, and ensure startup does not override
the project name with `-p` or a different environment value. Enable the profiles
the repo uses (`'*'` enables all). Preserve volumes by default. Use `--remove-orphans`
only when all containers in the project belong to this checkout.

Put application resource cleanup in resource modules, and reuse a package script for infrastructure teardown with `cleanupCommand: bun run session:cleanup`. MT releases resources before invoking that script.

Apply project naming to new Sessions. Existing Sessions keep recorded commands and resource values; adding a project name to an existing Session changes the container and volume namespace. Clean up or explicitly migrate its old project before materializing the new configuration. Never suppress Docker errors with `|| true` or use source recovery blindly: failed cleanup retains state for retry.

## Imported guidance

`skills` declares Git imports published with the repo. A `monke.yml` file can
contain only this section. Link and installer-command sources belong to
machine-local registries instead.

```yaml
skills:
  - source: kepano/obsidian-skills
    commit: 3ccff5338ea700537839b21900aa5358a0402c98
    modelInvocation: deny
    skills:
      - obsidian-bases
      - slug: canvas-guidance
        selector: json-canvas
        kind: reference
      - slug: obsidian-markdown
        modelInvocation: allow
        description: Use when editing Obsidian Markdown notes.
```

`source` identifies a Git repository with an optional ref and subpath. `commit`
is a full 40-character lowercase Git SHA. Restore rejects entries without a commit.
`mt skills update --repo` pins them.

Each entry requires a nonempty `skills` list. A string uses the same upstream
selector and local slug. Objects require `slug`. `selector` defaults to that
slug, and `kind` defaults to `skill`. `modelInvocation` accepts `allow` or `deny`
at source or skill level. Per-skill choices override source defaults.
`description` overrides one skill's description. `acceptOpenClawRisks: true` on
the source records upstream risk acceptance.

`mt skills restore --repo` restores pinned skills into `skills/imported/` and
references into `skills/references/imported/`. References replace `SKILL.md`
with `MAIN.md` and remove its leading YAML frontmatter. Restore applies selection
or override edits, replaces local edits, and prunes undeclared guidance. Monke
adds missing ignore rules for the generated roots and local restoration state.

When Monke writes recipes, it changes only the `skills` node and appends the node
when absent. Spawn, materialize, and setup do not restore these imports.

Consumers importing or linking the repo receive its own skills and one level of
declared imports. This does not project the repo's imports into its own agents.
Use `mt skills add <source> --project` for clone-local agent projections. See
[Monke skills](../../monke-skills/SKILL.md) for that workflow.
