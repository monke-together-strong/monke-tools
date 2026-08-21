# Public CLI self-update configuration patterns

Research date: 2026-08-20

## Recommendation

Start with the smallest command-only interface:

```text
mt update                    # latest stable mt release
mt update --check            # resolve and verify metadata, but do not install
```

The important semantics should be:

- A bare `mt update` always targets the latest stable `mt` release. It should not follow the channel of the currently installed build.
- `--check` performs the same release selection and artifact-compatibility checks without changing the installation. It exits successfully after either a “current” or “update available” result and fails only when the check cannot be completed.
- The command never prompts. Progress and color are TTY-aware, and failures remain on standard error with a nonzero exit.
- Update the release as one unit: the compiled `mt` executable, `skills/`, `instructions/`, and release manifest must all come from and activate as the same version.
- A Release install may update in place. Explicit `mt update` from a Local tool install transitions to the selected Release bundle without changing the source checkout, even when the checkout is dirty or already at the release commit; running the local refresh workflow later transitions back to local. Record these transitions as installation provenance rather than inferring them from the executable path.
- Local tool installs retain live source-backed skill authoring. Transitioning to a Release install replaces those projections with release guidance; `/learn` and other local tools may modify the active projection, but those customizations are local-only rather than pushable source changes. Update output must identify the mode change, preserve the checkout, and print the local refresh command that restores tracked live authoring.
- Refuse to update a customized Release install. Compare projected skills and references with the hashes recorded in its install manifest, report every changed path, and exit without downloading, activating, configuring, or cleaning anything. V1 does not back up, migrate, discard, or reset those changes.
- Keep Codiff external to the Release bundle. On macOS arm64, the Release installer, Local install refresh, and Release update all reconcile Codiff through Homebrew: install it when missing, upgrade it only when below the minimum required by the target `mt`, and accept any newer compatible version. A Codiff reconciliation failure does not roll back an already activated `mt` release.
- Store provenance inside each versioned install so the atomic `current` pointer selects the executable, guidance, and their install manifest together. Do not duplicate active-install identity in Global monke config.
- Stage each update in a unique temporary directory, verify it completely, rename it into the versioned installs directory, and only then atomically switch `current`. Discard recognized incomplete staging directories on the next update; do not add partial-download resumption or a separate archive cache in v1.
- Serialize tool-managed installation and projection mutations with one machine-wide installation lock. Release updates, official installer activation, Local install refresh, skill configuration, and installed-release cleanup acquire it; ordinary `mt` commands and direct edits to projected guidance do not.
- Discover releases through GitHub's releases API, filtering stable `monke-tools-v*` tags rather than using the repository-wide latest release. Use `GH_TOKEN` or `GITHUB_TOKEN` only when already present and otherwise use unauthenticated public-repository access; do not add an mt-specific credential setting.
- Publish a thin `install.sh` bootstrap on the repository's `main` branch for the convenient `curl | sh` path, plus a download-and-inspect-first alternative. The bootstrap performs only platform detection, release discovery, verification, and delegation to bundle-owned installation code.
- Configure shell integration only for the user's current `$SHELL` when it is Bash or Zsh. Report the startup file changed and require a shell restart; for unsupported shells, leave startup files untouched and print manual instructions.
- Expose `mt --version` as the official semantic version for Release installs and as `local+<short-commit>` with an additional `-dirty` marker for dirty Local tool installs. Installation and update logic reads the install manifest rather than parsing this display value.
- Publish a new stable patch release automatically after a qualifying push to `main`; do not require a Release PR or commit a version bump back to the branch. Derive the next version from the highest existing `monke-tools-v*` tag and publish only after both platform bundles are complete.
- Do not rerun the full unit-test suite in the mainline release workflow. Keep `vp check`, build both supported bundles, execute each built binary's version command, and validate every archive, manifest, and checksum before publishing. Pull requests remain the full-test boundary; direct pushes intentionally receive only static and artifact validation.

The next coherent extension is exact selection with `mt update <version>` and narrow same-version repair with `--force`. Exact downgrade must wait for an installation-state compatibility rule: replacing the release bundle does not roll back Global monke config or Session state written by a newer binary. `--quiet` is useful only when normal TTY-aware output still proves noisy in automation.

Do **not** add persistent channels, automatic installation, a configurable polling interval, an arbitrary download URL, or a dedicated rollback command in the first version. They can be added without changing the core command contract if real usage calls for them. Homebrew is intentionally out of scope as an installation owner for `mt`; it remains the macOS dependency manager for Codiff.

## Comparison of first-party interfaces

| Tool                 | Default and explicit targets                                                                                                                         | Channels                                                                                                                                          | Check, force, and scripting                                                                                                                                                            | Automatic checks and ownership                                                                                                                                                              | Mirror or rollback story                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deno                 | Bare `deno upgrade` selects latest stable; a positional version or `--version` selects an exact release.                                             | Positional `stable`, `lts`, `rc`, and `canary` targets select the latest build in that channel; a bare version is explicitly a stable coordinate. | `--dry-run` checks without replacement, `--force` replaces even when current, `--quiet` is intended for scripts/CI, and `--output` downloads without replacing the running executable. | Deno checks for a new CLI version at most daily and `DENO_NO_UPDATE_CHECK=1` disables that passive check.                                                                                   | The documented command resolves through Deno's service/GitHub releases, supports a caller-provided SHA-256 with `--checksum`, and exact older versions provide manual downgrade rather than a separate rollback command. ([upgrade reference](https://docs.deno.com/runtime/reference/cli/upgrade/), [update-check behavior](https://docs.deno.com/runtime/reference/permissions/))                                                                                                                                                                   |
| Bun                  | `bun upgrade` self-updates; older versions are installed by rerunning the installer with an exact tag/version.                                       | `--canary` moves to the latest canary and `--stable` moves back to stable.                                                                        | The public installation page exposes the channel switches but no check-only or force option.                                                                                           | The docs tell Homebrew and Scoop installations to update through those package managers rather than overwrite their files.                                                                  | Re-running the official installer with an older exact version is the documented downgrade path. ([Bun installation and upgrade](https://bun.com/docs/installation))                                                                                                                                                                                                                                                                                                                                                                                   |
| uv                   | `uv self update` targets latest; an optional positional `TARGET_VERSION` selects an exact version.                                                   | The self-update reference does not expose persistent release channels.                                                                            | `--dry-run`, `--quiet`, `--no-progress`, automatic TTY color handling, and offline/config controls are available.                                                                      | Self-update works for the standalone installer, is disabled for other installation methods, and is also disabled by the unmanaged installation mode intended for ephemeral/CI environments. | Environment variables can replace the GitHub or GitHub Enterprise base URL used by the installer and self-update; exact target versions provide the downgrade path. ([self-update CLI](https://docs.astral.sh/uv/reference/cli/#uv-self-update), [installation ownership](https://docs.astral.sh/uv/getting-started/installation/#upgrading-uv), [unmanaged installs](https://docs.astral.sh/uv/reference/installer/#unmanaged-installations), [mirror variables](https://docs.astral.sh/uv/configuration/environment/#uv_installer_github_base_url)) |
| rustup               | `rustup self update` updates rustup itself to latest; `RUSTUP_VERSION` is an advanced exact-version override used by the installer/self-update path. | Toolchains have stable/beta/nightly and exact/date coordinates, while the self-updater can be redirected to a different update root.              | `rustup update --no-self-update` suppresses a coupled self-update on one invocation.                                                                                                   | Persistent `auto-self-update` policy has `enable`, `disable`, and `check-only`; distributors can build rustup without self-update support.                                                  | `RUSTUP_UPDATE_ROOT` changes the self-update root, and the official release process uses separate roots for beta and stable updater builds. ([basic self-update policy](https://rust-lang.github.io/rustup/basics.html), [toolchain coordinates](https://rust-lang.github.io/rustup/concepts/toolchains.html), [update environment](https://rust-lang.github.io/rustup/environment-variables.html), [release roots](https://rust-lang.github.io/rustup/dev-guide/release-process.html))                                                               |
| mise                 | `mise self-update` resolves latest and an optional positional version selects an exact release.                                                      | No persistent self-update channel is exposed.                                                                                                     | `--force` updates even when current, `--yes` skips confirmation, and `--no-plugins` prevents the default post-update plugin refresh.                                                   | Packagers can disable self-update; the command then tells users to update the same way they installed mise, with packager-supplied instructions when available.                             | Release archives are selected by exact version tag and verified with mise's bundled signing key; an older positional version supplies downgrade. ([mise self-update source](https://github.com/jdx/mise/blob/b1a96061e44bb4e0f689b8bce5b35df7f549ed69/src/cli/self_update.rs#L86-L104), [selection and verification](https://github.com/jdx/mise/blob/b1a96061e44bb4e0f689b8bce5b35df7f549ed69/src/cli/self_update.rs#L319-L358))                                                                                                                     |
| GitHub CLI notifier  | GitHub CLI is useful here as a notification pattern rather than a self-update interface.                                                             | None for the notifier.                                                                                                                            | Notifications are written to standard error, keeping normal command output separate.                                                                                                   | `gh` checks at most once every 24 hours when commands run; `GH_NO_UPDATE_NOTIFIER` disables CLI notices, and a separate variable disables extension notices.                                | Not applicable. ([GitHub CLI environment reference](https://cli.github.com/manual/gh_help_environment))                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Worktrunk diagnostic | Worktrunk is useful as an explicit-check pattern rather than a self-updater.                                                                         | None.                                                                                                                                             | `wt config show --full` includes a version check in broader diagnostics; it reports “update available,” “up to date,” or a non-fatal “version check unavailable” result.               | It performs the network check only when full diagnostics are requested, avoiding background polling and ordinary-command noise.                                                             | It queries the repository's latest GitHub release and only reports status; installation remains external. ([command definition](https://github.com/max-sixty/worktrunk/blob/648f1a866eeb88355adce774184173b75f9b151f/src/cli/config.rs#L487-L509), [version-check implementation](https://github.com/max-sixty/worktrunk/blob/648f1a866eeb88355adce774184173b75f9b151f/src/commands/config/show.rs#L1544-L1625))                                                                                                                                      |

The repeated pattern is a stable default plus explicit escape hatches. Deno and uv make exact targets and non-mutating checks first-class; Bun, uv, mise, and rustup respect the owner of the installed executable; GitHub CLI bounds passive checks while Worktrunk avoids them entirely in favor of an explicit diagnostic; rustup shows that automatic **installation** requires substantially more policy than a passive notification.

## Design choices for `mt`

### 1. Stable default versus “current channel”

There are three plausible policies:

1. **Stable is always the default.** A prerelease installed explicitly returns to stable on the next bare update.
2. **Follow the installed build.** A prerelease continues following prereleases until the user switches back.
3. **Remember a configured channel.** A machine-level setting controls every future bare update.

Deno chooses the first mental model: no-argument upgrade is stable, channel names are explicit, and a bare version is a stable coordinate even when a same-numbered build exists in another channel. Bun exposes explicit `--canary` and `--stable` switches. ([Deno channels](https://docs.deno.com/runtime/reference/cli/upgrade/#channels), [Bun canary builds](https://bun.com/docs/installation#canary-builds))

Choose **stable is always the default** for `mt`. There is no established `mt` prerelease program yet, so persistent channel state would create policy without a release process to support it. Prerelease tags may exist for release-pipeline testing, but the v1 updater ignores them. If a real rolling prerelease channel appears later, add an explicit `--channel stable|next` flag first; only persist it after users demonstrate that repeatedly typing the flag is a problem.

### 2. Positional exact version versus `--version`

Deno documents both a version positional and `--version`, while uv uses an optional positional target and Bun puts exact versions on its installer rather than the updater. ([Deno exact versions](https://docs.deno.com/runtime/reference/cli/upgrade/#upgrade-to-a-specific-version), [uv target version](https://docs.astral.sh/uv/reference/cli/#uv-self-update), [Bun older versions](https://bun.com/docs/installation#installing-older-versions))

Defer exact selection from the smallest interface. If it is introduced, use one spelling: `mt update <version>`. It is concise, leaves `mt --version` unambiguous, and can later coexist with named channels if those are deliberately introduced. Accept `1.2.3` at the user boundary and construct the repository-specific tag internally; do not make users know the tag prefix. Before allowing an older target, define how the older executable proves that persisted Global monke config and Session state are still readable.

### 3. `--check` versus `--dry-run`

Deno and uv name the non-mutating updater mode `--dry-run`; Deno describes it as performing checks without replacing the executable, while uv describes it as running without performing the update. ([Deno upgrade options](https://docs.deno.com/runtime/reference/cli/upgrade/#upgrade-options), [uv self-update options](https://docs.astral.sh/uv/reference/cli/#uv-self-update))

Prefer `--check` for `mt`. The operation is not previewing a multi-step plan: it is answering whether a compatible release exists. `--check` should still fetch release metadata, select the correct `mt` tag family, validate that the current platform has the required bundle, and report installed/target versions. It should never stage files or move the active-install pointer.

For v1, a completed check exits `0` whether the installation is current or an update is available; a lookup, compatibility, or provenance failure exits `1`. This keeps “an update exists” informational and matches the CLI's existing success/failure model. Add structured output only when an automation consumer needs to branch on the result, and add `--quiet` only if TTY-aware output is still noisy.

### 4. `--force` should not mean “unsafe”

Deno's `--force` replaces the executable even when it is not out of date. It separately exposes checksum verification, so force and integrity are distinct concerns. ([Deno upgrade options](https://docs.deno.com/runtime/reference/cli/upgrade/#upgrade-options))

If `--force` is added, give it the same narrow meaning: reacquire and reactivate the resolved release even if its version equals the active one. This is useful for repairing a damaged bundle. Never let it select drafts, ignore the `mt` tag namespace, skip digest checks, accept the wrong platform, mutate a local source checkout, or delete the retained previous release. The first version can omit it and use the standalone installer as the explicit repair path.

### 5. Automatic checks: notification only, later

There are three levels of automation in the surveyed tools:

- no automatic check, only an explicit update command;
- a bounded passive availability check with an opt-out, as used by Deno and GitHub CLI; and
- automatic self-install policy, as exposed by rustup's `enable`/`disable`/`check-only` setting. ([Deno daily check](https://docs.deno.com/runtime/reference/permissions/), [GitHub CLI 24-hour notifier](https://cli.github.com/manual/gh_help_environment), [rustup self-update policy](https://rust-lang.github.io/rustup/basics.html#keeping-rustup-up-to-date))

Ship the explicit updater first. If discoverability is poor, add a passive stable-release notice at most once every 24 hours after ordinary successful commands. Never install from an unrelated command. Use a fixed interval rather than a user-configurable duration, suppress it automatically for non-TTY/CI use, and offer `MT_NO_UPDATE_CHECK=1` as the immediate opt-out. If a persistent preference is later needed, add an `updateCheck: true|false` field to **Global monke config**; that config is already the machine-local preference boundary at `$MONKE_HOME/config.yml`. ([Global config implementation](../../src/global-config.ts), [Global config terminology](../../CONTEXT.md#agent-guidance))

### 6. Installation provenance is authorization

uv disables self-update outside its standalone installation and for unmanaged CI installs; Bun delegates to the package manager that installed it; rustup distributors can compile out self-update support. These tools treat installation ownership as part of the update decision, not merely as documentation. ([uv upgrading](https://docs.astral.sh/uv/getting-started/installation/#upgrading-uv), [uv unmanaged installs](https://docs.astral.sh/uv/reference/installer/#unmanaged-installations), [Bun upgrading](https://bun.com/docs/installation#upgrading), [rustup self-update availability](https://rust-lang.github.io/rustup/basics.html#keeping-rustup-up-to-date))

`mt` should record at least:

```yaml
install:
  kind: release # or local
  root: /absolute/managed/install/root
  version: 1.2.3
  commit: abc1234
```

This is a manifest/provenance record, not a user preference. A `release` installation authorizes atomic replacement within its managed root. Explicit `mt update` from a `local` installation authorizes a transition to the selected release without modifying the recorded source checkout; the local refresh workflow may later activate a new local build again. Future package-managed installation kinds can delegate to their owner without changing release installs, but no package-manager integration is part of this proposal.

Store that manifest inside its versioned installation directory rather than in Global monke config. The active `current` pointer then selects one self-describing installation as a unit and cannot disagree with a separately written active-version field. A Release install manifest records its version, source commit, release tag, artifact digest, minimum Codiff version, and original guidance hashes; a Local tool install manifest records its source checkout and source commit.

All tool-managed operations that mutate installation state or agent guidance projections share one installation lock: Release update, Release installer activation, Local install refresh, skill configuration, and installed-release cleanup. The lock prevents two mutators from calculating predecessor retention or rewriting projections from stale active-install state. Ordinary `mt` operations do not acquire it. A running executable remains independent of a later pointer switch, and direct edits such as `/learn` changes are intentionally outside this coordination boundary.

This distinction is required by the current repository shape: the local installer compiles and copies `mt` into `~/.local/bin`, then installs skills from the source checkout; the Global monke config records that checkout, and skill installation currently requires it. ([local installer](../../scripts/install-local.sh), [Global config schema](../../src/global-config.ts), [skill source resolution](../../src/skills.ts)) A public release must define how its versioned release root and the developer's live Skill source tree interact instead of assuming that one source checkout owns every payload.

Codiff follows a separate ownership rule. It is an external runtime dependency, not part of the version-aligned Release bundle. Each `mt` release declares a minimum supported Codiff version and accepts newer versions without downgrading them. On macOS arm64, all three installation paths—Release installer, Local install refresh, and Release update—use the same dependency reconciliation command. That command verifies `codiff --version`, installs the current trusted checksummed cask when Codiff is missing, and upgrades the Homebrew-owned cask only when its installed version is below the target release's minimum. If Homebrew is unavailable, `mt` remains usable and reports how to install Codiff; if reconciliation fails after activation, the valid `mt` release remains active and the command reports a separately retryable dependency failure.

The current local workflow is weaker than this target contract: its Brewfile has no version pin, Homebrew Bundle may leave an older auto-updating Codiff untouched, runtime accepts any Codiff `>=1.9.0`, and `mt install-dependencies` currently performs no verification. Homebrew's rolling Brewfile model has no lock file, which is appropriate here because the desired contract is minimum compatibility rather than exact alignment. ([Homebrew Bundle versions](https://docs.brew.sh/Brew-Bundle-and-Brewfile#versions), [current Brewfile](../../Brewfile), [Codiff runtime check](../../src/codiff.ts), [dependency command](../../src/monke.ts))

### 7. Alternate URLs and mirrors

Rustup exposes a self-update root environment variable, and uv exposes environment variables for GitHub/GitHub Enterprise installer bases and a broader Astral mirror. Both keep mirror selection outside the ordinary human command shape. ([rustup update root](https://rust-lang.github.io/rustup/environment-variables.html), [uv mirror variables](https://docs.astral.sh/uv/configuration/environment/#uv_astral_mirror_url))

Do not expose `mt update --url <arbitrary-archive>` initially. A release bundle contains executable code plus agent instructions, so a persistent or casually supplied URL has a larger trust consequence than downloading data. If corporate mirroring becomes a real requirement, add an advanced `MT_RELEASE_BASE_URL` environment override that must serve the same signed/checksummed manifest and platform bundle layout. Keep it ephemeral, display the non-default origin in update output, and never let `--force` relax verification.

### 8. CI and noninteractive behavior

Deno explicitly positions `--quiet` for scripting/CI, uv provides quiet/no-progress/offline controls, and uv's unmanaged install mode is designed for ephemeral environments and disables self-update. ([Deno quiet mode](https://docs.deno.com/runtime/reference/cli/upgrade/#quiet-flag), [uv self-update CLI](https://docs.astral.sh/uv/reference/cli/#uv-self-update), [uv unmanaged installs](https://docs.astral.sh/uv/reference/installer/#unmanaged-installations))

For `mt`:

- Never prompt in `mt update`; explicit invocation is the authorization.
- Disable animation and color automatically when output is not a TTY; if `--quiet` is later added, it removes routine output.
- Do not passively check from CI/non-TTY commands.
- Prefer installing an exact `mt` release in CI rather than mutating a runner during a job.
- Make `mt update --check` deterministic through exit status.
- Treat download, checksum, platform, manifest, and activation failures as hard failures without changing the active release.

### 9. Rollback

The surveyed command references do not expose a dedicated rollback command. Deno, uv, and Bun all make an older exact version installable, which is sufficient as an escape hatch when old artifacts remain available. ([Deno exact versions](https://docs.deno.com/runtime/reference/cli/upgrade/#upgrade-to-a-specific-version), [uv target version](https://docs.astral.sh/uv/reference/cli/#uv-self-update), [Bun older versions](https://bun.com/docs/installation#installing-older-versions))

Treat `mt update <older-version>` as an explicit **binary and guidance downgrade**, not as rollback. Global monke config, Session state, and other data may already have been written by the newer executable, so the updater must reject an older release unless compatibility can be proven. Retaining the previously active release is still useful for diagnosis and for a future offline rollback design, but safe rollback would need a state-compatibility or state-restoration contract in addition to atomic release activation.

## Repository-specific release selection

The monke-tools GitHub repository already contains releases whose tags belong to other workspace packages, including `@monke-together-strong/oxc-config@...`; GitHub currently labels one of those package releases as the repository's latest release. ([monke-tools releases](https://github.com/monke-together-strong/monke-tools/releases)) The checked-in release configuration currently publishes that package through Tegami. ([release configuration](../../scripts/tegami.mts), [publish workflow](../../.github/workflows/publish.yml))

Therefore `mt update` must never trust the repository-wide `/releases/latest` result. It should list releases, reject drafts, filter to the dedicated `monke-tools-v` tag namespace, apply stable/prerelease selection within that namespace, parse semantic versions, and then choose the highest matching version. Exact requests should resolve the constructed tag directly. GitHub's release API exposes `tag_name`, `draft`, `prerelease`, asset metadata, and an asset digest field needed for this selection and verification. ([GitHub release API](https://docs.github.com/en/rest/releases/releases))

For authenticated API access, use the conventional `GH_TOKEN` or `GITHUB_TOKEN` environment variable only when one is already present; otherwise query this public repository anonymously. Do not add a monke-tools credential preference. Lookup or rate-limit failures are ordinary check/update failures and never change the active installation.

Recommended tag and bundle contract:

```text
tag: monke-tools-v1.2.3

assets:
  monke-tools-v1.2.3-darwin-arm64.tar.gz
  monke-tools-v1.2.3-linux-x64.tar.gz
  monke-tools-v1.2.3-checksums.txt
```

Each platform archive should carry its own release manifest plus the executable, `skills/`, and `instructions/`. GitHub immutable releases additionally bind the tag, commit, and assets in a release attestation; enabling them would strengthen the published release contract without changing the user-facing update command. ([GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases))

The public convenience bootstrap is a small `install.sh` fetched from the repository's `main` branch. It detects the platform, discovers the newest matching release through the same GitHub API rules, verifies the selected artifact, and invokes installer logic shipped inside that bundle. Because the convenience bootstrap itself is mutable, documentation should also show how to download and inspect it before execution. A future stable custom domain may replace the bootstrap URL without changing the release or update contract.

Official `mt` releases are continuous mainline releases rather than Release-PR publications. After a qualifying `main` push, the workflow derives the next patch version from the highest existing `monke-tools-v*` tag, runs static validation, builds both supported platform archives, executes each built binary's version command, and validates all manifests and checksums. Only then does it publish the complete immutable release. It does not commit a version bump to `main` and does not rerun the full unit-test suite; pull requests remain the full-test boundary, so a direct main push deliberately receives only `vp check` and release-artifact validation.

## Staged scope

### First public release/update contract

- Dedicated `monke-tools-v*` release namespace and complete platform bundles.
- Installation provenance with `release` and `local` ownership.
- `mt update` and `mt update --check`.
- Atomic activation, digest verification, and retained previous release.
- Per-install provenance manifests selected by the active pointer.
- Fully verified temporary staging with no partial-download resume or archive cache.
- One installation mutation lock, without locking ordinary `mt` commands or direct guidance edits.
- GitHub API discovery with standard optional GitHub environment credentials.
- Thin public shell bootstrap with convenience and inspect-first invocation paths.
- Current-shell-only Bash/Zsh integration and explicit unsupported-shell guidance.
- Distinct release and local `mt --version` identities.
- Continuous stable patch releases from qualifying `main` pushes.
- Static and artifact-specific release validation without repeating the full PR test suite.
- Detection and refusal to replace locally customized release guidance.
- Minimum-compatible Codiff reconciliation through Homebrew on macOS arm64, without bundling or exact pinning.

### Add only after demonstrated demand

- Exact positional versions after defining persisted-state compatibility.
- Narrow same-version repair through `--force`.
- `--quiet` if TTY-aware output is insufficient for automation.
- Passive daily stable-release notification plus `MT_NO_UPDATE_CHECK=1`.
- Explicit prerelease channel selection.
- Mirror base URL with the same verified manifest contract.
- Structured check output.
- Offline `mt rollback` to the retained release.

### Avoid

- Updating from `main` or another mutable branch.
- Repository-wide “latest release” discovery.
- Automatic installation during unrelated commands.
- Guessing installation ownership from `PATH`.
- Letting `--force` weaken validation.
- Persisting an exact-version pin in machine config; exact versions belong in the invoking command or CI bootstrap.
- Treating a dependency package manager as the installation owner for `mt` itself.
