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

`bun run install:local` rebuilds the local `mt` executable from the current checkout, installs it to `~/.local/bin/mt` and `~/.local/bin/monke-tools`, and links this checkout into global package roots so TanStack Intent can discover this repo's package skills.

After changing CLI source code, run `bun run install:local` again before testing from another repo. Skill changes under `skills/` are visible through the global package link without rebuilding the executable.

## Intent skill

Consumer repos can load monke-tools guidance with TanStack Intent:

```bash
bunx @tanstack/intent@latest list --global
bunx @tanstack/intent@latest load monke-tools#core --global
```

If global scanning misses the local package link in a consumer repo, force Intent to scan npm's global package root:

```bash
INTENT_GLOBAL_NODE_MODULES="$(npm root -g)" bunx @tanstack/intent@latest load monke-tools#core --global
```

For persistent agent guidance, add an `intent-skills` block to the consumer repo's `AGENTS.md` that keeps global discovery explicit:

```md
<!-- intent-skills:start -->

## Skill Loading

Before substantial work:

- Skill check: run `bunx @tanstack/intent@latest list --global`, or use skills already listed in context.
- Skill guidance: if one local or global skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill> --global` and follow the returned `SKILL.md`.
- Multiple matches: prefer the most specific skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
```

## Commands

- `mt create <session>` creates or updates a session from the source checkout. It materializes dependency repos first, seeds configured files, rewrites mapped env vars, and records the session state under `~/.monke` by default.
- `mt materialize` refreshes the current session worktree in place and keeps the existing port assignments sticky.
- `mt cleanup` removes session records whose worktrees no longer exist.
- `mt setup` syncs external repo path env vars into the source checkout root `.env`.
- `mt work --plan "..."` runs Monke's single-pass Codex-backed workflow in the current Git checkout: it checkpoints dirty startup work when needed, runs the implementer and reviewer passes in sequence, streams the agent output live, and ends with a short summary.
- `mt work --prd "..."` resolves one PRD issue plus an ordered task issue list, prints the resolved order, then executes each task issue through the PRD issue loop. Exactly one of `--plan` or `--prd` is required.

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

`bootstrapCommand` runs from the session worktree after env files, dependency paths, and resources are written. Prefer bootstrap commands that produce outputs valid for that exact worktree. If a generator writes absolute paths into generated files, configure the generator task itself so cached outputs cannot be restored from another worktree. For example, Prisma clients generated through Turbo should use a non-cached `generate` task (`"cache": false`) so ordinary bootstrap commands like `pnpm generate` are safe.

## Development

```bash
bun run src/index.ts create banana
bun run src/index.ts materialize
bun run src/index.ts cleanup
bun run src/index.ts setup
bun run src/index.ts work --plan $'1. Update the CLI\n2. Add tests'
bun run src/index.ts work --prd 'https://github.com/monke-together-strong/monke-tools/issues/22'
```

Repo-specific tooling notes live in [docs/backlog-usage.md](docs/backlog-usage.md).
