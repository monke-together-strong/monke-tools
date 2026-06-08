# Import skills through a skills CLI wrapper

Skill import is a monke-tools source-maintenance script, not an `mt` runtime command. `bun run skills:import -- <source>` wraps the upstream `skills` CLI for source parsing, listing, install-time security advisory display, and normalized skill directories, prompts interactively for which listed skills to import, runs the selected install in a temporary staging directory with the universal agent copy target, then overwrites the selected directories under `skills/imported/` without reconciling local agent roots by default. Passing `-i` or `--install` runs the monke-tools skill install command after the imports are copied.

## Considered Options

- Add `mt skills import`: rejected because import changes the monke-tools source tree and should not be distributed as a consumer workflow command.
- Add non-interactive selectors such as `--skill` or `--all`: rejected because the first version should have exactly one interactive import mode.
- Reimplement source parsing and discovery: rejected because the upstream `skills` CLI already owns that behavior and its Gen, Socket, and Snyk advisory display.
- Preserve existing imported directories by default: rejected because `skills/imported/<skill>` is treated as a managed mirror of the selected upstream skill.
