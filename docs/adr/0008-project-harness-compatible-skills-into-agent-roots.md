# Project harness-compatible skills into agent roots

The whole-tree namespace symlink chosen in [ADR 0001](./0001-install-distributed-skills-into-agent-roots.md) exposed every Distributed skill to every namespaced target, so it could not represent guidance that depends on one Agent harness. Namespaced targets now receive a managed projection of compatible source folders: Codex receives shared `internal`, `imported`, and `references` folders plus the Codex-only `codex` folder, while Cursor and custom targets omit `codex`. Claude keeps its flat shared-skill layout, and references remain shared and non-discoverable.

Harness scope is expressed by source location rather than skill frontmatter or import-recipe metadata. The first supported scoped location is `skills/codex/<skill-slug>`, and Imported skills remain shared under `skills/imported`. Before changing any target, reconciliation requires Skill slugs and agent-facing skill names to be unique across the shared and Codex-only skills that Codex would receive.

Each selected target must resolve to a distinct Agent skill root. This prevents a custom target from sharing a root with Codex and overwriting or inheriting the Codex-specific projection according to reconciliation order; invalid interactive selections fail before the preference is saved.

Each namespaced projection is a managed directory of source-folder symlinks recorded by a versioned manifest. This preserves live source edits while allowing each target to expose a different folder set. Existing whole-tree namespace symlinks are treated as legacy managed installs and migrated automatically; real unowned namespaces, modified managed links, and unexpected namespace entries are preserved and cause that target to fail safely.

## Considered Options

- Per-skill harness metadata was rejected because folder membership is the simpler source of truth for the initial Codex-only use case.
- Keeping the whole-tree namespace symlink was rejected because Cursor and custom targets would also discover `skills/codex`.
- Generated projection trees under the Monke home were rejected because they add another persistent location without improving source liveness or ownership safety.
