# Keep personal skill imports in a machine-local registry

Personal and private guidance, including course-provided skills, must be usable
without adding its content or import recipes to the public monke-tools
repository. `mt skills add` registers these imports in a machine-local Skill
registry using the existing recipe format and distribution mechanism. This
replaces the source-only import boundary in [ADR 0002](./0002-import-skills-through-skills-cli-wrapper.md)
without creating a separate category of external-repository skills.

The repository's `skills.lock.json` retains the Bundled import recipes. The
runtime registry lives at `$MONKE_HOME/skill-registry/skills.lock.json`, starts
with the bundled imports, and then owns its recipes and invocation overrides
independently. `mt skills update` refreshes every registered source. `mt update`
updates the tool and its bundled guidance without replaying personal installers.

Getting skills and distributing them are separate choices. A source may come
through Git, an existing local link, or a saved installer command; a command-only
import does not require a repository checkout. Commands retain their working
directory and Skill source folder, with a managed working directory under
`$MONKE_HOME/skill-sources/<name>` when none is supplied. Credentials come from
the command's environment. An installer may write several agent-specific folders,
but Monke selects one collection and exposes it through the existing Skill
projections selected by the user's Skill install preference.

Linked and command-installed skills retain source links so edits through an
installed skill reach the original collection. Git imports remain managed
snapshots. Model invocation overrides belong to the recipe: a source-wide default
applies to future skills, and a per-skill override takes precedence. Refreshes
reapply those choices to Claude and Codex metadata. Instruction edits follow the
source's overwrite behavior; they do not receive the persistence guarantee of
invocation overrides.

One Skill update review compares the imported collection, supporting files, and
lock before and after the update. Source provenance remains part of that review:
a newer Git commit with an unchanged Guidance digest is a valid lock-only
comparison. Command imports compare the current editable content before running
the installer; plain linked imports compare against the last accepted snapshot.
An installer recipe is replayable, but it does not provide the immutable source
pin used for reproducible Git imports.

## Considered options

- Extending only the public recipe store would require private recipes and
  guidance to enter the team's repository or release lifecycle.
- Letting each upstream installer own global distribution would bypass Monke's
  target preferences, invocation overrides, and unified update review.
- Copying linked source content into independent global stores would break the
  editing relationship between an installed skill and its original collection.
