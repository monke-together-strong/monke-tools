---
name: monke-skills
description: Manage global and project skills with mt. Use when creating, adopting, importing, updating, or removing skills, configuring agent targets or invocation policies, or repairing skill links.
---

# Monke skills

Use Monke for global or project skills unless the user requests a specific harness.
Private content stays in its source or local registry. Run
`mt skills <command> --help` for options. Select global targets with
`mt skills configure`.

## Acquire and edit

| Command | Ownership |
| --- | --- |
| `mt skills create <name> --description 'Use when…'` | Create in Monke home; replace the TODOs at the printed `SKILL.md` path. |
| `mt skills adopt <path> [--name <source>] [--skill <slugs...>]` | Consolidate an existing Skill or collection into Monke home. |
| `mt skills add <path> --link [--name <source>]` | Keep an external editable source, including supporting dependencies. |
| `mt skills add owner/repo [--skill <slugs...>]` | Import Git skills into registry-managed copies. |
| `mt skills add --name <source> --command 'installer' [--cwd <path>]` | Save and replay an installer; default working directory is `$MONKE_HOME/skill-sources/<source>`. |

Keep supporting files inside the skill folder. Linked and command imports expose
their editable source through agent links. Add `--link` to register existing
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

## Project installs

Run `mt skills add <local-checkout> --project` inside the consumer repo. Local
sources stay linked by default, including supporting files. Source edits and Git
updates appear through existing links. Use `--skill <slugs...>` to select skills.
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
the existing comparison. Monke leaves Git updates to the linked checkout's owner.
Invocation policies on linked skills edit their source metadata and affect all
consumers of that source.

Generated links are excluded through Git's local `info/exclude`. Spawn,
materialize, and setup recreate links in each checkout. After changing a skill
selection or removing a source, run `mt setup` in other existing worktrees to
reconcile their links. Removal preserves the source folders.

If a project command fails, Monke restores its registry, agent links, and Git
exclusions, or reports retained recovery copies if restoration fails. Linked
source content stays live. This recovery does not undo changes in external sources
or installer changes outside the registry and project agent directories.

## Policies and lifecycle

```sh
mt skills policy <source> [skill] --model-invocation <allow|deny>
mt skills update [--adapter <codiff|lfv>] [--interactive]
mt skills list
mt skills remove <source>
```

Omit `[skill]` for a source default covering future skills; per-skill overrides win.
Policies survive updates and preserve explicit human invocation.

Update advances Git refs, replays installers, and rereads linked files, then opens
one complete comparison. Global updates retain successful sources even if another
fails. A failed project update restores the whole project's registry and links.
Failed installers restore the Skill source folder, but may affect files outside it.
Back up learned edits before installer updates. Reopen a failed viewer with the
printed `mt diff` command. Git renames with recorded adopted links require explicit
reconciliation before update.

Removal unregisters the source and its managed links while preserving source
files. Collisions preserve user-owned targets. Reinstall and target reconfiguration
retain the registry. For public bundled imports, use `vpr skills:update` in Monke's
source checkout and commit its lock.
