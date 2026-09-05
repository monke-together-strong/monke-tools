# monke-tools

`monke-tools` gives each coding session its own Git worktrees, ports, and environment values across a repo and its dependencies. It also distributes shared agent skills to Codex, Claude, Cursor, and custom agents.

## Install

Install the latest stable release on macOS arm64 or Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

The installer asks which agents should receive skills and configures your current Bash or Zsh shell. Follow its shell instructions before starting a session. To choose skill targets later, run `mt skills configure`.

For unattended installation, replace the trailing `sh` with `sh -s -- --targets codex claude cursor`. See the [installation guide](skills/internal/monke-tools-core/INSTALLATION.md) for custom targets, local builds, and recovery.

## Start a session

From a repo with `monke.yml`:

```bash
mt spawn banana          # Prepare this repo and its dependencies
mt diff                  # Review the current checkout in Codiff
mt swing '^'             # Return to the source checkout
mt swing banana          # Return to the session
mt materialize           # Refresh the session's env and bootstrap
```

Use `mt spawn banana --codex` to also open the session as a Codex workspace. New worktrees normally carry your uncommitted source changes; use `-m` to create a new session from default-branch content instead. For an incomplete session, `-m` resumes retained worktrees and pinned session refs.

When finished, `mt chop banana` removes the session's worktrees and runs its recorded cleanup commands, preserving local branches. Dirty files block removal; ignored files are deleted with the worktrees. Preview broader merged-session cleanup with `mt cleanup --merged --dry-run`.

The [session command reference](skills/internal/monke-tools-core/SKILL.md) covers branch reuse, PR navigation, diff bases, and cleanup recovery. Use `mt <command> --help` for available flags.

## Configure a repo

Add `monke.yml` at the repo root. For example, this maps an assigned session port into `PORT` in `apps/api/.env`:

```yaml
apps:
  api:
    path: apps/api
    mappings:
      - port: API_PORT
        env: PORT
```

The [configuration reference](skills/internal/monke-tools-core/MONKE-YML-REFERENCE.md) covers dependency repos, custom env files, bootstrap, seed files, and session resources.

## Agent skills

Run `mt skills configure` to select agents or change the saved targets. Codex and Claude also receive shared global instructions; existing guidance outside the managed section is preserved.

The [monke-tools-core skill](skills/internal/monke-tools-core/SKILL.md) guides agents through session work, configuration, and installation. Other workflows live in [internal skills](skills/internal) and [imported skills](skills/imported). See [agent guidance distribution](docs/reference/agent-guidance.md) for target layouts and ownership.

## Update

```bash
mt update --check         # Check without changing the install
mt update                # Activate the latest stable release
```

Updating a local build switches to a release install while preserving the source checkout. Edits to installed release skills or references block updates; follow the [recovery guide](skills/internal/monke-tools-core/INSTALLATION.md#update-recovery) to preserve them.

## Development

Install [Vite+](https://viteplus.dev/guide/), then run from this checkout:

```bash
vp install
vp run install:local
```

Rerun the local install after CLI changes before testing from another repo. Locally installed skills link to source, so edits are visible immediately; adding or removing skill directories requires `mt skills configure` to refresh links.

Run `vp check <changed-files>` for scoped formatting, lint, and type checks. Use `vp run test -- <test-file>` for focused tests: the package script runs Vitest under Bun. PR CI owns the full suite. Build the standalone executable through `install:local`.

For implementation details, see [CONTEXT.md](CONTEXT.md) and [installation and releases](docs/reference/installation.md). Track work in [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues).
