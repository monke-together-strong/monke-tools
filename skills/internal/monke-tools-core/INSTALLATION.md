# Installation and updates


Check availability with `command -v mt` and identity with `mt --version`. For local development, run `vp install` then `vp run install:local` in the monke-tools source checkout using [Vite+](https://viteplus.dev/guide/). Refresh after CLI changes before testing in a consumer repo. Local skill edits are immediately visible through source links; adding or removing skill directories requires `mt skills configure` to refresh links.

For the latest stable release on macOS arm64 or Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

The installer prompts for Codex, Claude, Cursor, or one custom skill root, then saves the selection. Later installs reuse it. `mt skills configure` changes targets or retries skill/instruction reconciliation. Noninteractive release installs without saved or explicit targets activate the core and recommend that command.

For automation, add `--targets codex claude cursor` and/or `--custom-target /absolute/path/to/agent/skills` to the local installer command. For the release pipeline, replace the trailing `sh` with `sh -s --` followed by those options. Explicit selections replace saved preferences.

`mt update --check` checks availability without changing installation state; successful checks exit zero whether current or outdated. `mt update` activates the highest stable official release without prompting. Both prefer nonempty `GH_TOKEN` over `GITHUB_TOKEN`, otherwise using anonymous access. Updating a local install switches to a release while preserving the source checkout; run `vp run install:local` there to resume local development.

## Update recovery

Modified, added, or removed installed release skills/references block both update forms before network access. Preserve every listed edit first. To stay on releases, restore those paths from the bundle identified by `releaseTag` in the active `install-manifest.json`, then retry. To keep authoring, copy edits into the source checkout and activate a local install. Local refresh does not migrate release edits automatically.

Failures before activation leave the previous install selected: correct the reported cause and retry. Skill/instruction or dependency failures after activation leave the new core active: retry `mt skills configure` or `mt install-dependencies` as reported. Report unresolved reconciliation separately from core activation.

## Shell and dependencies

`mt shell install` configures the current Bash or Zsh startup file; follow its activation instructions. Unsupported shells receive manual PATH guidance. `mt shell init bash` or `mt shell init zsh` prints the adapter.

`mt install-dependencies` reconciles Codiff on Apple Silicon Macs against the active install's minimum version. Missing or outdated Homebrew-owned Codiff is installed/upgraded via the checksummed cask; outdated executables of unknown ownership are left untouched. Other platforms do not invoke Homebrew.
