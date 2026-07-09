# BetterStack CLI Reference

This is the shared Better Stack query workflow. Repo-local wrapper skills own source IDs, table names, service tags, event names, and reusable domain SQL.

## Commands

Use a repo-local wrapper such as `pnpm betterstack` when available. Otherwise run the bundled CLI directly:

```bash
bun /Users/hoangbn/Documents/projects/monke-tools/skills/internal/betterstack-cli/scripts/betterstack-cli/index.ts --help
```

Supported commands:

- `source list`
- `source get --id <source-id>`
- `connection list`
- `query run --source-id <source-id> --table <table> --sql ...`
- `query run --source-id <source-id> --table <table> --sql-file <path>`
- `query run --source-id <source-id> --table <table> --stdin`

## Credentials

Source and connection metadata commands use a Better Stack API token:

- `BETTER_STACK_TOKEN`
- `BETTERSTACK_API_TOKEN`

Query execution uses Better Stack query connection credentials:

- `BETTERSTACK_QUERY_URL` or `BETTERSTACK_SQL_URL`
- `BETTERSTACK_QUERY_HOST` or `BETTERSTACK_SQL_HOST`
- `BETTERSTACK_QUERY_USERNAME` or `BETTERSTACK_SQL_USERNAME`
- `BETTERSTACK_QUERY_PASSWORD` or `BETTERSTACK_SQL_PASSWORD`

If `--env-file` is omitted and `.env.demo` exists in the current working directory, the CLI loads it automatically.

Set `BETTERSTACK_ENV_FILE` in a repo-local wrapper script to choose a default env file when credentials do not live at root `.env.demo`.

## Source Metadata

Confirm source details before custom SQL:

```bash
pnpm betterstack source get --id <source-id>
```

Capture:

- source id
- table name such as `t<team>.<source_slug>`
- source `data_region`

If `query run` reports an endpoint or region mismatch, inspect:

```bash
pnpm betterstack connection list
```

Then switch to a query connection in the same region as the source.

## Query Shape

Always include `LIMIT`. Prefer explicit machine-readable output such as `FORMAT JSONEachRow`.

For retained log history, query both hot and cold storage:

```sql
SELECT dt, raw
FROM (
  SELECT dt, raw FROM remote(REPLACE_HOT_LOGS_TABLE)
  UNION ALL
  SELECT dt, raw FROM s3Cluster(primary, REPLACE_COLD_STORAGE_TABLE) WHERE _row_type = 1
)
ORDER BY dt DESC
LIMIT 50
FORMAT JSONEachRow
```

Rules:

- Filter by `dt` when possible.
- Filter by repo-local `service` first when several services share a source.
- Use `JSONExtract(..., 'Nullable(...)')` for extracted fields.
- Use `_row_type = 1` for logs and `_row_type = 3` for spans in `s3Cluster`.
- Do not stop at generic success markers when the same run id contains errors.

## Execution Patterns

Inline SQL:

```bash
pnpm betterstack query run \
  --source-id <source-id> \
  --table <table> \
  --sql "SELECT 1 FORMAT JSONEachRow"
```

SQL file:

```bash
pnpm betterstack query run \
  --source-id <source-id> \
  --table <table> \
  --sql-file /tmp/betterstack-query.sql
```

stdin:

```bash
printf '%s\n' "SELECT 1 FORMAT JSONEachRow" | \
  pnpm betterstack query run \
    --source-id <source-id> \
    --table <table> \
    --stdin
```

## Investigation Closure

For "was it processed?" and similar questions:

1. Confirm source capture by exact id, run id, or distinctive phrase.
2. Filter to the expected service and time window.
3. Extract the request, message, job, trace, or pipeline run id.
4. Expand the full raw timeline for that id.
5. Identify the first hard error, first missing expected event, or complete success path.
6. Check repo-local persistence or downstream state when the wrapper skill requires it.
7. Return exactly one verdict for each requested entity:
   - `processed_successfully`: capture, processing, downstream action, and state all match the expected flow.
   - `failed_at_boundary`: name the boundary and first concrete error or missing expected event.
   - `not_captured`: no source capture exists after checking the expected source, service, and time window.
   - `inconclusive`: name the missing payload, id, source, time window, or state evidence needed to decide.
