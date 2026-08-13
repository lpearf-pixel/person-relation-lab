#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-baseline-latest.log
BASELINE_RESULT_FILE="/tmp/person-relation-baseline-result-$$.log"

: > "$LOG_FILE"
exec > >(tee "$LOG_FILE") 2>&1

finish() {
  status=$?
  trap - EXIT
  rm -f "$BASELINE_RESULT_FILE"
  echo "finished_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "exit_status=$status"
  echo "log_file=$LOG_FILE"
  exit "$status"
}
trap finish EXIT

echo "PERSON RELATION BASELINE VERIFICATION"
echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "mode=read_only"

SQL="
\\pset pager off
\\echo '===== SOURCE COVERAGE AND SUMMARY ====='
WITH record_counts AS MATERIALIZED (
  SELECT record.source_file_id,
    COUNT(record.id)::bigint AS raw_rows,
    COUNT(observation.raw_record_id)::bigint AS projected_rows
  FROM raw.record record
  LEFT JOIN core.person_observation observation ON observation.raw_record_id = record.id
  GROUP BY record.source_file_id
), stage_counts AS MATERIALIZED (
  SELECT source_file_id,
    COUNT(*) FILTER (
      WHERE stage IN ('people', 'mobile', 'address', 'company')
        AND state = 'complete'
    )::integer AS complete_stages
  FROM ingest.projection_checkpoint
  GROUP BY source_file_id
), source_status AS MATERIALIZED (
  SELECT source.id,
  source.relative_path,
  source.state,
  source.discovered_at,
  source.completed_at,
  COALESCE(records.raw_rows, 0) AS raw_rows,
  COALESCE(records.projected_rows, 0) AS projected_rows,
  COALESCE(stages.complete_stages, 0) AS complete_stages
FROM ingest.source_file source
LEFT JOIN record_counts records ON records.source_file_id = source.id
  LEFT JOIN stage_counts stages ON stages.source_file_id = source.id
), summary AS (
  SELECT COUNT(*)::integer AS source_count,
    COUNT(*) FILTER (WHERE state <> 'complete')::integer AS incomplete_sources,
    COUNT(*) FILTER (WHERE raw_rows <> projected_rows)::integer AS projection_mismatches,
    COUNT(*) FILTER (WHERE complete_stages <> 4)::integer AS incomplete_stage_sources,
    COALESCE(
      BOOL_OR(
        state <> 'complete'
        OR raw_rows <> projected_rows
        OR complete_stages <> 4
      ),
      true
    ) AS failed
  FROM source_status
)
SELECT jsonb_pretty(
    jsonb_build_object(
      'sources', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'relative_path', relative_path,
              'state', state,
              'raw_rows', raw_rows,
              'projected_rows', projected_rows,
              'complete_stages', complete_stages,
              'expected_stage_count', 4,
              'completed_at', completed_at
            ) ORDER BY discovered_at, id
          )
          FROM source_status
        ),
        '[]'::jsonb
      ),
      'summary', jsonb_build_object(
        'source_count', summary.source_count,
        'incomplete_sources', summary.incomplete_sources,
        'projection_mismatches', summary.projection_mismatches,
        'incomplete_stage_sources', summary.incomplete_stage_sources
      )
    )
  ) AS report,
  summary.failed
FROM summary
\\gset baseline_

\\echo :baseline_report

\\echo '===== PROJECTION CHECKPOINTS ====='
SELECT source.relative_path,
  checkpoint.stage,
  checkpoint.state,
  checkpoint.last_raw_record_id,
  checkpoint.processed_rows,
  checkpoint.updated_at,
  checkpoint.completed_at
FROM ingest.source_file source
LEFT JOIN ingest.projection_checkpoint checkpoint ON checkpoint.source_file_id = source.id
ORDER BY source.discovered_at,
  CASE checkpoint.stage
    WHEN 'people' THEN 1
    WHEN 'mobile' THEN 2
    WHEN 'address' THEN 3
    WHEN 'company' THEN 4
    ELSE 5
  END;

\\echo '===== ACTIVE DATABASE OPERATIONS ====='
SELECT pid,
  now() - query_start AS duration,
  COALESCE(wait_event_type || ':' || wait_event, '-') AS waiting,
  pg_blocking_pids(pid) AS blocked_by,
  LEFT(regexp_replace(query, E'[\\n\\r]+', ' ', 'g'), 160) AS operation
FROM pg_stat_activity
WHERE datname = current_database()
  AND state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY query_start;

\\if :baseline_failed
  \\echo BASELINE_FAIL
\\else
  \\echo BASELINE_PASS
\\endif
"

printf '%s\n' "$SQL" | docker compose exec -T \
  -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120000" \
  db psql \
  -v ON_ERROR_STOP=1 \
  -U person_relation \
  -d person_relation | tee "$BASELINE_RESULT_FILE"

if grep -q '^BASELINE_FAIL$' "$BASELINE_RESULT_FILE"; then
  exit 1
fi
