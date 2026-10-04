# Imported Skill registry

Use `mt skills add` for personal or private imports. Recipes and invocation
policies live in `$MONKE_HOME/skill-registry/skills.lock.json` (normally
`~/.monke/skill-registry/skills.lock.json`), using the same format as monke's
repository lock. The registry starts with the bundled imported guidance.
Private content stays in your source directory or Monke home.

## Acquire skills

Choose how to get the skill files:

```sh
mt skills add owner/skills-repo --skill typography animation
mt skills add /path/to/private-skills --link --name private-skills
mt skills add --name course --command 'your-installer --project --yes'
```

Command imports run in `$MONKE_HOME/skill-sources/<name>` by default. Use `--cwd`
to choose a working directory. The command is saved and replayed by
`mt skills update`; reference credentials through environment variables.

For Emil's installer and an existing checkout:

```sh
mt skills add /path/to/emil-skills --name emil-skills --link \
  --command 'npx --yes @aiforui/install --token="${EMIL_TOKEN:?Set EMIL_TOKEN}" --project --yes'
mt skills policy emil-skills --model-invocation deny
```

`--link` registers the existing files without running the command now. Omit it
to run the installer immediately. With a command and no source path, `--name`
is required. `mt skills import` is an alias for `add`.

Monke selects one Skill source folder from the first existing folder in this
order: `.agents/skills`, `skills`, `.claude/skills`, `.codex/skills`,
`.cursor/skills`. Pass a specific skill directory to select it explicitly.
Nested skill folders are discovered, excluding reference folders.

Importing does not ask for an agent provider. The existing target preference
controls distribution: Claude gets flat skill links; Codex and Cursor use the
`monke-tools` namespace. Use `mt skills configure` to change those targets.
Command and linked imports retain source symlinks, so `/learn` edits the original
files through any installed target. Git imports use the registry's managed copies.

`--skill <slugs...>` restricts a collection. Repeating `add` preserves policies
and selections; a new `--skill` replaces the selection. Command and linked
sources without a selection include newly discovered skills on update.

## Invocation policies

Omit the skill argument to set the source default, including future skills.
Supply a slug for a per-skill override:

```sh
mt skills policy emil-skills --model-invocation deny
mt skills policy emil-skills emil-typography --model-invocation allow
```

The lock records `disableModelInvocation`: `true` for `deny`, `false` for
`allow`. A per-skill override takes precedence over the source default; no
recorded policy preserves upstream metadata.

Monke reapplies policies after updating the source, setting `disable-model-invocation`
in `SKILL.md` and the inverse `policy.allow_implicit_invocation` in
`agents/openai.yaml`. Explicit human invocation remains available in Claude and
Codex. The instruction body and other metadata are preserved.

## Update and review

Run `mt skills update` from any directory. It updates every registered source:
Git imports advance their discovery refs, command imports rerun the saved
installer, and linked imports reread their current files. Successful sources
are applied even if another fails. A failed command restores the preceding
Skill source folder; installers can also modify files outside that folder.

One Codiff comparison includes all changed guidance, supporting files, and the
registry lock. Command imports compare the current editable files with installer
output, including any learned changes it replaces. Plain linked imports compare
with their preceding accepted snapshot, showing changes installed outside Monke. Use `--adapter lfv` for LFV or
`--interactive` to accept upstream Git skill renames. The printed `mt diff`
command reopens the retained comparison if viewer delivery fails.

Invocation policies survive installer replacement. Instruction edits follow the
installer's overwrite behavior; commit or back them up before updating.

`mt skills list` shows registered sources. `mt skills remove <source>` removes
its registration and managed projections while preserving the external source.
User-owned target files are preserved, and destination collisions block
publication. Installation and target reconfiguration retain the registry.

For monke's public bundled imports, run `vpr skills:update` from its source
checkout and commit the repository lock.
