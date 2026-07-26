# Import skills through a skills CLI wrapper

Skill import is a monke-tools source-maintenance script, not an `mt` runtime command. `bun run skills:import -- <source>` wraps the upstream `skills` CLI for discovery, grouped selection, staging, and security assessment. Ordinary imports remain discoverable Imported skills under `skills/imported/`. Passing `--ref` applies one Import kind to the whole invocation and instead creates Imported references under `skills/references/imported/`: the selected root `SKILL.md` becomes `MAIN.md`, its complete leading YAML frontmatter is removed, and supporting files are preserved.

The repo-tracked Skill import recipe store records each selector's Import kind so `bun run skills:update` refreshes both forms through one lifecycle. A source selector owns exactly one Import kind; re-importing it with the opposite kind performs a staged migration and removes the former managed copy only after the replacement and recipe are valid. Skill and reference slug ownership are independent, while selector ownership remains exclusive. A pre-existing upstream `MAIN.md` fails before any selected managed directory or recipe changes.

Updates invoke the upstream CLI once per recipe and report any failed recipes after continuing through the rest. Interactive updates can accept staged slug changes; non-interactive updates fail with mismatch details. OpenClaw sources use the dedicated `--accept-openclaw-risks` flag, which records and replays upstream risk acceptance without allowing arbitrary extra CLI arguments. Passing `-i` or `--install` to either script runs local skill installation after Imported guidance is materialized.

## Considered Options

- Add `mt skills import`: rejected because import changes the monke-tools source tree and should not be distributed as a consumer workflow command.
- Add non-interactive selectors such as `--skill` or `--all`: rejected because the first version should have exactly one interactive import mode.
- Reimplement source parsing and discovery: rejected because the upstream `skills` CLI already owns that behavior and its Gen, Socket, and Snyk advisory display.
- Preserve existing imported directories by default: rejected because each Imported guidance directory is a managed mirror of its selected upstream skill.
- Use upstream `skills update` directly: rejected because monke-tools stores Imported guidance in ownership-specific roots outside the upstream project's normal `.agents/skills` and `skills-lock.json` update contract.
