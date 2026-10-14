---
name: monke-skills
description: Manage global, project, and repo skills with mt. Use when creating, adopting, importing, updating, or removing skills, configuring agent targets or invocation policies, or repairing skill links.
---

# Monke skills

Use Monke for global, project, or repo skills unless the user requests a specific
harness.
Private content stays in its source or local registry. Run
`mt skills <command> --help` for options. Select global targets with
`mt skills configure`.

Import commands default to the global registry. Use `--project` for clone-local
agent installs or `--repo` for published imports.

## Acquire and edit

| Command | Ownership |
| --- | --- |
| `mt skills create <name> --description 'Use when…'` | Create in Monke home; replace the TODOs at the printed `SKILL.md` path. |
| `mt skills adopt <path> [--name <source>] [--skill <slugs...>]` | Consolidate an existing Skill or collection into Monke home. |
| `mt skills add <path> --link [--name <source>]` | Keep an external editable source, including supporting dependencies. |
| `mt skills add owner/repo [--skill <slugs...>]` | Import Git skills into registry-managed copies. |
| `mt skills add --name <source> --command 'installer' [--cwd <path>]` | Save and replay an installer; default working directory is `$MONKE_HOME/skill-sources/<source>`. |

Keep supporting files inside the skill folder. Linked and command imports expose
authored skills through agent links. Publisher-declared imports remain
consumer-owned copies. Add `--link` to register existing
installer output without running it now; reference credentials through environment
variables. `--skill` restricts a collection; command/linked sources without a
selection discover new skills on update.

Adoption compares same-slug copies across known harness roots. Identical copies
reuse one owner and its policies, including links in unconfigured harnesses.
Differences in bytes, metadata, permissions, or structure stop the whole batch;
reconcile the reported paths and rerun. Individual aliases preserve their external
source. Relocation checks cover Markdown links and symlinks, not dynamic script
dependencies or plain-text references; use linked import when dependencies must
stay external. Publication failures restore the batch or report retained recovery
copies when restoration is obstructed.

## Publish repo imports

Run `mt skills add <git-source> --repo --skill <selectors...>` to declare imports
in the current repo's `monke.yml`. Add `--ref` for non-invocable references.
`list`, `remove`, `policy`, and `update` accept `--repo` too. After a fresh clone
or hand edits, run `mt skills restore --repo` to restore pinned imports.
Run `mt skills update --repo` to pin missing commits, advance existing sources,
and open one complete content review. Commit `monke.yml` after review. Restored
files stay gitignored. monke-tools manages its own imports through this scope.

Repo imports publish guidance alongside a repo's own skills. Global or project
consumers receive that collection, with their selection and per-skill overrides.
For the recipe fields and restoration rules, read the
[configuration reference](../monke-config/references/monke-yml.md#imported-guidance).

## Project installs

Run `mt skills add <local-checkout> --project` inside the consumer repo. Local
sources keep authored skills linked by default, including supporting files.
Source edits and Git updates appear through those links. Publisher-declared
imports refresh consumer copies on update. Use `--skill <slugs...>` to select skills.
For a checkout, project imports prefer `skills/` over `.agents/skills`. Pass the
exact skill directory to select another source folder.
Git imports and saved installer commands also accept `--project`.

The project's registry starts empty and stays in the clone's shared Git metadata.
The first project install saves your global selection of built-in agent targets,
or defaults to Codex, Claude, and Cursor if you have no saved selection. Custom
targets are excluded. If your global selection contains only a custom target,
select a built-in target with `mt skills configure` before the first project install.
Later global target changes leave the project's saved selection unchanged.
Codex project skills use `.agents/skills`. Claude uses `.claude/skills`, and Cursor
uses `.cursor/skills`. Project installs preserve existing skills and agent instructions.

Use `--project` with `list`, `update`, `remove`, or `policy` to select this registry.
`update` discovers added or removed folders in unfiltered linked sources and opens
the existing comparison. It also advances linked publishers' declared imports.
Monke leaves Git checkout updates to the linked checkout's owner.
Invocation policies on authored linked skills edit their source metadata and
affect all consumers of that source.

Generated links are excluded through Git's local `info/exclude`. Spawn,
materialize, and setup recreate links in each checkout. After changing a skill
selection or removing a source, run `mt setup` in other existing worktrees to
reconcile their links. Removal preserves the source folders.

If project publication fails, Monke restores its registry, agent links, and Git
exclusions, or reports retained recovery copies if restoration fails. Linked
source content stays live. This recovery does not undo changes in external sources
or installer changes outside the registry and project agent directories.

## Policies and lifecycle

```sh
mt skills policy <source> [skill] --model-invocation <allow|deny>
mt skills policy <source> <skill> --description 'Use when…'
mt skills update [--adapter <codiff|lfv>] [--interactive]
mt skills list
mt skills remove <source>
```

To set a source invocation default for future skills, omit `[skill]`.
Per-skill overrides win. Policies survive updates and preserve explicit human invocation.
Description overrides apply to one skill and survive updates. Combine
`--description` with `--model-invocation` to change both. Linked and command
imports write overrides for authored skills to their source metadata. Overrides
for publisher-declared imports remain in consumer copies.

Update advances Git refs, replays installers, and rereads linked files, then opens
one complete comparison. It first updates `monke.yml` imports in connected local
checkouts: the local Monke installation's source checkout and linked repositories.
Each checkout keeps its selections and overrides. Review and commit the changed
YAML files. See [connected update scope](../../../docs/skill-imports.md#review-updates)
for project, release, and installer behavior.
Up to four Git sources prepare concurrently. Linked
sources, installer commands, and publication run in recipe order.

When skill or reference content changes, Monke invokes the installed Codex CLI
with your configured model in a read-only session. Codex summarizes each changed
skill or reference in the terminal and in `SKILL_UPDATE_SUMMARY.md` in the saved
comparison. If Codex is unavailable or fails, Monke prints a warning and keeps the
update and comparison.

Updates retain successful sources even if another fails.
Connected publisher updates remain accepted if consumer publication fails.
Failed installers restore the Skill source folder, but may affect files outside it.
Back up learned edits before installer updates. Reopen a failed viewer with the
printed `mt diff` command. Git renames with recorded adopted links require explicit
reconciliation before update.

Global or project removal unregisters the source and its managed links while
preserving source files. Collisions preserve user-owned targets. Reinstall and
target reconfiguration retain the registry.
