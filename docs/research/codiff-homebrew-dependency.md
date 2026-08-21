# Codiff as a monke-tools dependency

Research date: 2026-08-07

## Recommendation

Treat Codiff as an **optional, macOS/Apple-Silicon developer dependency**, not as an unconditional runtime dependency of `mt`.

The usual Homebrew pattern for a repository-level developer dependency is a checked-in `Brewfile`. Homebrew explicitly recommends this for project dependencies, supports casks, and provides `brew bundle check` for scripting. For this repository, the smallest declaration would be:

```ruby
cask_args require_sha: true
cask "nkzw-tech/tap/codiff", trusted: true
```

Run it explicitly during developer bootstrap, with upgrades suppressed:

```sh
brew bundle check --file=Brewfile --no-upgrade ||
  brew bundle install --file=Brewfile --no-upgrade
codiff --version
```

This is preferable when monke-tools may acquire more external developer tools because the dependency set stays declarative and inspectable. Homebrew calls a project `Brewfile` a nicer way to encode developer-environment dependencies, documents cask entries, and documents the `check || install` scripting pattern. It also documents that `--no-upgrade` avoids deliberate upgrades, although an install may still upgrade something when required. ([Homebrew Bundle](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Brew-Bundle-and-Brewfile.md), [brew manpage](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Manpage.md))

If adding a `Brewfile` for one optional tool feels too heavy, the current `mt install-dependencies` seam is a reasonable alternative. Keep the mutation in that explicit bootstrap path and do not install Codiff opportunistically from ordinary `mt` commands. The direct install should be:

```sh
brew install --cask --require-sha nkzw-tech/tap/codiff
```

Use the fully qualified cask name rather than separately tapping the repository and installing `codiff` by short name. Homebrew says a fully qualified installation trusts only that requested item, whereas whole-tap trust allows all current and future code in the tap to run with the user's privileges. `--require-sha` requires the cask to contain a checksum. ([Tap Trust](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Tap-Trust.md), [Taps](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Taps.md), [brew manpage](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Manpage.md))

## What Codiff actually ships

The intended Codiff is [`nkzw-tech/codiff`](https://github.com/nkzw-tech/codiff/tree/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2), a local Git diff viewer. Its official install command is `brew install --cask nkzw-tech/tap/codiff`. ([Codiff README](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/README.md))

The official tap's current cask:

- downloads a versioned zip from the project's GitHub Releases over HTTPS;
- records a SHA-256 checksum;
- installs `Codiff.app`;
- links the bundled helper as the `codiff` command through a `binary ... target: "codiff"` artifact;
- declares both `depends_on :macos` and `depends_on arch: :arm64`; and
- declares `auto_updates true`.

These are all in the vendor-owned [`Casks/codiff.rb`](https://github.com/nkzw-tech/homebrew-tap/blob/d3f7c5fe4382c4427c5272193a4ddd476feb71ec/Casks/codiff.rb). Homebrew documents that a `binary` artifact is linked into `$(brew --prefix)/bin`, so a cask installation should make the command available without the app's separate “Install Terminal Helper” action. ([Cask Cookbook](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Cask-Cookbook.md))

The platform declarations mean that blindly making this dependency mandatory would break monke-tools bootstrap on Linux, Windows, and Intel Macs even though the upstream project separately publishes Linux and Windows release artifacts. The Homebrew path should therefore be gated to Darwin/arm64; on every other platform, skip it when optional or return an actionable unsupported-platform error only when a Codiff-specific command is requested. ([Codiff cask](https://github.com/nkzw-tech/homebrew-tap/blob/d3f7c5fe4382c4427c5272193a4ddd476feb71ec/Casks/codiff.rb), [Codiff releases](https://github.com/nkzw-tech/codiff/releases/tag/v1.10.1))

## Why this is not a normal formula dependency

A Homebrew formula's string-valued `depends_on "..."` declares another **formula** dependency. Homebrew's separate cask DSL allows a cask to use `depends_on cask: "..."`. Therefore a future monke-tools formula should not try to express Codiff as `depends_on "codiff"`; Codiff is a cask, and the repository-level `Brewfile` or explicit bootstrap is the appropriate boundary. ([Formula Cookbook](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Formula-Cookbook.md), [Cask Cookbook](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Cask-Cookbook.md))

## Safe bootstrap contract

Whether implemented with `Brewfile` or the existing installer seam, use this contract:

1. Gate installation to macOS on arm64 before invoking Homebrew.
2. If an acceptable Codiff is already present, run `codiff --version` and validate its identity/version rather than trusting PATH presence alone. There is an unrelated Python package that also installs a command named `codiff`, so executable presence is ambiguous. ([Codiff CLI implementation](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/codiff-app), [unrelated PyPI package](https://pypi.org/project/codiff/))
3. If missing, resolve `brew` from PATH and fail with a clear installation command when Homebrew is unavailable. Do not install Homebrew itself.
4. Install only the fully qualified cask, with separate argument-array execution: `brew install --cask --require-sha nkzw-tech/tap/codiff`. Do not use `--force`, `--adopt`, `sudo`, or whole-tap trust.
5. Re-resolve `codiff` after Homebrew exits, then run `codiff --version`. The current official CLI prints `codiff v<semver>` and exits without launching the GUI. ([Codiff CLI](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/codiff-app))
6. Surface Homebrew and verification failures without continuing installation.
7. Test: already valid; missing plus successful brew install; no brew; brew failure; successful brew exit but missing command; wrong `codiff` identity; and unsupported platform.

Checking the exact cask's installed state with `brew list --cask` is useful if monke-tools intends to require Homebrew ownership. Checking the executable and version is friendlier if a manually installed official Codiff should also satisfy the dependency. Homebrew documents that `brew list --cask` treats its argument as a cask and lists installed cask artifacts. ([brew manpage](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Manpage.md))

## Versioning limitation

Homebrew is rolling-release software and `Brewfile` has no lock-file mechanism. `--no-upgrade` avoids routine upgrades but does not pin an install to an exact Codiff release; additionally, Codiff's cask declares that the app auto-updates. A minimum supported version check is therefore more realistic than exact-version reproducibility. If monke-tools eventually requires one exact Codiff build for correctness, a normal Homebrew/Brewfile dependency is the wrong mechanism; use a separately reviewed, checksummed, pinned distribution strategy instead. ([Homebrew Bundle versioning](https://github.com/Homebrew/brew/blob/d0319d20564497783dfa526f0ff86c6859a97eb4/docs/Brew-Bundle-and-Brewfile.md), [Codiff cask](https://github.com/nkzw-tech/homebrew-tap/blob/d3f7c5fe4382c4427c5272193a4ddd476feb71ec/Casks/codiff.rb))

## Comparison with the former Worktrunk installer

The former Worktrunk implementation introduced an explicit `mt install-dependencies` command, called it from `scripts/install-local.sh`, resolved `wt` before installation, resolved `brew` only when needed, ran `brew install worktrunk`, re-resolved `wt`, and failed when the expected executable still did not exist. It also tested missing Homebrew, brew failure, and a successful brew command that failed to produce `wt`. ([monke-tools commit `30e9753`](https://github.com/monke-together-strong/monke-tools/commit/30e97538b9ae51900317a0be448a432e3a551d8a))

That control flow is a good baseline for direct bootstrap. Codiff needs four additions that Worktrunk did not: cask installation, a fully qualified third-party item with narrow trust, macOS/arm64 gating, and identity/version verification because `codiff` is not a unique executable name. The current repository preserves `mt install-dependencies` as a compatibility no-op and still invokes it from local installation, so this seam can be revived without installing Codiff from every ordinary `mt` operation. ([Worktrunk removal commit](https://github.com/monke-together-strong/monke-tools/commit/8b4d720212acd0385d47f311f9308603b8124873))

## Decision summary

- **Default recommendation:** optional Darwin/arm64 developer dependency in a checked-in `Brewfile`, installed during explicit bootstrap.
- **Simplest one-tool alternative:** revive `mt install-dependencies` and use the safe bootstrap contract above.
- **Do not:** add it as a JavaScript dependency, declare it as a formula dependency, trust the entire vendor tap, install it from routine `mt` commands, or promise exact version pinning through Homebrew.
