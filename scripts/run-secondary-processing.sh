#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-secondary-processing-latest.log
exec > >(tee "$LOG_FILE") 2>&1

echo "PERSON RELATION SECONDARY PROCESSING"
echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "git_head=$(git rev-parse --short HEAD)"
echo "log_file=$LOG_FILE"

docker compose exec -T db pg_isready -U person_relation -d person_relation
docker compose stop app

active_operations=$(docker compose exec -T db psql -U person_relation -d person_relation -Atc "
SELECT COUNT(*)
FROM pg_stat_activity
WHERE datname = 'person_relation'
  AND state <> 'idle'
  AND pid <> pg_backend_pid()
  AND (
    application_name = 'person-relation-secondary-processing'
    OR query ILIKE '%analytics.normalized_observation%'
    OR query ILIKE '%analytics.value_profile%'
    OR query ILIKE '%ingest.processing_checkpoint%'
  );
")

echo "active_secondary_operations=$active_operations"
if [ "$active_operations" -ne 0 ]; then
  echo "ERROR: secondary processing is already active"
  exit 1
fi

docker compose build app
docker compose run --rm --no-deps app npm run migrate
docker compose run --rm --no-deps app npm run process:secondary
docker compose up -d app

echo "completed_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "SECONDARY_PROCESSING_COMPLETE"
