#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-secondary-quality-latest.log
RESULT_FILE="/tmp/person-relation-secondary-quality-result-$$.log"
NORMALIZER_VERSION=normalizer-v1
EXPECTED_PROFILE_BUCKETS=$((4 * 256))

: > "$LOG_FILE"
exec > >(tee "$LOG_FILE") 2>&1

finish() {
  status=$?
  trap - EXIT
  rm -f "$RESULT_FILE"
  echo "finished_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "exit_status=$status"
  echo "log_file=$LOG_FILE"
  exit "$status"
}
trap finish EXIT

echo "PERSON RELATION SECONDARY QUALITY REPORT"
echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "mode=read_only"
echo "normalizer_version=$NORMALIZER_VERSION"

SQL="
\\pset pager off
BEGIN;
SET TRANSACTION READ ONLY;

\\echo '===== SOURCE COVERAGE ====='
WITH raw_counts AS MATERIALIZED (
  SELECT source_file_id, COUNT(*)::bigint AS raw_rows
  FROM raw.record
  GROUP BY source_file_id
), projected_counts AS MATERIALIZED (
  SELECT record.source_file_id, COUNT(*)::bigint AS projected_rows
  FROM core.person_observation observation
  JOIN raw.record record ON record.id = observation.raw_record_id
  GROUP BY record.source_file_id
), normalized_counts AS MATERIALIZED (
  SELECT source_file_id, COUNT(*)::bigint AS normalized_rows
  FROM analytics.normalized_observation
  WHERE normalizer_version = '$NORMALIZER_VERSION'
  GROUP BY source_file_id
)
SELECT source.relative_path,
  source.state,
  COALESCE(raw.raw_rows, 0) AS raw_rows,
  COALESCE(projected.projected_rows, 0) AS projected_rows,
  COALESCE(normalized.normalized_rows, 0) AS normalized_rows,
  checkpoint.state AS normalization_checkpoint
FROM ingest.source_file source
LEFT JOIN raw_counts raw ON raw.source_file_id = source.id
LEFT JOIN projected_counts projected ON projected.source_file_id = source.id
LEFT JOIN normalized_counts normalized ON normalized.source_file_id = source.id
LEFT JOIN ingest.processing_checkpoint checkpoint
  ON checkpoint.pipeline_name = 'secondary-normalization'
 AND checkpoint.pipeline_version = '$NORMALIZER_VERSION'
 AND checkpoint.source_file_id = source.id
 AND checkpoint.stage = 'observations'
ORDER BY source.discovered_at, source.id;

\\echo '===== CHANNEL COVERAGE ====='
WITH totals AS (
  SELECT COUNT(*)::bigint AS total_rows,
    COUNT(*) FILTER (WHERE mobile_hash IS NOT NULL)::bigint AS mobile_rows,
    COUNT(*) FILTER (WHERE email_hash IS NOT NULL)::bigint AS email_rows,
    COUNT(*) FILTER (WHERE address_hash IS NOT NULL)::bigint AS address_rows,
    COUNT(*) FILTER (WHERE organization_hash IS NOT NULL)::bigint AS organization_rows
  FROM analytics.normalized_observation
  WHERE normalizer_version = '$NORMALIZER_VERSION'
), coverage(channel, nonempty_rows) AS (
  SELECT 'mobile', mobile_rows FROM totals
  UNION ALL SELECT 'email', email_rows FROM totals
  UNION ALL SELECT 'address', address_rows FROM totals
  UNION ALL SELECT 'organization', organization_rows FROM totals
)
SELECT coverage.channel,
  coverage.nonempty_rows,
  totals.total_rows,
  ROUND(coverage.nonempty_rows * 100.0 / NULLIF(totals.total_rows, 0), 4) AS coverage_percent
FROM coverage CROSS JOIN totals
ORDER BY coverage.channel;

\\echo '===== VALUE PROFILE DISTRIBUTION ====='
SELECT channel,
  CASE
    WHEN person_count = 1 THEN '1'
    WHEN person_count <= 5 THEN '2-5'
    WHEN person_count <= 20 THEN '6-20'
    WHEN person_count <= 100 THEN '21-100'
    ELSE '101+'
  END AS person_count_band,
  COUNT(*)::bigint AS value_count,
  SUM(observation_count)::bigint AS observation_count,
  SUM(person_count)::bigint AS person_count
FROM analytics.value_profile
WHERE normalizer_version = '$NORMALIZER_VERSION'
GROUP BY channel, person_count_band
ORDER BY channel,
  CASE person_count_band
    WHEN '1' THEN 1 WHEN '2-5' THEN 2 WHEN '6-20' THEN 3 WHEN '21-100' THEN 4 ELSE 5
  END;

\\echo '===== VALUE PROFILE CLASSIFICATIONS ====='
SELECT channel, classification, COUNT(*)::bigint AS value_count
FROM analytics.value_profile
WHERE normalizer_version = '$NORMALIZER_VERSION'
GROUP BY channel, classification
ORDER BY channel, classification;

\\echo '===== QUALITY FLAGS ====='
WITH flags AS (
  SELECT flag
  FROM analytics.normalized_observation observation
  CROSS JOIN LATERAL unnest(observation.quality_flags) AS expanded(flag)
  WHERE observation.normalizer_version = '$NORMALIZER_VERSION'
  UNION ALL
  SELECT flag
  FROM analytics.value_profile profile
  CROSS JOIN LATERAL unnest(profile.quality_flags) AS expanded(flag)
  WHERE profile.normalizer_version = '$NORMALIZER_VERSION'
)
SELECT flag, COUNT(*)::bigint AS occurrence_count
FROM flags
GROUP BY flag
ORDER BY occurrence_count DESC, flag;

\\echo '===== CHECKPOINT SUMMARY ====='
SELECT pipeline_name, pipeline_version, state,
  COUNT(*)::integer AS checkpoint_count,
  MIN(updated_at) AS earliest_update,
  MAX(updated_at) AS latest_update
FROM ingest.processing_checkpoint
WHERE pipeline_version = '$NORMALIZER_VERSION'
  AND pipeline_name IN ('secondary-normalization', 'secondary-value-profile')
GROUP BY pipeline_name, pipeline_version, state
ORDER BY pipeline_name, state;

\\echo '===== QUALITY SUMMARY ====='
WITH raw_counts AS MATERIALIZED (
  SELECT source_file_id, COUNT(*)::bigint AS raw_rows
  FROM raw.record
  GROUP BY source_file_id
), projected_counts AS MATERIALIZED (
  SELECT record.source_file_id, COUNT(*)::bigint AS projected_rows
  FROM core.person_observation observation
  JOIN raw.record record ON record.id = observation.raw_record_id
  GROUP BY record.source_file_id
), normalized_counts AS MATERIALIZED (
  SELECT source_file_id, COUNT(*)::bigint AS normalized_rows
  FROM analytics.normalized_observation
  WHERE normalizer_version = '$NORMALIZER_VERSION'
  GROUP BY source_file_id
), source_status AS MATERIALIZED (
  SELECT source.id,
    source.state,
    COALESCE(raw.raw_rows, 0) AS raw_rows,
    COALESCE(projected.projected_rows, 0) AS projected_rows,
    COALESCE(normalized.normalized_rows, 0) AS normalized_rows,
    checkpoint.state AS checkpoint_state
  FROM ingest.source_file source
  LEFT JOIN raw_counts raw ON raw.source_file_id = source.id
  LEFT JOIN projected_counts projected ON projected.source_file_id = source.id
  LEFT JOIN normalized_counts normalized ON normalized.source_file_id = source.id
  LEFT JOIN ingest.processing_checkpoint checkpoint
    ON checkpoint.pipeline_name = 'secondary-normalization'
   AND checkpoint.pipeline_version = '$NORMALIZER_VERSION'
   AND checkpoint.source_file_id = source.id
   AND checkpoint.stage = 'observations'
), source_summary AS (
  SELECT COUNT(*)::integer AS source_count,
    COUNT(*) FILTER (WHERE state = 'complete')::integer AS complete_sources,
    COUNT(*) FILTER (WHERE state <> 'complete')::integer AS incomplete_sources,
    COUNT(*) FILTER (WHERE raw_rows <> projected_rows)::integer AS projection_mismatches,
    COUNT(*) FILTER (WHERE projected_rows <> normalized_rows)::integer AS normalized_mismatches,
    COUNT(*) FILTER (WHERE checkpoint_state IS DISTINCT FROM 'complete')::integer AS incomplete_normalization_checkpoints
  FROM source_status
), profile_summary AS (
  SELECT COUNT(*) FILTER (
      WHERE pipeline_name = 'secondary-value-profile'
        AND pipeline_version = '$NORMALIZER_VERSION'
        AND source_file_id IS NULL
        AND stage LIKE 'profile:%'
        AND state = 'complete'
    )::integer AS complete_profile_buckets,
    COUNT(*) FILTER (
      WHERE pipeline_name = 'secondary-value-profile'
        AND pipeline_version = '$NORMALIZER_VERSION'
        AND source_file_id IS NULL
        AND stage LIKE 'profile:%'
        AND state <> 'complete'
    )::integer AS incomplete_profile_buckets
  FROM ingest.processing_checkpoint
), empty_hash_summary AS (
  SELECT COUNT(*)::bigint AS empty_hash_rows
  FROM analytics.normalized_observation
  WHERE normalizer_version = '$NORMALIZER_VERSION'
    AND (
      COALESCE(BTRIM(name_hash), '') = '' AND name_hash IS NOT NULL
      OR COALESCE(BTRIM(mobile_hash), '') = '' AND mobile_hash IS NOT NULL
      OR COALESCE(BTRIM(email_hash), '') = '' AND email_hash IS NOT NULL
      OR COALESCE(BTRIM(address_hash), '') = '' AND address_hash IS NOT NULL
      OR COALESCE(BTRIM(address_region_hash), '') = '' AND address_region_hash IS NOT NULL
      OR COALESCE(BTRIM(organization_hash), '') = '' AND organization_hash IS NOT NULL
      OR COALESCE(BTRIM(department_hash), '') = '' AND department_hash IS NOT NULL
    )
), profile_empty_hash_summary AS (
  SELECT COUNT(*)::bigint AS empty_profile_hash_rows
  FROM analytics.value_profile
  WHERE normalizer_version = '$NORMALIZER_VERSION'
    AND BTRIM(normalized_hash) = ''
), summary AS (
  SELECT source_summary.*,
    profile_summary.complete_profile_buckets,
    profile_summary.incomplete_profile_buckets,
    $EXPECTED_PROFILE_BUCKETS::integer AS expected_profile_buckets,
    empty_hash_summary.empty_hash_rows + profile_empty_hash_summary.empty_profile_hash_rows AS empty_hash_rows,
    (
      source_summary.source_count = 0
      OR source_summary.incomplete_sources > 0
      OR source_summary.projection_mismatches > 0
      OR source_summary.normalized_mismatches > 0
      OR source_summary.incomplete_normalization_checkpoints > 0
      OR profile_summary.complete_profile_buckets <> $EXPECTED_PROFILE_BUCKETS
      OR profile_summary.incomplete_profile_buckets > 0
      OR empty_hash_summary.empty_hash_rows > 0
      OR profile_empty_hash_summary.empty_profile_hash_rows > 0
    ) AS failed
  FROM source_summary
  CROSS JOIN profile_summary
  CROSS JOIN empty_hash_summary
  CROSS JOIN profile_empty_hash_summary
)
SELECT jsonb_pretty(jsonb_build_object(
    'normalizer_version', '$NORMALIZER_VERSION',
    'source_count', source_count,
    'complete_sources', complete_sources,
    'incomplete_sources', incomplete_sources,
    'projection_mismatches', projection_mismatches,
    'normalized_mismatches', normalized_mismatches,
    'incomplete_normalization_checkpoints', incomplete_normalization_checkpoints,
    'complete_profile_buckets', complete_profile_buckets,
    'expected_profile_buckets', expected_profile_buckets,
    'incomplete_profile_buckets', incomplete_profile_buckets,
    'empty_hash_rows', empty_hash_rows
  )) AS report,
  failed
FROM summary
\\gset secondary_

\\echo :secondary_report

\\echo '===== ACTIVE SECONDARY OPERATIONS ====='
SELECT pid,
  now() - query_start AS duration,
  COALESCE(wait_event_type || ':' || wait_event, '-') AS waiting,
  pg_blocking_pids(pid) AS blocked_by,
  LEFT(regexp_replace(query, E'[\\n\\r]+', ' ', 'g'), 160) AS operation
FROM pg_stat_activity
WHERE datname = current_database()
  AND state <> 'idle'
  AND pid <> pg_backend_pid()
  AND (
    application_name = 'person-relation-secondary-processing'
    OR query ILIKE '%analytics.normalized_observation%'
    OR query ILIKE '%analytics.value_profile%'
  )
ORDER BY query_start;

\\if :secondary_failed
  \\echo SECONDARY_QUALITY_FAIL
\\else
  \\echo SECONDARY_QUALITY_PASS
\\endif

COMMIT;
"

printf '%s\n' "$SQL" | docker compose exec -T \
  -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=600000" \
  db psql \
  -v ON_ERROR_STOP=1 \
  -U person_relation \
  -d person_relation | tee "$RESULT_FILE"

if grep -q '^SECONDARY_QUALITY_FAIL$' "$RESULT_FILE"; then
  exit 1
fi
