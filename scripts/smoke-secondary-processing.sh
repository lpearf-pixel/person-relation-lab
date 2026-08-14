#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-secondary-smoke-latest.log
QUALITY_RESULT_FILE="/tmp/person-relation-secondary-smoke-quality-$$.log"
EMPTY_IMPORT_DIR=$(mktemp -d "/tmp/person-relation-secondary-smoke-empty-XXXXXX")
COMPOSE_PROJECT_NAME="person-relation-secondary-smoke-$$"
POSTGRES_PASSWORD=synthetic-smoke-only
IMPORT_DIR=$EMPTY_IMPORT_DIR
SMOKE_APP_IMAGE=${SMOKE_APP_IMAGE:-}
SMOKE_TARGET_IMAGE="${COMPOSE_PROJECT_NAME}-app"
SMOKE_APP_IMAGE_TAGGED=0

export COMPOSE_PROJECT_NAME POSTGRES_PASSWORD IMPORT_DIR

: > "$LOG_FILE"
exec > >(tee "$LOG_FILE") 2>&1

cleanup() {
  status=$?
  trap - EXIT
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$SMOKE_APP_IMAGE_TAGGED" = "1" ]; then
    docker image rm "$SMOKE_TARGET_IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$EMPTY_IMPORT_DIR"
  rm -f "$QUALITY_RESULT_FILE"
  echo "finished_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "exit_status=$status"
  echo "log_file=$LOG_FILE"
  exit "$status"
}
trap cleanup EXIT

echo "PERSON RELATION SECONDARY PROCESSING SMOKE"
echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "compose_project=$COMPOSE_PROJECT_NAME"
echo "data_classification=synthetic_only"

docker compose version >/dev/null
if [ -n "$SMOKE_APP_IMAGE" ]; then
  docker image inspect "$SMOKE_APP_IMAGE" >/dev/null
  docker image tag "$SMOKE_APP_IMAGE" "$SMOKE_TARGET_IMAGE"
  SMOKE_APP_IMAGE_TAGGED=1
  echo "app_image_source=reused:$SMOKE_APP_IMAGE"
else
  echo "app_image_source=compose_build"
  docker compose build app
fi
docker compose up -d db

attempt=0
until docker compose exec -T db pg_isready -U person_relation -d person_relation >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "database_health_timeout"
    exit 1
  fi
  sleep 2
done

docker compose run --rm --no-deps app npm run migrate

FIXTURE_SQL="
BEGIN;

INSERT INTO ingest.source_file(
  id, approved_root, relative_path, size_bytes, modified_at, sha256,
  state, discovered_at, completed_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'synthetic-smoke-root', 'synthetic-secondary.csv', 1024, now(),
  repeat('a', 64), 'complete', now(), now()
);

INSERT INTO core.person(id, canonical_name, gender, birthday, identity_key) VALUES
  ('00000000-0000-4000-8000-000000000101', '合成甲', 'M', DATE '1949-12-31', 'synthetic:valid-duplicate'),
  ('00000000-0000-4000-8000-000000000102', '合成乙', 'F', DATE '1988-06-06', 'synthetic:shared-mobile'),
  ('00000000-0000-4000-8000-000000000103', '合成丙', 'M', NULL, 'synthetic:invalid-id'),
  ('00000000-0000-4000-8000-000000000104', '合成丁', 'F', DATE '1992-02-02', 'synthetic:public-unit');

INSERT INTO raw.record(source_file_id, sheet_name, source_row_number, values) VALUES
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 1,
    jsonb_build_object('Descriot', '合成甲', 'CtfId', '11010519491231002X', 'Gender', 'M',
      'Birthday', '19491231', 'Mobile', '+86 138-0013-8000',
      'Address', '合成市测试区安全路1号', 'Company', '合成公共服务中心 财务部', 'EMail', 'alpha@example.invalid')),
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 2,
    jsonb_build_object('Descriot', '合成甲', 'CtfId', '11010519491231002X', 'Gender', 'M',
      'Birthday', '19491231', 'Mobile', '13800138000',
      'Address', '合成市测试区安全路1号', 'Company', '合成公共服务中心 财务部')),
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 3,
    jsonb_build_object('Descriot', '合成乙', 'CtfId', '110105194912310021', 'Gender', 'F',
      'Birthday', '19880606', 'Mobile', '13800138000',
      'Address', '合成市测试区安全路1号', 'Company', '合成公共服务中心 人事部')),
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 4,
    jsonb_build_object('Descriot', '合成丙', 'CtfId', 'INVALID-SYNTHETIC-ID', 'Gender', 'M',
      'Mobile', 'not-a-mobile', 'Address', NULL, 'Company', '合成公共服务中心')),
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 5,
    jsonb_build_object('Descriot', '合成丁', 'Gender', 'F', 'Birthday', '19920202',
      'Address', '合成市测试区隔离路99号', 'Company', '合成公共服务中心 销售部', 'EMail', 'delta@example.invalid')),
  ('00000000-0000-4000-8000-000000000001', 'synthetic', 6,
    jsonb_build_object('Descriot', '合成丁', 'Gender', 'F', 'Birthday', '19920202',
      'Address', NULL, 'Company', '合成公共服务中心 销售部', 'EMail', 'broken-email'));

INSERT INTO core.person_observation(
  raw_record_id, person_id, name, birthday, gender, id_hash, mobile_hash, address_hash, company_hash
)
SELECT record.id,
  CASE record.source_row_number
    WHEN 1 THEN '00000000-0000-4000-8000-000000000101'::uuid
    WHEN 2 THEN '00000000-0000-4000-8000-000000000101'::uuid
    WHEN 3 THEN '00000000-0000-4000-8000-000000000102'::uuid
    WHEN 4 THEN '00000000-0000-4000-8000-000000000103'::uuid
    ELSE '00000000-0000-4000-8000-000000000104'::uuid
  END,
  '合成人物', NULL, NULL, NULL, NULL, NULL, NULL
FROM raw.record record
WHERE record.source_file_id = '00000000-0000-4000-8000-000000000001';

INSERT INTO analytics.normalized_observation(
  raw_record_id, person_id, source_file_id, normalizer_version,
  name_hash, mobile_hash, email_hash, address_hash, address_region_hash,
  address_detail_level, organization_hash, department_hash, quality_flags
)
SELECT record.id,
  '00000000-0000-4000-8000-000000000101',
  record.source_file_id,
  'normalizer-v1',
  encode(digest('synthetic-name-a', 'sha256'), 'hex'),
  encode(digest('synthetic-mobile-shared', 'sha256'), 'hex'),
  encode(digest('synthetic-email-a', 'sha256'), 'hex'),
  encode(digest('synthetic-address-a', 'sha256'), 'hex'),
  encode(digest('synthetic-region-a', 'sha256'), 'hex'),
  3,
  encode(digest('synthetic-public-unit', 'sha256'), 'hex'),
  encode(digest('synthetic-finance-department', 'sha256'), 'hex'),
  '{}'::text[]
FROM raw.record record
WHERE record.source_file_id = '00000000-0000-4000-8000-000000000001'
  AND record.source_row_number = 1;

INSERT INTO ingest.processing_checkpoint(
  pipeline_name, pipeline_version, source_file_id, stage,
  last_raw_record_id, processed_rows, state, updated_at
)
SELECT 'secondary-normalization', 'normalizer-v1', record.source_file_id, 'observations',
  record.id, 1, 'running', now()
FROM raw.record record
WHERE record.source_file_id = '00000000-0000-4000-8000-000000000001'
  AND record.source_row_number = 1;

COMMIT;
"

printf '%s\n' "$FIXTURE_SQL" | docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 -U person_relation -d person_relation

docker compose run --rm --no-deps \
  -e SECONDARY_BATCH_SIZE=2 \
  app npm run process:secondary

# 幂等重跑必须跳过已完成批次和画像桶，并继续通过覆盖验证。
docker compose run --rm --no-deps \
  -e SECONDARY_BATCH_SIZE=2 \
  app npm run process:secondary

./scripts/secondary-quality-report.sh | tee "$QUALITY_RESULT_FILE"
grep -q '^SECONDARY_QUALITY_PASS$' "$QUALITY_RESULT_FILE"

VERIFY_SQL="
SELECT CASE WHEN
  (SELECT COUNT(*) FROM analytics.normalized_observation WHERE normalizer_version = 'normalizer-v1') = 6
  AND (SELECT COUNT(*) FROM ingest.processing_checkpoint
       WHERE pipeline_name = 'secondary-normalization'
         AND pipeline_version = 'normalizer-v1'
         AND state = 'complete') = 1
  AND (SELECT COUNT(*) FROM ingest.processing_checkpoint
       WHERE pipeline_name = 'secondary-value-profile'
         AND pipeline_version = 'normalizer-v1'
         AND state = 'complete') = 1024
THEN 'SECONDARY_SMOKE_PASS'
ELSE 'SECONDARY_SMOKE_FAIL'
END;
"

result=$(printf '%s\n' "$VERIFY_SQL" | docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 -At -U person_relation -d person_relation)
echo "$result"
if [ "$result" != "SECONDARY_SMOKE_PASS" ]; then
  exit 1
fi
