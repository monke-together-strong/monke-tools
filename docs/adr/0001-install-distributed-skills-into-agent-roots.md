# Install distributed skills into agent roots

> The whole-tree namespace representation in this ADR is superseded by [ADR 0008](./0008-project-harness-compatible-skills-into-agent-roots.md). Target selection, root resolution, and the Claude flat layout remain in effect.

monke-tools remains a Bun CLI whose local executable is rebuilt by `bun run install:local`, and the same local install also makes shared team skills available by symlinking the monke-tools `skills/` source tree into selected agent skill roots. The selected targets are stored in global monke config so each later install can refresh the same Codex, Claude, Cursor, or custom skill roots without requiring per-repo loading instructions.

## Decision

Distributed skills are installed directly into explicit Agent skill roots selected by the teammate. Codex, Cursor, and custom targets receive one namespace path inside each selected root:

```text
<agent-skill-root>/monke-tools -> <installed-source-checkout>/skills
```

The namespace is a symlink to the whole Skill source tree. monke-tools may relink an existing symlink at that exact namespace path, but it must not overwrite a real file or directory there.

Claude receives flat root-level symlinks instead because Claude does not discover nested skill directories:

```text
<claude-skill-root>/monke-tools-core -> <installed-source-checkout>/skills/internal/monke-tools-core
<claude-skill-root>/<imported-skill> -> <installed-source-checkout>/skills/imported/<imported-skill>
<claude-home>/references -> <installed-source-checkout>/skills/references
```

The Claude layout is tracked with a managed manifest in the Claude skill root so later installs can validate, refresh, or remove only links that monke-tools created, including the supporting reference link when Claude is deselected. The manifest records that supporting link even though it remains outside the Agent skill root, so references resolve from flat linked skills without becoming independently discoverable.

Global monke config is versioned YAML at `config.yml` under monke home. It stores the current Skill install preference, while the active Local Install manifest stores the Installed source checkout:

```yaml
version: 1
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

The source layout remains grouped by ownership:

```text
skills/
  internal/
    monke-tools-core/
      SKILL.md
  imported/
  references/
    internal/
    imported/
```

Internal skills are owned by monke-tools. Imported skills come from other projects and preserve their upstream Agent skill names by default. Internal and Imported references are packaged for explicit composition by Reference-backed skills and are not standalone workflows.

## Consequences

Local install always includes skill installation. It atomically activates a versioned Local tool install whose manifest records the Installed source checkout, then replaces the preference and reconciles when built-in targets are supplied explicitly, prompts through Skills Configure when no preference exists, or reconciles the existing preference. Source-backed links preserve Skill authoring mode.

Deselecting a namespace target removes only a managed `monke-tools` symlink namespace. Deselecting Claude removes only flat links recorded in the managed manifest. A failure in one selected target does not prevent other selected targets from being reconciled, but the operation fails overall so partial installation is visible.
