#!/usr/bin/env bash
set -Eeuo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/person-relation-pause-${STAMP}.log"
LATEST="/tmp/person-relation-pause-latest.log"
: >"$LATEST"
exec > >(tee -a "$LOG" "$LATEST") 2>&1

echo "PERSON RELATION SAFE PAUSE"
echo "started_at=$(date '+%F %T %z')"
echo "log=$LOG"

docker compose ps db
docker compose stop app || true

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U person_relation -d person_relation -c "
SELECT pid, pg_cancel_backend(pid) AS cancelled
FROM pg_stat_activity
WHERE datname = 'person_relation'
  AND pid <> pg_backend_pid()
  AND state <> 'idle'
  AND (
    query ILIKE '%relation-v2%'
    OR query ILIKE '%relation-v3%'
    OR query ILIKE '%projection_checkpoint%'
    OR query ILIKE '%person_observation a JOIN core.person_observation b%'
  );
"

for attempt in $(seq 1 120); do
  active=$(docker compose exec -T db psql -At -v ON_ERROR_STOP=1 -U person_relation -d person_relation -c "
    SELECT COUNT(*)
    FROM pg_stat_activity
    WHERE datname = 'person_relation'
      AND pid <> pg_backend_pid()
      AND state <> 'idle'
      AND (
        query ILIKE '%relation-v2%'
        OR query ILIKE '%relation-v3%'
        OR query ILIKE '%projection_checkpoint%'
        OR query ILIKE '%person_observation a JOIN core.person_observation b%'
      );")
  if [[ "$active" == "0" ]]; then break; fi
  if [[ "$attempt" == "120" ]]; then
    echo "ERROR: projection SQL remained active after 120 seconds"
    exit 1
  fi
  sleep 1
done

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U person_relation -d person_relation -c "
SELECT relative_path, state, completed_at
FROM ingest.source_file ORDER BY discovered_at;
"

echo "pause_complete_at=$(date '+%F %T %z')"
echo "PostgreSQL remains running; committed data and checkpoints are preserved."
