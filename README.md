# monke-tools

This repo uses Vite+ as its unified toolchain and Bun as its package manager and runtime.

`monke-tools` creates Session worktrees for a Root repo and its Dependency repos, rewrites Managed env files with unique Assigned ports, syncs Path env values into each Session worktree's root `.env`, and lets you Materialize the Session again.

## Quick start

Install [Vite+](https://viteplus.dev/guide/) once, then use it for project tooling:

```bash
curl -fsSL https://vite.plus | bash
vp install
vp check
vp run test
```

`monke-tools` remains intentionally Bun-native. Use `vp run test` instead of the built-in `vp test` so Vitest runs under Bun, and use `vp run install:local` instead of `vp build` or `vp pack` because the installed artifact is a Bun-compiled standalone executable rather than a Vite web app or JavaScript library package.

## Local install

```bash
vp run install:local
mt spawn banana
mt spawn banana --codex
mt spawn banana --no-dirty
mt spawn banana -m
```

`vp run install:local` builds a uniquely identified Local tool install under `~/.monke/installs`, records its source commit, dirty state, platform, creation identity, and Tool build identity in `install-manifest.json`, then activates it through the atomic `~/.monke/current` pointer. `~/.local/bin/mt` remains a stable symlink through that pointer; `~/.local/bin/monke` aliases the same command, and the obsolete `~/.local/bin/monke-tools` command is removed. The Active Install manifest—not Global monke config—records the Installed source checkout.

The refresh then installs shell integration only for the current Bash or Zsh startup file, installs source-backed Distributed skill and reference links into the selected Agent skill roots, refreshes Global agent instructions for selected Codex and Claude targets, and reconciles Codiff 1.9.0 or newer on Apple Silicon Macs. Missing Codiff is installed through the narrowly trusted checksummed Homebrew cask; an older Homebrew-owned Codiff is upgraded, while an older executable with unknown ownership is left untouched. Other platforms never invoke Homebrew. A Codiff failure is reported separately after activation, so the new core Local tool install remains active and reconciliation can be retried with `mt install-dependencies`.

On the first local install, monke-tools prompts for one or more skill targets: Codex, Claude, Cursor, or one Custom Agent skill root. Later local installs reuse the saved Skill install preference and refresh the managed skills and instructions snapshot from the current checkout. Automation can replace the preference without prompting by passing built-in targets explicitly, for example `vp run install:local --targets codex claude cursor` or `mt skills local-install <source-checkout> --targets codex claude cursor`.

After changing CLI source code, run `vp run install:local` again before testing from another repo. For linked skills, file edits are visible immediately through symlinks. If you add or remove skill directories, rerun reconciliation (`vp run install:local` or `mt skills configure`) so flat Claude links are refreshed.

The `create-pr` skill reads repository-root `PR.md` guidance when present, otherwise falling back to user defaults at `<monke-home>/instructions/PR.md`; use `mt home` to locate them.

## Distributed Skills

Use `mt skills configure` to change which agents receive monke-tools skills. The command updates `config.yml` under the monke home directory and reconciles selected Agent skill roots immediately.

Built-in targets resolve against the OS home directory:

- Codex: `~/.codex/skills`
- Claude: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

Codex, Cursor, and custom targets receive a managed `monke-tools` namespace containing symlinks to compatible source folders. Codex receives shared skills plus Codex-only skills; Cursor and custom targets receive shared skills only. Claude receives flat root-level symlinks for each shared source skill because Claude does not discover nested skill directories. monke-tools refuses to overwrite non-symlinks at managed folder names or root-level skills.

Codex and Claude targets also receive the shared `instructions/GLOBAL.md` snapshot in a marker-delimited Managed instruction section. Codex writes `AGENTS.md` under `CODEX_HOME` or `~/.codex`; Claude writes `CLAUDE.md` under `CLAUDE_CONFIG_DIR` or `~/.claude`. Refreshes preserve guidance outside the managed section, and deselecting a target removes only managed content. Cursor and Custom targets remain skills-only. Repo guidance may specialize or override these Global agent instructions.

The Skill source tree is organized as:

- `skills/internal`: monke-tools-owned Distributed skills, including `monke-tools-core`
- `skills/imported`: discoverable Imported skills preserved from outside projects
- `skills/codex`: monke-tools-owned skills installed only for the built-in Codex target
- `skills/references`: non-invocable Internal and Imported references used by Distributed skills

## Commands

- `mt home` prints the absolute Monke home path, honoring `MONKE_HOME` and defaulting to `~/.monke`, without creating it.
- `mt spawn <session> [--codex]` creates a Session branch from the source checkout's current HEAD when one does not already exist, reuses an existing Session branch at its current tip, creates or updates the corresponding Session worktrees under `~/.monke/worktrees/<repo-name>/<session>`, and materializes dependency repos first. Dirty source changes are carried into newly created worktrees by default only when that Session branch tip equals source `HEAD`; existing Session worktrees are reused as-is and dirty source changes are not copied into them (a warning says so). Add `--codex` to open the root Session worktree as a Codex workspace.
- `mt spawn <session> --no-dirty` preserves the old strict behavior and rejects dirty source checkouts.
- `mt spawn <session> -m` also accepts `--main` or `--master`. It creates a fresh session from each repo's resolved default branch ref, preferring fetched `origin/main` or `origin/master` before local `main` or `master`, and does not carry dirty source changes.
- `mt swing [target] [--codex]` navigates to an existing Session worktree or any other linked Git worktree by branch name, `^` for the Source checkout, `-` for the Previous Swing target, or a same-repo GitHub pull request target such as `pr:123`. Explicit PR targets (`pr:123` or a PR URL) fetch the PR head, create the Session if missing, and refuse to navigate if the local Session branch diverged from the PR head. Omit `target` to choose from an interactive Swing picker containing both Session and ordinary linked worktrees. Add `--codex` to open the checkout as a Codex workspace.
- `mt diff [-p|--pick]` opens Codiff for the checkout containing the current directory without navigating the shell. A fresh Session remembers the full branch ref it was spawned from and plain `mt diff` uses that ref immediately when valid. A Session without a remembered base infers `main` or `master` only when the current branch is not itself `main` or `master`, its checkout differs from an unambiguous default-branch candidate with one merge-base, and no non-default branch has nearer or incomparable shared history; Diff then remembers that base after Codiff launches successfully. If the Session was rebased onto unambiguously newer default-branch history, Diff automatically adopts that local or remote-tracking ref without fetching. Otherwise Diff offers the Source checkout, other Session and ordinary worktrees, detached worktrees, and local-only mode as comparison bases. Add `--pick` to force that picker. Worktree targets contribute committed state only, while the current checkout contributes its committed, staged, unstaged, and untracked changes. Diff warns when a Session branch is attached elsewhere because it still reviews the current checkout.
- `mt materialize` refreshes the current Session worktree in place and reuses its existing Assigned ports.
- `mt chop [target] [--force]` removes one current or explicitly selected Session or Ordinary worktree while preserving local branches. A Session target removes every worktree recorded in its Session state, then runs its saved Cleanup commands Root-first; selecting any recorded Session-member path promotes to the whole owning Session, and retained state makes interrupted teardown retryable. Ordinary worktrees can be selected by checked-out branch or registered absolute/relative path in the invoking repository, while detached worktrees require current/path selection. Staged, modified, and untracked files block removal unless `--force` explicitly discards them; ignored files are always deleted with removed worktrees.
- `mt cleanup` removes Session state records whose Dead worktrees no longer exist and runs recorded Cleanup commands; `mt cleanup --merged` additionally removes Session worktrees for Merge-cleanable Sessions whose branch is proven by a Merged PR (`--dry-run` to preview without removing).
- `mt setup` syncs Path env values into the Source checkout root `.env`.
- `mt shell install` refreshes the Shell adapter for the current Bash or Zsh startup file and reports that file; unsupported shells receive manual guidance without startup-file changes. `mt shell init bash` and `mt shell init zsh` print adapters for inspection.
- `mt skills configure` updates the saved Skill install preference and reconciles selected Agent skill roots.
- `mt skills local-install <source-checkout> [--targets <targets...>]` reconciles source-backed guidance using the explicit checkout, then either replaces the preference with explicit Codex, Claude, or Cursor targets, reuses the saved preference, or prompts through Skills Configure when no preference exists. Local install refresh records the checkout in the Active Install manifest.

## `monke.yml`

Each repo that participates in a session graph declares its apps, env rewrites, optional dependency repos, and optional bootstrap or seed behavior in `monke.yml`. An app `path` may be `.` when the app lives at the repo root; `envFile` is resolved relative to that app path. `envFile` defaults to `.env`, so omit it for apps that use `.env` and set it only for non-default files like `.env.local`.

```yaml
seedPaths:
  - scripts/bootstrap.sh
bootstrapCommand: pnpm install && pnpm generate
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
```

`bootstrapCommand` runs from the Session worktree after Managed env files, Path env values, and deterministic Resource values are written. Dynamic Resource command outputs are resolved after bootstrap when a bootstrap command exists, so resource modules can import packages installed or linked by bootstrap. Prefer bootstrap commands that produce outputs valid for that exact worktree. If a generator writes absolute paths into generated files, configure the generator task itself so cached outputs cannot be restored from another worktree. For example, Prisma clients generated through Turbo should use a non-cached `generate` task (`"cache": false`) so ordinary bootstrap commands like `pnpm generate` are safe.

Work is tracked in [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues).
