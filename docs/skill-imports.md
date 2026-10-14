# Maintain imported guidance

Use `mt skills add <source> --repo --skill <selectors...>` to publish upstream
skills with a repository. Monke records the source, full commit pin, selections,
and overrides in the root `monke.yml`, then restores generated guidance into
`skills/imported/` and `skills/references/imported/`. It adds missing ignore rules.
Add `--ref` to restore references, whose `SKILL.md` becomes `MAIN.md` without its
leading YAML frontmatter. Supporting files retain their bytes.

See [Monke skills](../skills/internal/monke-skills/SKILL.md) for machine-local
imports and project projections. `--repo` publishes a collection through
committed recipes. `--project` installs a collection into one clone's agents.
Omit both flags to use the machine's global registry.

## Edit and restore a repo collection

You can edit the `skills` section directly. To declare a source before resolving
its commit, write:

```yaml
skills:
  - source: kepano/obsidian-skills
    skills: [obsidian-bases]
```

Run `mt skills update --repo` to pin it. This also advances other declared
sources.

A selection without overrides is its slug. An object can specify `slug`, a
different upstream `selector`, `kind`, `modelInvocation`, and `description`.
Source defaults use `modelInvocation` too.
See the [configuration reference](../skills/internal/monke-config/references/monke-yml.md#imported-guidance).

Run `mt skills restore --repo` after changing selections or overrides, reverting
pins, or cloning a repo. Restore uses only accepted commits, replaces local edits,
and prunes guidance no longer declared. An entry without a commit fails and names
`mt skills update --repo` as the command that pins it. Matching generated files
and their local marker allow repeated restores without fetching.

Upstream symlinks must stay inside versioned source and outside Git metadata.
The recipe's pins and overrides are authoritative. Change the overrides or
update the pins to modify restored guidance.

## Review updates

Run `mt skills update --repo` to pin missing commits and advance existing sources.
Git preparation runs concurrently. Successful sources replace their files and
pins. Failed sources retain their previous pins. Monke reports failures after
opening one complete comparison, with a Codex summary of changed skills.
Use `--interactive` to accept upstream slug changes and `--adapter codiff` or
`--adapter lfv` to select the viewer.

The printed `mt diff` command reopens the fixed comparison if viewer launch fails.
Commit `monke.yml` after review. A pin can advance without changing the selected
files, so a comparison containing only source changes is valid.

`vpr skills:review <base> [head]` reconstructs guidance from two committed
versions. The default head is `HEAD`. Reconstruction from repo declarations or
older `skills.lock.json` files uses current import tooling, so the result may
differ from historical shipped bytes. Pre-lock revisions use their committed
imported tree. The latest three comparisons remain in Monke home. Run
`vpr skills:review clear` to remove them. Clearing or eviction invalidates their
viewer links without changing generated guidance or pins.

## Distribute the collection

Importing or linking a publishing repo includes its declared imports. The
consumer's selection spans the repo's own skills and declared imports. Publisher
overrides apply first, and consumer per-skill overrides take precedence. Monke
resolves one level of declarations and rejects conflicting owners before
publication. Linked checkouts restore their declared imports on add and update.

monke-tools declares its own imports in `monke.yml` too. `vpr install:local`
restores those pins before installation. Release bundles carry that declaration
and the complete generated tree. Release installation does not fetch upstream
skill repositories.

Global registries start with monke-tools' imports and retain their own selections
and policies. Installation adds newly bundled sources without replaying personal
installers. Removing a source records that choice so later installations leave it
removed. Existing machine registries migrate to compact recipes on first read.
