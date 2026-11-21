# Project harness-compatible skills into agent roots

The whole-tree namespace symlink chosen in [ADR 0001](./0001-install-distributed-skills-into-agent-roots.md) exposed every Distributed skill to every namespaced target, so it could not represent guidance that depends on one Agent harness. Namespaced targets now receive a managed projection of compatible source folders. Codex receives shared `internal`, `imported`, and `references` folders plus the Codex-only `codex` folder, while Cursor and custom targets omit `codex`. Claude keeps its flat shared-skill layout, and references remain shared and non-discoverable.

Harness scope is expressed by source location rather than skill frontmatter or import-recipe metadata. The first supported scoped location is `skills/codex/<skill-slug>`, and Imported skills remain shared under `skills/imported`.

Each namespaced projection is a directory of source-folder symlinks. Reconciliation replaces those symlinks with links to the current Skill source tree, refuses to overwrite non-symlinks at their names, and leaves unrelated namespace entries alone. An existing whole-tree namespace symlink is replaced by the projected directory.

## Considered options

- Per-skill harness metadata adds metadata maintenance when folder membership is the simpler source of truth for the initial Codex-only use case.
- Keeping the whole-tree namespace symlink exposes `skills/codex` to Cursor and custom targets.
- Generated projection trees under the Monke home add another persistent location without improving source liveness or ownership safety.
