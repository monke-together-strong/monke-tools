# Declare repo skill import recipes

Repos publish imported guidance through a `skills` section in their root `monke.yml`.
The same compact recipe serves repo, global, and project scopes. Git recipes
record their source, full commit, selections, and optional overrides. Source
parsing derives repository URLs, subpaths, and update refs. Monke restores pinned
content with its current import tooling. Content digests and tooling identities
belong only to gitignored restore markers.

`mt skills` supports add, restore, update, list, remove, and policy in repo scope.
Only the `skills` YAML node changes when Monke writes a recipe. `apps` is optional,
so repos can declare imports without Session configuration. Restored guidance
stays ignored. Hand edits have the same effect as commands after restore.

This supersedes [ADR 0002](0002-import-skills-through-skills-cli-wrapper.md)'s
rejection of runtime import commands and its grouped selection requirement.
The upstream skills CLI remains responsible for staging selected skills and
reporting security assessments. Reference conversion keeps its existing rules.

This amends [ADR 0012](0012-reconstruct-historical-skill-reviews-from-locks.md).
Historical review reads older locks and newer repo declarations, then rebuilds
both sides with current tooling. It compares accepted pins consistently without
promising the exact transformation a historical Monke release shipped.

This amends [ADR 0013](0013-keep-personal-skill-imports-in-a-machine-local-registry.md).
monke-tools' own Repo import recipes replace Bundled import recipes. Releases
carry those recipes and restored guidance. Installation seeds machine registries
as before, while personal link and command sources remain machine-local. Old
registries migrate on first read without losing selections or overrides.

A publishing source owns its declared imports within the consumer's recipe.
Consumers pin only the publisher revision. That revision includes the publisher's
accepted import pins and overrides. Consumer per-skill overrides take precedence.
Monke resolves one level of declarations. Recursive resolution would add an
unbounded dependency graph that the publishing use case does not require.

## Considered options

- Keeping repo declarations in clone-local project registries would hide them
  from consumers and prevent committing accepted pins.
- Copying guidance into Git would duplicate upstream content and inflate reviews.
- Recording parser outputs, importer versions, and content digests in recipes
  would preserve derived metadata instead of the maintainer's accepted choices.
