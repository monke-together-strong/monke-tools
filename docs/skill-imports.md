# Maintaining imported guidance

For machine-local imports, including private linked collections and installer
commands, use `mt skills add` and `mt skills update`. See
[Monke skills](../skills/internal/monke-skills/SKILL.md).
The commands below maintain the public repository's bundled collection.

The [agent guidance glossary](reference/agent-guidance.md) defines the shared
import model. [ADR 0013](adr/0013-keep-personal-skill-imports-in-a-machine-local-registry.md)
records the boundary between the bundled collection and the machine-local registry.

Installation and `mt skills configure` add bundled sources that are not yet
registered. Existing registry sources keep their selections, content, and policies;
personal installer commands run only through `mt skills add` or `mt skills update`.
`mt skills remove` records the source in the registry lock's `removedSources` so
later installations leave it removed. An explicit `mt skills add` clears that removal.

`skills.lock.json` records exact upstream commits, importer versions, selections,
local roles and invocation policies. Imported directories are generated and ignored.
Refresh them through the source-maintenance commands; local edits are replaced by
restoration.

Upstream links may reference shared files within the same Git checkout. Links to
host files or generated Git metadata are rejected before importing.

Run `vpr skills:update` to advance the recorded discovery refs. Successful sources
replace their files and pins immediately. Failed sources retain their preceding
versions; the command reports failure after opening one complete comparison of
the collection. Use `--interactive` when an upstream slug rename needs acceptance.
Use `--adapter codiff` or `--adapter lfv` to override the configured Diff adapter.

The printed `mt diff` command reopens the fixed comparison. A viewer-launch failure
leaves updates applied and prints that command. Committing the lock records the
selected versions. GitHub content diffs contain the lock; the complete guidance
comparison stays local.

Update reviews include the lock as well as the guidance content. A source can
advance to a newer Git commit while its selected skills have the same content
digest; a comparison containing only those source revision changes is expected.

`vpr install:local` restores and validates the selected lock automatically before
installing source-backed guidance. Run it again after reverting the lock or
switching versions in the installed source checkout. `vpr skills:restore` performs
restoration alone: it fetches accepted pins only and preserves the lock. Valid
generated files are reused without fetching. Fresh restoration needs the pinned
importer and source content to remain available.

`vpr skills:review <base> [head]` reconstructs complete guidance from two committed
source versions; head defaults to `HEAD`. It also supports the initial pre-lock
version through its committed imported tree. Recorded materializer formats are
versioned; an unsupported format fails instead of substituting newer transformations.

One repository under the Monke home retains the latest three distinct comparisons.
Identical requests reuse their snapshots. Older commits and their Git storage are
reclaimed automatically. `vpr skills:review clear` removes all saved comparisons
while preserving generated guidance and the lock. Eviction or clearing invalidates
the affected windows and LFV links; reconstruct a historical comparison to open
a new review.

The initial migration upgrades the selected guidance and retires
`resolving-merge-conflicts` after its upstream removal.

Published releases include the recipe lock and complete generated guidance. Release installation and
`mt update` consume those bundles without fetching upstream skill repositories.
