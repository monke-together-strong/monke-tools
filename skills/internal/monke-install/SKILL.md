---
name: monke-install
description: Install, update, and troubleshoot Monke, shell integration, and runtime dependencies.
disable-model-invocation: true
---

# Monke installation

Check which binary is active with `command -v mt` and `mt --version`.

For local development, run `vp install` and `vpr install:local` in the monke-tools
Source checkout. Refresh after CLI changes before testing in a Consumer repo.
Local skill edits appear through source links. After adding or removing skill
directories, run `mt skills configure` to refresh links. After changing an
import pin in `monke.yml`, rerun `vpr install:local` to restore its guidance.

For a stable release on macOS arm64 or Linux x64, run:

```sh
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

Use `mt skills configure` to change distribution targets after installation.
For a noninteractive release install with explicit targets, run:

```sh
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh |
	sh -s -- --targets codex claude
```

Pass the same target options with `vpr install:local` for local automation.
Explicit options replace the saved targets. Run `mt shell install` from Bash
or Zsh and follow its activation instructions.

## Update and recovery

Run `mt update --check` to check for a release and `mt update` to activate it.
Read the check output to distinguish an available update from an up-to-date
install. Updating a local install activates a release. To resume development,
run `vpr install:local` in the preserved Source checkout.

If installed guidance differs from the release, preserve those edits before
updating. Restore the changed paths from the bundle named by `releaseTag` in the
active `install-manifest.json` to stay on releases. To keep editing, carry the
changes into the Source checkout and activate a local install.

After an activation failure, check `mt --version` before retrying. Skill or
dependency reconciliation can fail after the new version is already active.
Retry the reported `mt skills configure` or `mt install-dependencies` command.
