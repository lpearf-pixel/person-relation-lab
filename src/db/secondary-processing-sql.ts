export const SECONDARY_PIPELINE_NAME = "secondary-normalization";
export const SECONDARY_STAGE = "observations";

export const UPSERT_NORMALIZED_OBSERVATIONS_SQL = `WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
    raw_record_id bigint,
    person_id uuid,
    source_file_id uuid,
    normalizer_version text,
    name_hash char(64),
    mobile_hash char(64),
    email_hash char(64),
    address_hash char(64),
    address_region_hash char(64),
    address_detail_level smallint,
    organization_hash char(64),
    department_hash char(64),
    quality_flags text[]
  )
), observations AS (
  INSERT INTO analytics.normalized_observation(
    raw_record_id, person_id, source_file_id, normalizer_version,
    name_hash, mobile_hash, email_hash, address_hash, address_region_hash,
    address_detail_level, organization_hash, department_hash, quality_flags, processed_at
  )
  SELECT raw_record_id, person_id, source_file_id, normalizer_version,
    name_hash, mobile_hash, email_hash, address_hash, address_region_hash,
    address_detail_level, organization_hash, department_hash, quality_flags, now()
  FROM input
  ON CONFLICT (raw_record_id, normalizer_version) DO UPDATE SET
    person_id = EXCLUDED.person_id,
    source_file_id = EXCLUDED.source_file_id,
    name_hash = EXCLUDED.name_hash,
    mobile_hash = EXCLUDED.mobile_hash,
    email_hash = EXCLUDED.email_hash,
    address_hash = EXCLUDED.address_hash,
    address_region_hash = EXCLUDED.address_region_hash,
    address_detail_level = EXCLUDED.address_detail_level,
    organization_hash = EXCLUDED.organization_hash,
    department_hash = EXCLUDED.department_hash,
    quality_flags = EXCLUDED.quality_flags,
    processed_at = now()
  RETURNING raw_record_id
), checkpoint AS (
  INSERT INTO ingest.processing_checkpoint(
    pipeline_name, pipeline_version, source_file_id, stage,
    last_raw_record_id, processed_rows, state, last_error_code, updated_at, completed_at
  ) VALUES ($2, $3, $4, $5, $6::bigint, $7::bigint, 'running', NULL, now(), NULL)
  ON CONFLICT ON CONSTRAINT processing_checkpoint_scope_uq DO UPDATE SET
    last_raw_record_id = GREATEST(ingest.processing_checkpoint.last_raw_record_id, EXCLUDED.last_raw_record_id),
    processed_rows = ingest.processing_checkpoint.processed_rows + EXCLUDED.processed_rows,
    state = 'running', last_error_code = NULL, updated_at = now(), completed_at = NULL
  RETURNING last_raw_record_id
)
SELECT last_raw_record_id::text FROM checkpoint`;

export const SECONDARY_COVERAGE_SQL = `SELECT
  (SELECT COUNT(*)::text FROM raw.record WHERE source_file_id = $1) AS raw_records,
  (SELECT COUNT(*)::text
   FROM core.person_observation o
   JOIN raw.record r ON r.id = o.raw_record_id
   WHERE r.source_file_id = $1) AS projected_records,
  (SELECT COUNT(*)::text
   FROM analytics.normalized_observation
   WHERE source_file_id = $1 AND normalizer_version = $2) AS normalized_records`;

export const PROFILE_CHANNELS = {
  mobile: "mobile_hash",
  email: "email_hash",
  address: "address_hash",
  organization: "organization_hash"
} as const;

export type ProfileChannel = keyof typeof PROFILE_CHANNELS;

export function profileBucketSql(channel: ProfileChannel): string {
  const column = PROFILE_CHANNELS[channel];
  const qualityIssue = channel === "address"
    ? "quality_flags @> ARRAY['address_contains_organization']::text[]"
    : "false";
  return `WITH grouped AS (
    SELECT ${column} AS normalized_hash,
      COUNT(*)::bigint AS observation_count,
      COUNT(DISTINCT person_id)::bigint AS person_count,
      COUNT(DISTINCT source_file_id)::bigint AS source_count,
      BOOL_OR(${qualityIssue}) AS has_quality_issue,
      MIN(processed_at) AS first_observed_at,
      MAX(processed_at) AS last_observed_at
    FROM analytics.normalized_observation
    WHERE normalizer_version = $1
      AND ${column} IS NOT NULL
      AND left(${column}, 2) = $2
    GROUP BY ${column}
  ), profiles AS (
    INSERT INTO analytics.value_profile(
      channel, normalized_hash, normalizer_version,
      observation_count, person_count, source_count, classification,
      quality_flags, first_observed_at, last_observed_at, updated_at
    )
    SELECT $3, normalized_hash, $1,
      observation_count, person_count, source_count,
      CASE
        WHEN has_quality_issue THEN 'noisy'
        WHEN $3 = 'organization' THEN 'organization'
        WHEN person_count = 1 THEN 'private'
        ELSE 'shared_household'
      END,
      CASE
        WHEN has_quality_issue THEN ARRAY['quality_issue']::text[]
        WHEN $3 <> 'organization' AND person_count > 1 THEN ARRAY['threshold_pending_review']::text[]
        ELSE '{}'::text[]
      END,
      first_observed_at, last_observed_at, now()
    FROM grouped
    ON CONFLICT (channel, normalized_hash, normalizer_version) DO UPDATE SET
      observation_count = EXCLUDED.observation_count,
      person_count = EXCLUDED.person_count,
      source_count = EXCLUDED.source_count,
      classification = EXCLUDED.classification,
      quality_flags = EXCLUDED.quality_flags,
      first_observed_at = EXCLUDED.first_observed_at,
      last_observed_at = EXCLUDED.last_observed_at,
      updated_at = now()
    RETURNING normalized_hash
  ), checkpoint AS (
    INSERT INTO ingest.processing_checkpoint(
      pipeline_name, pipeline_version, source_file_id, stage,
      last_raw_record_id, processed_rows, state, last_error_code, updated_at, completed_at
    ) VALUES ($4, $1, NULL, $5, 0, (SELECT COUNT(*) FROM profiles), 'complete', NULL, now(), now())
    ON CONFLICT ON CONSTRAINT processing_checkpoint_scope_uq DO UPDATE SET
      processed_rows = EXCLUDED.processed_rows,
      state = 'complete', last_error_code = NULL, updated_at = now(), completed_at = now()
    RETURNING id
  )
  SELECT COUNT(*)::text AS profiled_values FROM profiles`;
}
