-- Generic Better Stack query shapes. Replace source-specific table names and
-- service tags from the repo-local wrapper skill before execution.

-- name: latest_logs
SELECT
  dt,
  JSONExtract(raw, 'service', 'Nullable(String)') AS service,
  JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  raw
FROM (
  SELECT dt, raw FROM remote(REPLACE_HOT_LOGS_TABLE)
  UNION ALL
  SELECT dt, raw FROM s3Cluster(primary, REPLACE_COLD_STORAGE_TABLE) WHERE _row_type = 1
)
ORDER BY dt DESC
LIMIT 100
FORMAT JSONEachRow;

-- name: service_latest
SELECT
  dt,
  JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  raw
FROM (
  SELECT dt, raw FROM remote(REPLACE_HOT_LOGS_TABLE)
  UNION ALL
  SELECT dt, raw FROM s3Cluster(primary, REPLACE_COLD_STORAGE_TABLE) WHERE _row_type = 1
)
WHERE JSONExtract(raw, 'service', 'Nullable(String)') = 'REPLACE_SERVICE'
ORDER BY dt DESC
LIMIT 100
FORMAT JSONEachRow;

-- name: service_errors_recent
SELECT
  dt,
  JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  raw
FROM (
  SELECT dt, raw FROM remote(REPLACE_HOT_LOGS_TABLE)
  UNION ALL
  SELECT dt, raw FROM s3Cluster(primary, REPLACE_COLD_STORAGE_TABLE) WHERE _row_type = 1
)
WHERE JSONExtract(raw, 'service', 'Nullable(String)') = 'REPLACE_SERVICE'
  AND JSONExtract(raw, 'level', 'Nullable(String)') IN ('error', 'fatal')
ORDER BY dt DESC
LIMIT 100
FORMAT JSONEachRow;

-- name: raw_search
SELECT
  dt,
  JSONExtract(raw, 'service', 'Nullable(String)') AS service,
  JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  raw
FROM (
  SELECT dt, raw FROM remote(REPLACE_HOT_LOGS_TABLE)
  UNION ALL
  SELECT dt, raw FROM s3Cluster(primary, REPLACE_COLD_STORAGE_TABLE) WHERE _row_type = 1
)
WHERE raw LIKE '%REPLACE_SEARCH_TEXT%'
ORDER BY dt ASC
LIMIT 500
FORMAT JSONEachRow;
