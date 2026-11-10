# BetterStack CLI Reference

This is the shared Better Stack query workflow. Repo-local wrapper skills own source IDs, table names, service tags, event names, and reusable domain SQL.

## Credentials

`--help` lists the credential env vars. Source and connection metadata commands use a Better Stack API token; `query run` uses query connection credentials. When `query run` also has an API token, it checks that the table and query endpoint match the source.

Without `--env-file`, the CLI loads `BETTERSTACK_ENV_FILE` when set, otherwise `.env.demo` from the current working directory when it exists. Set `BETTERSTACK_ENV_FILE` in a repo-local wrapper script when credentials live elsewhere.

## Source Metadata

Confirm source details before custom SQL:

```bash
pnpm betterstack source get --id <source-id>
```

Capture:

- source id
- table name such as `t<team>.<source_slug>`
- source `data_region`

## Query Shape

Always include `LIMIT`. Prefer explicit machine-readable output such as `FORMAT JSONEachRow`. Pass longer SQL with `--sql-file <path>` or `--stdin`.

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
