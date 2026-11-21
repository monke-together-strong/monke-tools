# Install distributed skills into agent roots

> The whole-tree namespace representation in this ADR is superseded by [ADR 0008](./0008-project-harness-compatible-skills-into-agent-roots.md). Target selection, root resolution, and the Claude flat layout remain in effect.

Local installation also installs shared team skills. Save the user's target
selection in **Global monke config** so later installs can refresh the same agent
skill roots without requiring per-repo loading instructions.

## Decision

Distributed skills are installed directly into explicit Agent skill roots selected by the user. Codex, Cursor, and custom targets receive one namespace path inside each selected root:

```text
<agent-skill-root>/monke-tools -> <installed-source-checkout>/skills
```

The namespace is a symlink to the whole Skill source tree. monke-tools may relink an existing symlink at that exact namespace path, but it must not overwrite a real file or directory there.

Claude receives flat root-level symlinks instead because Claude does not discover nested skill directories:

```text
<claude-skill-root>/<internal-skill> -> <installed-source-checkout>/skills/internal/<internal-skill>
<claude-skill-root>/<imported-skill> -> <installed-source-checkout>/skills/imported/<imported-skill>
<claude-home>/references -> <installed-source-checkout>/skills/references
```

The Claude layout is tracked with a managed manifest in the Claude skill root so later installs can validate, refresh, or remove only links that monke-tools created, including the supporting reference link when Claude is deselected. The manifest records that supporting link even though it remains outside the Agent skill root, so references resolve from flat linked skills without becoming independently discoverable.

Keep the **Skill install preference** in global config and the **Installed source
checkout** in the active install manifest. Resolve built-in target roots at
install time. For a custom target, store the absolute path of the root that
contains the `monke-tools` namespace.

## Skill source layout

Internal skills are owned by monke-tools. Imported skills come from other projects and preserve their upstream Agent skill names by default. Internal and Imported references are packaged for explicit composition by Reference-backed skills and are not standalone workflows.

## Consequences

Local install always includes skill installation. It atomically activates a versioned Local tool install whose manifest records the Installed source checkout. When built-in targets are supplied explicitly, it replaces the preference and reconciles. Otherwise it prompts through `mt skills configure` when no preference exists, or reconciles the existing preference. Source-backed links preserve Skill authoring mode.

Deselecting a namespace target removes only a managed `monke-tools` symlink namespace. Deselecting Claude removes only flat links recorded in the managed manifest. A failure in one selected target does not prevent other selected targets from being reconciled, but the operation fails overall so partial installation is visible.
