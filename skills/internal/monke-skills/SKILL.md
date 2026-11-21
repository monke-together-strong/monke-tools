---
name: monke-skills
description: Manage global, project, and repo skills with mt. Use when creating, adopting, importing, updating, or removing skills, configuring agent targets or invocation policies, or repairing skill links.
---

# Monke skills

Use Monke unless the user requests a specific harness. Run
`mt skills <command> --help` for options. Use `mt skills configure` to change
global agent targets.

## Acquire and edit

| Need | Example |
| --- | --- |
| Author a skill owned by Monke home | `mt skills create search --description 'Use when searching the catalog.'` |
| Move existing copies into Monke home | `mt skills adopt ./search` |
| Keep a source editable in place | `mt skills add ./skills --link` |
| Import committed guidance | `mt skills add owner/repo --skill search` |
| Replay an installer on update | `mt skills add --name search --command 'installer'` |

Keep supporting files inside the skill folder when adopting. Identical
same-slug copies can share one owner. If relocation would break plain-text
paths or script dependencies, link the source instead. In installer commands,
refer to credentials through environment variables. Back up learned edits
before replaying an installer, since it can change files outside the registry.

## Publish repo imports

To distribute guidance with the repo, run
`mt skills add owner/repo --repo --skill search`. Use `mt skills restore --repo`
after cloning or changing the recipe. Review and commit `monke.yml` after
`mt skills update --repo` pins or advances its imports. For recipe fields and
restoration rules, use the
[configuration reference](../monke-config/references/monke-yml.md#imported-guidance).

## Project installs

To project guidance into one clone, run `mt skills add ../toolkit --project`
from the Consumer repo. Local authored skills stay linked. Publisher-declared
imports keep their own copies. A local checkout prefers `skills/` over
`.agents/skills`. Pass the exact skill directory to use another location.

The first project install saves the global selection of Codex, Claude, and
Cursor targets or uses those defaults if no selection exists. Project installs
skip Antigravity because its project skill root, `.agents/skills`, is the Codex
one. If you have only a custom or Antigravity target, select Codex, Claude, or
Cursor first. Later global changes leave this clone's
selection in place.

After adding or removing skills, run `mt setup` in other existing worktrees
to reconcile their links. Their generated links use local Git exclusions.

## Policies and updates

For example, run `mt skills policy toolkit search --model-invocation deny` to
require explicit invocation. Overrides on linked authored skills edit the
source and affect its other consumers. Overrides on publisher-declared imports
stay in the imported copies.

After `mt skills update`, review the comparison and check connected publishers'
`monke.yml` changes before committing them there. The update may change the
Monke installation's local Source checkout and linked source repos in its scope.
To move a linked checkout to a different Git revision, update it separately.

The update sends content changes to the installed Codex CLI for read-only
summaries. Read `SKILL_UPDATE_SUMMARY.md` in the saved comparison when available.
Use the printed `mt diff` command if the viewer fails. Successful source updates
can remain applied when another source or consumer publication fails.
