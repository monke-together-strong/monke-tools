# Maintain imported guidance

Publish upstream guidance with your repo by committing its import recipes in
`monke.yml`. The generated files stay gitignored.

```sh
mt skills add kepano/obsidian-skills --repo --skill obsidian-bases
```

Repo recipes select only guidance committed in each source. To install skills for
your own agents, use the global or project workflow in [Monke skills](../skills/internal/monke-skills/SKILL.md).

## Edit and restore a repo collection

Edit the `skills` section to change selections or overrides. For the fields,
see the [configuration reference](../skills/internal/monke-config/references/monke-yml.md#imported-guidance).
To declare a source before pinning it, omit `commit`.

```yaml
skills:
  - source: kepano/obsidian-skills
    skills: [obsidian-bases]
```

Run `mt skills update --repo` to pin the source. That command also advances other declared
sources.

To identify both a subpath and a branch containing `/`, put the branch in the
URL fragment. For example, `https://github.com/owner/repo/course#feature/topic`
selects `course` at `feature/topic`.

Define YAML anchors used by other sections outside `skills` so Monke can replace
the recipes without breaking their aliases.

Save any edits to generated files before restoring, because restore can replace
those edits and remove files the recipe no longer selects. Run
`mt skills restore --repo` after changing selections or overrides, reverting
pins, or cloning a repo.

## Review repo updates

Run `mt skills update --repo` to pin missing commits and advance existing
sources. Review the comparison before committing `monke.yml`. A pin can advance
with no change to selected files.

Successful source updates stay applied when a later source or the viewer fails.
Failed sources keep their previous pins and files. If any source fails, pruning
undeclared files waits for a successful restore or update. If the viewer fails,
use the printed `mt diff` command to reopen the saved comparison.

In the `monke-tools` repository, run `vpr skills:review <base> [head]` to
reconstruct a comparison between two committed versions. Reconstruction uses
current import tooling, so the result may differ from the original release. Run
`vpr skills:review clear` to remove saved comparisons. Clearing or cache
eviction invalidates saved reopen commands and viewer links.

## Review updates from linked checkouts

Global and project updates can advance `monke.yml` in their linked Git checkouts.
A global update can also advance the Installed source checkout of a Local tool install.
Review those repo changes in the same comparison as installed guidance, then
commit each changed `monke.yml` separately. Successful repo updates stay applied
if refreshing installed guidance fails. If Monke cannot save the comparison, a
retry compares against the original repo recipes and guidance.

In a saved installer command for an already-linked repo, use
`mt skills restore --repo` to restore its imports. The outer update advances that
repo first and holds the recipe update lock until the outer update finishes.

## Distribute the collection

Consumers can select the publishing repo's own skills and one level of its
declared imports. Consumer per-skill overrides take precedence over publisher
overrides. See the [repo import decision](adr/0015-declare-repo-skill-import-recipes.md)
for the ownership boundary.

For monke-tools itself, `vpr install:local` restores the repo's pins and a
Release bundle ships the restored guidance. Installation and global updates
follow the [registry rules for bundled imports](adr/0013-keep-personal-skill-imports-in-a-machine-local-registry.md)
while keeping a user's registry choices.
