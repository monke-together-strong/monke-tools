---
name: betterstack-cli
description: Query Better Stack telemetry through the bundled HTTP CLI. Use to inspect Better Stack sources or connections, run Better Stack SQL, verify logs or spans, or classify whether a message, job, pipeline run, or event was captured and processed.
---

# BetterStack CLI

Use the bundled CLI for Better Stack metadata and SQL queries. Read repo-local wrapper skills first when they exist; they own source IDs, tables, service tags, event names, and domain-specific SQL.

## Quick Start

Run the CLI with Bun from this skill's directory. `--help` lists commands, options, and credential env vars.

```bash
bun ./scripts/betterstack-cli/index.ts --help
bun ./scripts/betterstack-cli/index.ts source get --id <source-id>
bun ./scripts/betterstack-cli/index.ts query run --source-id <source-id> --table <table> --sql "SELECT 1 FORMAT JSONEachRow"
```

Prefer a repo-local script such as `pnpm betterstack` when the wrapper skill or `package.json` provides one.

## Workflow

1. Read the repo-local Better Stack wrapper skill, if present.
2. Read [REFERENCE.md](./REFERENCE.md) before custom telemetry debugging.
3. Resolve source id, table name, service tag, and data region before writing custom SQL.
4. Use explicit time windows and `LIMIT`, and prefer machine-readable output such as `FORMAT JSONEachRow`. Adapt [query-shapes.sql](./references/query-shapes.sql) with the repo-local source and table details.
5. Query hot and cold storage when older retained logs or spans matter.
6. End with one verdict per requested entity, as defined in [Investigation Closure](./REFERENCE.md#investigation-closure).
