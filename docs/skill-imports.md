# Maintaining imported guidance

`skills.lock.json` records exact upstream commits, importer versions, selections,
local roles and invocation policies. Imported directories are generated and ignored.
Refresh them through the source-maintenance commands; local edits are replaced by
restoration.

Run `vpr skills:update` to advance the recorded discovery refs. Successful sources
replace their files and pins immediately. Failed sources retain their preceding
versions; the command reports failure after opening one complete comparison of
the collection. Use `--interactive` when an upstream slug rename needs acceptance.
Use `--adapter codiff` or `--adapter lfv` to override the configured Diff adapter.

The printed `mt diff` command reopens the fixed comparison. A viewer-launch failure
leaves updates applied and prints that command. Committing the lock records the
selected versions. GitHub content diffs contain the lock; the complete guidance
comparison stays local.

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

The migration retains `resolving-merge-conflicts` in a separate recipe frozen at
the latest revision before its upstream removal. The remaining Matt Pocock skills
continue following their normal discovery ref. Retiring the preserved skill is
a separate source-maintenance decision.

Published releases include complete generated guidance. Release installation and
`mt update` consume those bundles without fetching upstream skill repositories.
