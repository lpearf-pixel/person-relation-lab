#!/usr/bin/env bash
set -Eeuo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/person-relation-resume-${STAMP}.log"
LATEST="/tmp/person-relation-resume-latest.log"
: >"$LATEST"
exec > >(tee -a "$LOG" "$LATEST") 2>&1

echo "PERSON RELATION RESUMABLE RECOVERY"
echo "started_at=$(date '+%F %T %z')"
echo "git_head=$(git rev-parse --short HEAD)"
echo "log=$LOG"

docker compose up -d db
docker compose stop app || true

for attempt in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U person_relation -d person_relation >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == "60" ]]; then
    echo "ERROR: PostgreSQL did not become ready"
    exit 1
  fi
  sleep 2
done

docker compose build app
docker compose run --rm --no-deps app npm run migrate

echo "Projection recovery runs in the foreground and is safe to interrupt with Ctrl+C."
docker compose run --rm --no-deps app npm run repair:projections

inconsistent=$(docker compose exec -T db psql -At -v ON_ERROR_STOP=1 -U person_relation -d person_relation -c "
WITH source_status AS (
  SELECT f.id,
    (SELECT COUNT(*) FROM raw.record r WHERE r.source_file_id = f.id) AS raw_rows,
    (SELECT COUNT(*) FROM core.person_observation o
      JOIN raw.record r ON r.id = o.raw_record_id WHERE r.source_file_id = f.id) AS projected_rows,
    (SELECT COUNT(*) FROM ingest.projection_checkpoint c
      WHERE c.source_file_id = f.id
        AND c.stage IN ('people','mobile','address','company')
        AND c.state = 'complete') AS completed_stages
  FROM ingest.source_file f
)
SELECT COUNT(*) FROM source_status
WHERE raw_rows <> projected_rows OR completed_stages <> 4;")

if [[ "$inconsistent" != "0" ]]; then
  echo "ERROR: ${inconsistent} source file(s) remain inconsistent; app will stay stopped."
  exit 1
fi

docker compose up -d app
docker compose ps
echo "resume_complete_at=$(date '+%F %T %z')"
echo "All registered sources passed verification; normal scanning is running."
