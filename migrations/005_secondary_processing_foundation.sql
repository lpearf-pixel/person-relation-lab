BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.normalized_observation (
  raw_record_id BIGINT NOT NULL REFERENCES raw.record(id),
  person_id UUID NOT NULL REFERENCES core.person(id),
  source_file_id UUID NOT NULL REFERENCES ingest.source_file(id),
  normalizer_version TEXT NOT NULL,
  name_hash CHAR(64),
  mobile_hash CHAR(64),
  email_hash CHAR(64),
  address_hash CHAR(64),
  address_region_hash CHAR(64),
  address_detail_level SMALLINT NOT NULL CHECK (address_detail_level BETWEEN 0 AND 4),
  organization_hash CHAR(64),
  department_hash CHAR(64),
  quality_flags TEXT[] NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (raw_record_id, normalizer_version)
);

CREATE INDEX IF NOT EXISTS normalized_observation_source_version_raw_idx
  ON analytics.normalized_observation(source_file_id, normalizer_version, raw_record_id);
CREATE INDEX IF NOT EXISTS normalized_observation_person_version_idx
  ON analytics.normalized_observation(person_id, normalizer_version);

CREATE INDEX IF NOT EXISTS normalized_observation_mobile_profile_idx
  ON analytics.normalized_observation(normalizer_version, left(mobile_hash, 2), mobile_hash, person_id, source_file_id)
  WHERE mobile_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS normalized_observation_email_profile_idx
  ON analytics.normalized_observation(normalizer_version, left(email_hash, 2), email_hash, person_id, source_file_id)
  WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS normalized_observation_address_profile_idx
  ON analytics.normalized_observation(normalizer_version, left(address_hash, 2), address_hash, person_id, source_file_id)
  WHERE address_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS normalized_observation_organization_profile_idx
  ON analytics.normalized_observation(normalizer_version, left(organization_hash, 2), organization_hash, person_id, source_file_id)
  WHERE organization_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics.value_profile (
  channel TEXT NOT NULL CHECK (channel IN ('mobile','email','address','organization')),
  normalized_hash CHAR(64) NOT NULL,
  normalizer_version TEXT NOT NULL,
  observation_count BIGINT NOT NULL CHECK (observation_count > 0),
  person_count BIGINT NOT NULL CHECK (person_count > 0),
  source_count BIGINT NOT NULL CHECK (source_count > 0),
  classification TEXT NOT NULL CHECK (classification IN ('private','shared_household','organization','public','noisy')),
  quality_flags TEXT[] NOT NULL DEFAULT '{}',
  first_observed_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, normalized_hash, normalizer_version)
);

CREATE INDEX IF NOT EXISTS value_profile_version_channel_people_idx
  ON analytics.value_profile(normalizer_version, channel, person_count DESC);

CREATE TABLE IF NOT EXISTS ingest.processing_checkpoint (
  id BIGSERIAL PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  source_file_id UUID REFERENCES ingest.source_file(id),
  stage TEXT NOT NULL,
  last_raw_record_id BIGINT NOT NULL DEFAULT 0 CHECK (last_raw_record_id >= 0),
  processed_rows BIGINT NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','running','complete','failed')),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT processing_checkpoint_scope_uq UNIQUE NULLS NOT DISTINCT
    (pipeline_name, pipeline_version, source_file_id, stage)
);

CREATE INDEX IF NOT EXISTS processing_checkpoint_state_updated_idx
  ON ingest.processing_checkpoint(state, updated_at);

COMMIT;
