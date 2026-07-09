---
name: betterstack-cli
description: Query Better Stack telemetry through the bundled HTTP CLI. Use when Codex needs to inspect Better Stack sources or connections, run Better Stack SQL, verify logs or spans, or classify whether a message, job, pipeline run, or event was captured and processed.
---

# BetterStack CLI

Use the bundled CLI for Better Stack metadata and SQL queries. Read repo-local wrapper skills first when they exist; they own source IDs, tables, service tags, event names, and domain-specific SQL.

## Quick Start

Run the CLI with Bun:

```bash
cd skills/internal/betterstack-cli
bun ./scripts/betterstack-cli/index.ts --help
bun ./scripts/betterstack-cli/index.ts source get --id <source-id>
bun ./scripts/betterstack-cli/index.ts query run --source-id <source-id> --table <table> --sql "SELECT 1 FORMAT JSONEachRow"
```

Prefer a repo-local script such as `pnpm betterstack` when the wrapper skill or `package.json` provides one.

## Workflow

1. Read the repo-local Better Stack wrapper skill, if present.
2. Read [REFERENCE.md](./REFERENCE.md) before custom telemetry debugging.
3. Resolve source id, table name, service tag, and data region before writing custom SQL.
4. Prefer explicit time windows, `LIMIT`, and machine-readable output such as `FORMAT JSONEachRow`.
5. Query hot and cold storage when older retained logs or spans matter.
6. End with a concrete verdict: captured, processed successfully, failed at a named boundary, not captured, or inconclusive with the missing evidence named.

## Resources

- [REFERENCE.md](./REFERENCE.md) - command details, credentials, query shape, storage patterns, and closure workflow.
- [references/query-shapes.sql](./references/query-shapes.sql) - generic SQL patterns to adapt with repo-local source/table details.
- [scripts/betterstack-cli/index.ts](./scripts/betterstack-cli/index.ts) - bundled Better Stack HTTP CLI.
