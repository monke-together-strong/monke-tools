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

Built-in `--targets` choices are `codex`, `claude`, `cursor`, and `antigravity`.
Add `--custom-target <path>` for a custom Agent skill root. Pass the same target
options with `vpr install:local` for local automation. Explicit options replace
the saved targets.

To set up or repair shell integration from Bash or Zsh, run `mt shell install`
and restart your shell. To install or verify Codiff (managed through Homebrew on
macOS arm64), run `mt install-dependencies`.

## Update and recovery

Run `mt update --check` to check for a release and `mt update` to activate it.
`mt update --check` exits 0 whether an update is available or not, so read its
output. Updating a local install activates a release. To resume development,
run `vpr install:local` in the preserved Source checkout.

Updates stop when installed release guidance differs from the bundle. To stay on
releases, preserve the reported edits and restore those paths using `releaseTag`
from `$(mt home)/current/install-manifest.json`. To keep editing, move the
changes into a monke-tools Source checkout and run `vpr install:local`.

After an activation failure, check `mt --version` before retrying. Shell, skill,
or dependency reconciliation can fail after the new version is already active.
Retry the reported `mt shell install`, `mt skills configure`, or
`mt install-dependencies` command.
