# Distribute monke-tools as atomic release bundles

Publish qualifying pushes to `main` as immutable, automatically patch-versioned **Mainline releases** under the `monke-tools-v*` tag namespace. Each supported platform archive contains one version-aligned **Release bundle**: the compiled `mt` executable, Distributed skills and references, Global agent instructions, and an Install manifest. The first platform targets are macOS arm64 and Linux x64.

The publication workflow records the newest stable monke-tools release in a small catalog asset after publishing and verifying the immutable Release. The public Release bootstrap reads that catalog, verifies the selected artifact, stages it under the Monke home, and delegates to bundle-owned installation code. `mt update` discovers the same Release through GitHub's releases API. Both paths use an atomic `current` pointer for Install activation. A stable `~/.local/bin/mt` symlink exposes the Active tool install. Local tool installs use the same versioned activation boundary while retaining source-backed Skill authoring mode; explicit `mt update` switches Local to Release mode, and Local install refresh switches it back. A Customized release install blocks Release update and reports its changed guidance paths rather than discarding, migrating, or backing them up.

V1 exposes only `mt update` and `mt update --check`. It retains one predecessor, serializes installation mutations without locking ordinary commands, and omits exact-version selection, force repair, channels, passive checks, mirrors, rollback, and a Homebrew installation method for `mt`. Codiff remains an external minimum-compatible runtime dependency managed through Homebrew on macOS rather than a pinned Release bundle component. The detailed command, installer, release, failure, and provenance contract is recorded in [issue #130](https://github.com/monke-together-strong/monke-tools/issues/130).

Mainline release validation relies on full tests at the pull-request boundary. The `main` workflow runs `vp check`, builds both platform bundles, executes artifact smoke checks, and validates archives, manifests, and checksums before publishing; it does not repeat the full unit-test suite. This keeps routine publication fast while accepting that direct pushes to `main` receive static and artifact validation only.

## Considered Options

- Publishing `mt` through Homebrew was deferred because a verified standalone installer and updater provide the required public distribution path without adding tap ownership yet.
- Updating only the executable was rejected because agent guidance and the executable form one compatibility unit.
- Automatically migrating or backing up locally modified Release guidance was rejected for v1; refusing the update is simpler and never silently changes user-authored guidance.
- Requiring a Release PR was rejected because ordinary qualifying pushes to `main` should make current monke-tools changes available without a separate release ceremony.
