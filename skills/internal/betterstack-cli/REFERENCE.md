# Query Better Stack telemetry

Before writing SQL, use `source get` to confirm the source ID, `team_id`,
`table_name` (passed to `--table` as `t<team_id>.<table_name>`), and
`data_region`. Include the metadata token when querying to validate the
table and endpoint against that source. Use CLI help for credential options.

The `source get` response includes the source's ingestion `token`; redact it
before keeping or showing the output. Trust live `data_region` over region
maps in docs or memory. In an isolated worktree where a repo wrapper's
sibling skill path is missing, run the shared CLI directly with
`--env-file` pointing at the source checkout's env file. A missing path or
wrong env file is not an invalid credential.

## Query shape

Use an explicit time window and `LIMIT`. Prefer `FORMAT JSONEachRow` for
machine-readable output. For retained log history, query both hot and cold
storage with the [SQL examples](references/query-shapes.sql). Hot and cold
storage overlap, so deduplicate by `(dt, raw)` for exact counts, and count
distinct failures separately from multiple log records of one failure.

Follow these query rules:

- Filter by `dt` when possible.
- Filter by repo-local `service` first when several services share a source.
- Use `JSONExtract(..., 'Nullable(...)')` for extracted fields.
- Use `_row_type = 1` for logs and `_row_type = 3` for spans in `s3Cluster`.
- Inspect the full timeline for a run ID even after a generic success marker, because later entries may record errors.

## Investigation closure

To determine whether a message, job, pipeline run, or event was processed, follow these steps:

1. Confirm source capture by exact ID, run ID, or distinctive phrase.
2. Filter to the expected service and time window.
3. Extract the request, message, job, trace, or pipeline run ID.
4. Expand the full raw timeline for that ID.
5. Identify the first hard error, first missing expected event, or complete success path.
6. Check repo-local persistence or downstream state when the wrapper skill requires it.
7. Return exactly one verdict for each requested entity:
   - `processed_successfully`: capture, processing, downstream action, and state all match the expected flow.
   - `failed_at_boundary`: name the boundary and first concrete error or missing expected event.
   - `not_captured`: no source capture exists after checking the expected source, service, and time window.
   - `inconclusive`: name the missing payload, ID, source, time window, or state evidence needed to decide.

For a dependency HTTP failure, keep the status, sanitized body, responder
headers, and request ID; a gateway fallback can reuse a domain error's status.
When the caller aborts without a response, compare elapsed time with the
deployed caller's timeout and check the downstream request timeline. A caller
deadline shows where the read stopped, not why the dependency did not respond.

For a polling incident, compare the entity's last success with its next
scheduled attempt. A healthy service or recovered alert does not prove that
entity reconciled.
