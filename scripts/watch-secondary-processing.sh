#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-secondary-watch-latest.log
INTERVAL_SECONDS=${INTERVAL_SECONDS:-30}
ONCE=${ONCE:-0}
previous_wal_bytes=
previous_temp_bytes=

exec > >(tee "$LOG_FILE") 2>&1

snapshot() {
  echo ""
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') ====="
  docker compose ps
  docker stats --no-stream person-relation-lab-app-1 person-relation-lab-db-1 2>/dev/null || true

  docker compose exec -T db psql -U person_relation -d person_relation -P pager=off -c "
SELECT f.relative_path,
  f.state AS source_state,
  COUNT(DISTINCT r.id) AS raw_rows,
  COUNT(DISTINCT n.raw_record_id) FILTER (WHERE n.normalizer_version = 'normalizer-v1') AS normalized_rows
FROM ingest.source_file f
LEFT JOIN raw.record r ON r.source_file_id = f.id
LEFT JOIN analytics.normalized_observation n ON n.raw_record_id = r.id
GROUP BY f.id, f.relative_path, f.state, f.discovered_at
ORDER BY f.discovered_at;
" -c "
SELECT pipeline_name, pipeline_version, COALESCE(source_file_id::text, 'global') AS scope,
  stage, state, last_raw_record_id, processed_rows, updated_at, last_error_code
FROM ingest.processing_checkpoint
ORDER BY updated_at DESC
LIMIT 40;
" -c "
SELECT pid, now() - query_start AS duration,
  COALESCE(wait_event_type || ':' || wait_event, '-') AS waiting,
  pg_blocking_pids(pid) AS blocked_by,
  LEFT(regexp_replace(query, E'[\\n\\r]+', ' ', 'g'), 140) AS operation
FROM pg_stat_activity
WHERE datname = 'person_relation' AND state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY query_start;
" -c "
SELECT schemaname, relname, n_live_tup,
  pg_size_pretty(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname))) AS total_size
FROM pg_stat_user_tables
WHERE schemaname IN ('analytics','ingest')
ORDER BY pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) DESC;
"

  metrics=$(docker compose exec -T db psql -U person_relation -d person_relation -At -F '|' -c "
SELECT COALESCE((SELECT wal_bytes::numeric::text FROM pg_stat_wal), '0'),
  COALESCE((SELECT temp_bytes::numeric::text FROM pg_stat_database WHERE datname = 'person_relation'), '0');
")
  current_wal_bytes=${metrics%%|*}
  current_temp_bytes=${metrics#*|}
  if [ -n "$previous_wal_bytes" ]; then
    echo "wal_bytes_delta=$((current_wal_bytes - previous_wal_bytes))"
    echo "temp_bytes_delta=$((current_temp_bytes - previous_temp_bytes))"
  else
    echo "wal_bytes_delta=initial"
    echo "temp_bytes_delta=initial"
  fi
  previous_wal_bytes=$current_wal_bytes
  previous_temp_bytes=$current_temp_bytes
  echo "log_file=$LOG_FILE"
}

while true; do
  snapshot
  if [ "$ONCE" = "1" ]; then
    break
  fi
  sleep "$INTERVAL_SECONDS"
done
