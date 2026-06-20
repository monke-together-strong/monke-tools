# Backlog.md Guide

Backlog.md is this repository's task tracker. Use the CLI for task writes and default reads.

## Command Rule

Use `bunx backlog.md ...` for every Backlog.md command in this workspace. A different `backlog` executable exists on this machine, so plain `backlog ...` may call the wrong tool. Treat upstream `backlog ...` examples as `bunx backlog.md ...` here.

Prefer `--plain` when reading tasks or search results for agent consumption.

Read task files directly only for inspection. Never write task markdown files under `backlog/tasks/` by hand.

## Task Lifecycle

1. Read the task, attached references, and linked documentation until the acceptance criteria and Definition of Done are clear.
2. Move the task to `In Progress`, assign it to yourself, and add the implementation plan when work starts.
3. Implement the task and append notes as meaningful progress, decisions, and blockers happen.
4. Check acceptance criteria and Definition of Done items as they are completed.
5. Add a reviewer-facing final summary covering the outcome, key changes, verification, and follow-ups.
6. Mark the task `Done` only after verification, checked acceptance criteria, checked Definition of Done items, and a final summary are complete.

## Task Authoring

- Include a title, description, and acceptance criteria.
- Keep acceptance criteria outcome-oriented, testable, and concise.
- Avoid implementation-step wording when an outcome can be stated instead.
- Do not add an implementation plan during task creation. Plans belong on the task when work starts.

## CLI Quick Reference

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

# Create docs and decisions
bunx backlog.md doc create "Architecture Notes"
bunx backlog.md decision create "Use Backlog.md for local task management"
```

Use ANSI-C quoted strings or real multi-line shell input so the CLI receives actual newline characters. Do not rely on literal `\n` inside normal quotes.

## Repo Surface

- `backlog/` stores tasks, drafts, docs, decisions, milestones, and archive folders.
- `backlog.config.yml` stores repo-level Backlog.md configuration.
- `AGENTS.md` contains the root agent instructions for this repo.
- `CLAUDE.md` is a symlink to `AGENTS.md`.

Run `bunx backlog.md config` to adjust Backlog.md project settings such as Definition of Done items, port, editor, and branch checks.

Run `bunx backlog.md agents --update-instructions` only when regenerating Backlog.md's default agent instructions. If you run it, re-apply this repo's compact `AGENTS.md` layout afterward.

## Upstream References

- [Backlog.md CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)
- [Backlog.md README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)
