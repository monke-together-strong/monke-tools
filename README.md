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
mt create banana -m
```

`bun run install:local` rebuilds the local `mt` executable from the current checkout, installs it to `~/.local/bin/mt` and `~/.local/bin/monke-tools`, records the Installed source checkout in `~/.monke/config.yml`, and installs Distributed skills into the selected Agent skill roots.

On the first local install, monke-tools prompts for one or more skill targets: Codex, Claude, Cursor, or one Custom Agent skill root. Later local installs reuse the saved Skill install preference and relink the managed skills to the current checkout.

After changing CLI source code, run `bun run install:local` again before testing from another repo. For linked skills, file edits are visible immediately through symlinks. If you add or remove skill directories, rerun reconciliation (`bun run install:local` or `mt skills configure`) so flat Claude links are refreshed.

## Distributed Skills

Use `mt skills configure` to change which agents receive monke-tools skills. The command updates `config.yml` under the monke home directory and reconciles selected Agent skill roots immediately.

Built-in targets resolve against the OS home directory:

- Codex: `~/.codex/skills`
- Claude: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

Codex, Cursor, and custom targets receive one managed `monke-tools` namespace symlink inside the Agent skill root. Claude receives flat root-level symlinks for each source skill because Claude does not discover nested skill directories. monke-tools refuses to overwrite real files or directories in either layout.

The Skill source tree is organized as:

- `skills/internal`: monke-tools-owned Distributed skills, including `monke-tools-core`
- `skills/imported`: Imported skills preserved from outside projects

## Commands

- `mt create <session>` creates or updates a session from the source checkout. It materializes dependency repos first, seeds configured files, rewrites mapped env vars, creates worktrees under `~/.monke/worktrees/<repo-name>/<session>` by default, and records session state under `~/.monke`.
- `mt create <session> -m` also accepts `--main` or `--master`. It creates a fresh session from each repo's default branch content, preferring fetched `origin/main` or `origin/master` before local `main` or `master`.
- `mt materialize` refreshes the current session worktree in place and keeps the existing port assignments sticky.
- `mt cleanup` removes session records whose worktrees no longer exist.
- `mt setup` syncs external repo path env vars into the source checkout root `.env`.
- `mt skills configure` updates the saved Skill install preference and reconciles selected Agent skill roots.

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

`bootstrapCommand` runs from the session worktree after env files, dependency paths, and deterministic Resource values are written. Dynamic Resource command outputs are resolved after bootstrap when a bootstrap command exists, so resource modules can import packages installed or linked by bootstrap. Prefer bootstrap commands that produce outputs valid for that exact worktree. If a generator writes absolute paths into generated files, configure the generator task itself so cached outputs cannot be restored from another worktree. For example, Prisma clients generated through Turbo should use a non-cached `generate` task (`"cache": false`) so ordinary bootstrap commands like `pnpm generate` are safe.

## Development

```bash
bun run src/index.ts create banana
bun run src/index.ts materialize
bun run src/index.ts cleanup
bun run src/index.ts setup
bun run src/index.ts skills configure
```

Repo-specific Backlog.md guidance lives in [docs/agents/backlog.md](docs/agents/backlog.md).
