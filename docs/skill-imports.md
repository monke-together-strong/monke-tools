# Maintain imported guidance

Use `mt skills add <source> --repo --skill <selectors...>` to publish upstream
skills with a repository. Monke records the source, full commit pin, selections,
and overrides in the root `monke.yml`, then restores generated guidance into
`skills/imported/` and `skills/references/imported/`. It adds missing ignore rules.
Add `--ref` to restore references, whose `SKILL.md` becomes `MAIN.md` without its
leading YAML frontmatter. Supporting files retain their bytes.
Re-adding a source keeps its existing selections and overrides. Add `--replace`
to make `--skill` replace the selection.
Repo recipes select a source's committed guidance without following that
source's import declarations.

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

For hand-written pinned imports from a branch such as `feature/topic`, use
`https://github.com/owner/repo/course#feature/topic` to select the `course` subpath.
Add and update resolve ambiguous GitHub tree URLs and record this unambiguous
form. Restore uses the accepted commit without resolving refs.

A selection without overrides is its slug. An object can specify `slug`, a
different upstream `selector`, `kind`, `modelInvocation`, and `description`.
Source defaults use `modelInvocation` too.
See the [configuration reference](../skills/internal/monke-config/references/monke-yml.md#imported-guidance).

If another section uses a YAML anchor, define that anchor outside `skills`.
Monke rejects recipe edits that would break aliases or change resolved values
outside `skills`.

Run `mt skills restore --repo` after changing selections or overrides, reverting
pins, or cloning a repo. Restore uses only accepted commits, replaces local edits,
and prunes guidance no longer declared. An entry without a commit fails and names
`mt skills update --repo` as the command that pins it. Matching generated files
and their local marker allow repeated restores without fetching.

If a repo command reports an obstructed restoration marker or conflicting ignore
rule, correct the reported path before retrying. Monke rejects these conditions
before changing existing pins or guidance.

Upstream symlinks must stay inside versioned source and outside Git metadata.
The recipe's pins and overrides are authoritative. Change the overrides or
update the pins to modify restored guidance.

## Review updates

Bare `mt skills update` updates the repositories connected to your global
installation, then refreshes installed skills. A local Monke install connects
its source checkout. Adding a local source connects its Git checkout through
the saved link. Monke advances each connected checkout's `monke.yml` imports
and generated guidance once, preserving that checkout's selections and overrides.
It includes those changes in the same comparison as the installed collection.
Successful publisher updates remain in place if refreshing an installed collection
fails. If saving the comparison fails, retrying retains the original publisher
YAML and guidance in the next comparison.
Commit each changed `monke.yml` after review.

`mt skills update --project` updates the project's linked source checkouts and
installed collection. It does not include the global Monke source checkout.
Release installs and Git imports use managed copies rather than connecting an
editable checkout. Saved installer commands replay their installer without
automatically editing the working directory's declarations. The command's
current directory alone does not connect a repository.

For a saved installer in an already-connected publisher, use
`mt skills restore --repo`. The outer update advances that publisher first.
A nested `mt skills update --repo` for the same publisher fails busy because
Monke reserves its declarations until the outer update finishes.

Run `mt skills update --repo` to pin missing commits and advance existing sources.
Successful sources replace their files and pins. Failed sources retain their
previous pins and restored files. If any source fails, Monke defers the final
removal of undeclared files until a successful restore or update. Monke reports
failures after opening one complete comparison, with a Codex summary of changed
skills.
Use `--interactive` to accept upstream slug changes and `--adapter codiff` or
`--adapter ms` to select the viewer.

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
installers. For a retained source at the bundled pin, installation also applies
monke-tools' Import kind changes. Installation adds newly declared skills and
references unless the registry narrowed that source's selection. At another pin,
installation keeps that pin and only converts retained skills that monke-tools
made references, so wrappers of the same name can install. Removing a
source records that choice so later installations leave it removed. Existing
machine registries migrate to compact recipes on first read.
