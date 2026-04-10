# Backlog.md Usage

This repository is initialized for [Backlog.md](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md) in CLI mode.

## Command rule for this repo

Use `bunx backlog.md ...` for Backlog.md commands in this workspace.

There is already a different `backlog` executable installed on this machine, so plain `backlog ...` may call the wrong tool. Treat upstream `backlog ...` examples as `bunx backlog.md ...` here.

## Repo files

- `backlog/` stores tasks, drafts, docs, decisions, milestones, and archive folders.
- `backlog.config.yml` stores repo-level Backlog.md configuration.
- `AGENTS.md` contains the generated CLI guidance plus repo-specific notes.
- `CLAUDE.md` is a symlink to `AGENTS.md`.

## Quick start

```bash
# Show tasks in AI-friendly output
bunx backlog.md task list --plain

# Create a task
bunx backlog.md task create "Set up initial project structure" -d "Create the first working slice"

# View a single task
bunx backlog.md task 1 --plain

# Edit a task
bunx backlog.md task edit 1 -s "In Progress" --plan $'1. Inspect repo\n2. Implement\n3. Verify'

# Search across tasks, docs, and decisions
bunx backlog.md search "setup" --plain

# Open the terminal board
bunx backlog.md board

# Open the web UI
bunx backlog.md browser --no-open
```

## Common workflows

### Refresh the generated agent instructions

```bash
bunx backlog.md agents --update-instructions
```

Any repo-specific notes placed above the `BACKLOG.MD GUIDELINES` marker in `AGENTS.md` are preserved when instructions are refreshed.

### Adjust project settings

```bash
bunx backlog.md config
```

This opens the interactive configuration flow for defaults such as Definition of Done items, port, editor, and branch checks.

### Create docs and decisions

```bash
bunx backlog.md doc create "Architecture Notes"
bunx backlog.md decision create "Use Backlog.md for local task management"
```

## Working agreement for agents

- Use the CLI for task changes; do not hand-edit task markdown files under `backlog/tasks/`.
- Prefer `--plain` when reading tasks or search results for agent consumption.
- Keep task descriptions, acceptance criteria, notes, and final summaries updated through the CLI as work progresses.

## Upstream references

- [Backlog.md CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)
- [Backlog.md README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)
