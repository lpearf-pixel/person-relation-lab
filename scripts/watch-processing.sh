#!/usr/bin/env bash
set -Eeuo pipefail

INTERVAL=${1:-30}
if ! [[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 [positive-seconds]" >&2
  exit 2
fi

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/person-relation-watch-${STAMP}.log"
LATEST="/tmp/person-relation-watch-latest.log"
: >"$LATEST"
exec > >(tee -a "$LOG" "$LATEST") 2>&1

echo "PERSON RELATION LIVE PROGRESS"
echo "started_at=$(date '+%F %T %z')"
echo "interval_seconds=$INTERVAL"
echo "log=$LOG"
echo "Ctrl+C stops only this monitor."

while true; do
  echo
  echo "===== $(date '+%F %T %z') ====="
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -P pager=off -U person_relation -d person_relation -c "
  SELECT f.relative_path, f.state, c.stage, c.state AS stage_state,
    c.last_raw_record_id, c.processed_rows, c.updated_at, c.completed_at
  FROM ingest.source_file f
  LEFT JOIN ingest.projection_checkpoint c ON c.source_file_id = f.id
  ORDER BY f.discovered_at,
    CASE c.stage WHEN 'people' THEN 1 WHEN 'mobile' THEN 2 WHEN 'address' THEN 3 WHEN 'company' THEN 4 ELSE 5 END;

  SELECT
    (SELECT COUNT(*) FROM raw.record) AS raw_records,
    (SELECT COUNT(*) FROM core.person_observation) AS projected_records,
    (SELECT COUNT(*) FROM core.person) AS people,
    (SELECT COUNT(*) FROM evidence.relationship_evidence WHERE algorithm_version = 'relation-v3') AS v3_evidence,
    (SELECT COUNT(*) FROM projection.relationship WHERE algorithm_version = 'relation-v3') AS v3_relationships;

  SELECT pid, now() - query_start AS duration,
    COALESCE(wait_event_type || ':' || wait_event, '-') AS waiting,
    pg_blocking_pids(pid) AS blocked_by,
    LEFT(regexp_replace(query, E'[\\n\\r]+', ' ', 'g'), 140) AS operation
  FROM pg_stat_activity
  WHERE datname = 'person_relation' AND state <> 'idle' AND pid <> pg_backend_pid()
  ORDER BY query_start;

  SELECT datname, tup_inserted, tup_updated, temp_files,
    pg_size_pretty(temp_bytes) AS temp_written,
    pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS wal_bytes
  FROM pg_stat_database WHERE datname = 'person_relation';
  "
  docker compose ps
  docker stats --no-stream person-relation-lab-app-1 person-relation-lab-db-1 2>/dev/null || true
  sleep "$INTERVAL"
done
