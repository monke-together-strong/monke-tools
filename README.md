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

## Public Release install

Install the newest stable public Release with the bootstrap from `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

To inspect the bootstrap before running it:

```bash
curl -fsSLo monke-tools-install.sh https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh
less monke-tools-install.sh
sh monke-tools-install.sh
rm monke-tools-install.sh
```

The bootstrap supports macOS arm64 and Linux x64. It reads the small `stable.tsv` catalog from the dedicated `monke-tools-release-catalog` branch, then downloads that Release's platform archive and checksums over HTTPS. The serialized Mainline workflow atomically advances the branch only after publishing and verifying the immutable Release. `GH_TOKEN` takes precedence over `GITHUB_TOKEN` when either is already set; public anonymous access is used otherwise. Before running the installer contained in the bundle, it requires the checksums asset and archive to match the catalog's SHA-256 metadata and the archive to match its published checksum. Catalog, platform, download, checksum, or extraction failures do not invoke installation logic.

The bundle installer activates the executable, Install manifest, Distributed guidance, and Global agent instructions from the same version under `~/.monke/installs`, behind the atomic `~/.monke/current` pointer. In a terminal it asks for Skill install targets after core activation. Automation can select built-in targets without prompting:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh -s -- --targets codex claude cursor
```

Automation can also select one Custom Agent skill root, alone or alongside built-in targets:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh -s -- --targets codex --custom-target /absolute/path/to/agent/skills
```

A noninteractive install without explicit or previously saved targets leaves the valid core install active and recommends `mt skills configure`; use that command to select targets later. Release-mode Skill and reference projections point into ordinary writable files in the Active tool install, while their original hashes remain in its Install manifest.

Only the current Bash or Zsh startup file is configured. Unsupported shells are left unchanged and receive manual PATH guidance. On Apple Silicon Macs, Codiff is reconciled after core activation using the Release manifest's minimum version: a missing or outdated Homebrew-owned Codiff is installed or upgraded through the checksummed cask. A Skill, Global instruction, or Codiff failure after activation leaves the Release core active. Retry target reconciliation with `mt skills configure` and dependency reconciliation with `mt install-dependencies`.

## Release updates

Use `mt update --check` to check the complete stable GitHub Releases catalog without changing installation state. Unlike the bootstrap's branch-backed `stable.tsv` pointer, this command discovers Releases through the GitHub Releases API. It validates the selected Release's tag family, source provenance, platform compatibility, required platform archive and checksums assets, download origins, and GitHub SHA-256 metadata. A completed check exits successfully whether the Active tool install matches the selected stable Release or a Release update is available; lookup, provenance, compatibility, or required-asset failures exit nonzero. Check-only mode never downloads assets, creates an Update staging directory, reconciles dependencies or Skill projections, cleans installs, or changes the Active tool install.

Use `mt update` to activate the highest stable `monke-tools-v*` Release. The command ignores drafts, prereleases, and releases for other packages, uses a nonempty `GH_TOKEN` before `GITHUB_TOKEN` when either is already available, and otherwise accesses the public repository anonymously. It never prompts. A clean Release install matching the selected stable Release is reported without replacement. An available Release bundle is downloaded into a unique Update staging directory, matched against both the published checksums and GitHub asset digest, fully verified, and atomically activated; only after Install activation are older managed installs cleaned, retaining the new Active tool install and its immediate predecessor. Failed lookup, download, verification, compatibility, or pre-activation work leaves the previous Active tool install selected. Recognized interrupted Update staging directories are discarded by the next mutating installation operation.

Running `mt update` from a Local tool install deliberately activates a Release install without reading or modifying the Installed source checkout, even when that checkout is dirty or already at the selected Release commit. The command reports the preserved checkout and explains that running `vp run install:local` from it activates a new Local tool install and restores Skill authoring mode.

Before any network or staging work, update compares a Release install's Distributed skills and references with the original hashes in its Install manifest. Modified, added, or removed guidance makes it a Customized release install: update stops, lists every changed path, and leaves downloads, activation, projections, dependencies, and cleanup untouched. V1 does not back up, migrate, merge, reset, or discard customized guidance. It also intentionally omits exact-version selection, force replacement, quiet mode, channels, partial-download resumption, an archive cache, historical-install management, and rollback.

For catalog, rate-limit, download, or verification failures, correct the reported network, credential, platform, or Release-asset problem and rerun `mt update`; the previous Active tool install remains selected. If a post-activation Skill projection or Codiff step fails, keep the valid new Release install and use the reported `mt skills configure` or `mt install-dependencies` retry command. For a Customized release install, first copy the listed edits to a safe location, restore those paths from the Release bundle named by the install's `releaseTag` in `install-manifest.json`, and rerun update. If those edits belong in source, copy them into the source checkout first; only then run `vp run install:local` to activate a Local tool install and continue in Skill authoring mode. Local refresh does not migrate or preserve Release-install edits on its own.

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

On the first local install, monke-tools prompts for one or more skill targets: Codex, Claude, Cursor, or one Custom Agent skill root. Later local installs reuse the saved Skill install preference and refresh the managed skills and instructions snapshot from the current checkout. Automation can replace the preference without prompting by passing explicit targets, for example `vp run install:local --targets codex --custom-target /absolute/path/to/agent/skills`.

After changing CLI source code, run `vp run install:local` again before testing from another repo. For linked skills, file edits are visible immediately through symlinks. If you add or remove skill directories, rerun reconciliation (`vp run install:local` or `mt skills configure`) so flat Claude links are refreshed.

The `create-pr` skill reads repository-root `PR.md` guidance when present, otherwise falling back to user defaults at `<monke-home>/instructions/PR.md`; use `mt home` to locate them.

## Mainline releases

A qualifying push to `main` continuously publishes the next stable patch Release under a `monke-tools-v<version>` tag. The version is derived from the highest existing stable monke-tools tag inside the serialized publication workflow and is not committed back to `main`. Release-owned inputs are CLI source, root dependencies and build configuration, Distributed skills and references, Global agent instructions, Local and Release installer behavior, and Release packaging behavior. Documentation-only changes and changes confined to other workspace packages do not publish an `mt` Release.

Each Release contains complete archives for macOS arm64 and Linux x64 plus one checksums asset. Platform jobs compile the selected version into `mt`, build the archive, execute `mt --version`, and run the shared archive verifier. Publication waits for both jobs, generates checksums covering both archives, and re-verifies their manifests, source commit, platform identities, guidance hashes, and checksums before attaching every asset to a draft and making it public. Repository Release immutability then binds the tag, commit, and assets; only then does the workflow advance the dedicated stable-catalog branch consumed by the public bootstrap. The public `install.sh` bootstrap is also a release-owned input, so changes to discovery or verification behavior trigger a new Mainline release.

Pull-request CI remains the full-test boundary. A direct `main` push runs `vp check` plus the two platform builds and Release contract validation, but it does not rerun `vp run test`. Existing Tegami package versioning and publication continues independently in its package workflow.

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
- `mt update [--check]` checks for or atomically activates the highest compatible stable monke-tools Release. Check-only mode is non-mutating; a Customized release install blocks both forms before network access.
- `mt shell install` refreshes the Shell adapter for the current Bash or Zsh startup file and reports that file; unsupported shells receive manual guidance without startup-file changes. `mt shell init bash` and `mt shell init zsh` print adapters for inspection.
- `mt skills configure` updates the saved Skill install preference and reconciles selected Agent skill roots.

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
