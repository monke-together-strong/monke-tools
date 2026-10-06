# Imported Skill registry

Use Monke for global skills unless the user requests a specific harness. Private
content stays in its source or Monke home. Run `mt skills <command> --help` for
options; the registry follows the configured targets (`mt skills configure`).

## Acquire and edit

| Command | Ownership |
| --- | --- |
| `mt skills create <name> --description 'Use when…'` | Create in Monke home; replace the TODOs at the printed `SKILL.md` path. |
| `mt skills adopt <path> [--name <source>] [--skill <slugs...>]` | Consolidate an existing Skill or collection into Monke home. |
| `mt skills add <path> --link [--name <source>]` | Keep an external editable source, including supporting dependencies. |
| `mt skills add owner/repo [--skill <slugs...>]` | Import Git skills into registry-managed copies. |
| `mt skills add --name <source> --command 'installer' [--cwd <path>]` | Save and replay an installer; default working directory is `$MONKE_HOME/skill-sources/<source>`. |

Supporting files belong beside `SKILL.md`. Linked and command imports expose
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
one complete comparison. Successful sources apply even if another fails. Failed
installers restore the Skill source folder, but may affect files outside it. Back
up learned edits before installer updates; reopen a failed viewer with the printed
`mt diff` command. Git renames with recorded adopted links require explicit
reconciliation before update.

Removal unregisters the source and its managed links while preserving source
files. Collisions preserve user-owned targets. Reinstall and target reconfiguration
retain the registry. For public bundled imports, use `vpr skills:update` in Monke's
source checkout and commit its lock.
