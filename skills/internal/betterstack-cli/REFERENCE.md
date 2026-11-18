# Query Better Stack telemetry

Before writing SQL, use `source get` to confirm the source ID, SQL table name,
and `data_region`. Include the metadata token when querying to validate the
table and endpoint against that source. Use CLI help for credential options.

## Query shape

Use an explicit time window and `LIMIT`. Prefer `FORMAT JSONEachRow` for
machine-readable output. For retained log history, query both hot and cold
storage with the [SQL examples](references/query-shapes.sql).

Rules:

- Filter by `dt` when possible.
- Filter by repo-local `service` first when several services share a source.
- Use `JSONExtract(..., 'Nullable(...)')` for extracted fields.
- Use `_row_type = 1` for logs and `_row_type = 3` for spans in `s3Cluster`.
- Do not stop at generic success markers when the same run id contains errors.

## Investigation closure

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
