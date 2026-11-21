---
name: betterstack-cli
description: Query Better Stack telemetry through the bundled HTTP CLI. Use to inspect Better Stack sources or connections, run Better Stack SQL, verify logs or spans, or classify whether a message, job, pipeline run, or event was captured and processed.
---

# Better Stack CLI

Read the repo's wrapper skill when present for source IDs, service tags,
event names, and domain SQL. Prefer its package script when provided.
Otherwise, run the bundled CLI with Bun from the repo root so `.env.demo` and
relative file paths resolve in the repo:

```bash
bun <skill-dir>/scripts/betterstack-cli/index.ts --help
bun <skill-dir>/scripts/betterstack-cli/index.ts source get --id <source-id>
bun <skill-dir>/scripts/betterstack-cli/index.ts query run --source-id <source-id> --table t<team-id>.<table-name> --sql "SELECT 1 FORMAT JSONEachRow"
```

Before investigating an event or writing custom SQL, follow the
[query and investigation procedure](REFERENCE.md).
