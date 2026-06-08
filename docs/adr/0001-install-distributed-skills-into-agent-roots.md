# Install distributed skills into agent roots

monke-tools remains a Bun CLI whose local executable is rebuilt by `bun run install:local`, and the same local install also makes shared team skills available by symlinking the monke-tools `skills/` source tree into selected agent skill roots. The selected targets are stored in global monke config so each later install can refresh the same Codex, Claude, Cursor, or custom skill roots without requiring per-repo loading instructions.

## Decision

Distributed skills are installed directly into explicit Agent skill roots selected by the teammate. monke-tools owns one namespace path inside each selected root:

```text
<agent-skill-root>/monke-tools -> <installed-source-checkout>/skills
```

The namespace is a symlink to the whole Skill source tree. monke-tools may relink an existing symlink at that exact namespace path, but it must not overwrite a real file or directory there.

Global monke config is versioned YAML at `config.yml` under monke home. It stores the Installed source checkout and one current Skill install preference:

```yaml
version: 1
installedSourceCheckout: /path/to/monke-tools
skillInstallPreference:
  targets:
    - kind: codex
    - kind: claude
    - kind: custom
      path: /path/to/agent/skills
```

Built-in targets store only their kind. Their Agent skill roots resolve at install time against the OS home directory:

- Codex: `~/.codex/skills`
- Claude: `~/.claude/skills`
- Cursor: `~/.cursor/skills`

Custom targets store one absolute Agent skill root path. The custom path is the root containing the `monke-tools` namespace, not the namespace path itself.

## Skill Source Layout

The installed namespace mirrors the source layout:

```text
skills/
  internal/
    monke-tools-core/
      SKILL.md
  imported/
```

Internal skills are owned by monke-tools. Imported skills come from other projects and preserve their upstream Agent skill names by default.

## Consequences

Local install always includes skill installation. It installs the `mt` binary first, records the Installed source checkout, then either prompts with `mt skills configure` when no preference exists or reconciles the existing preference.

Deselecting a target removes only a managed `monke-tools` symlink namespace. A failure in one selected target does not prevent other selected targets from being reconciled, but the operation fails overall so partial installation is visible.
