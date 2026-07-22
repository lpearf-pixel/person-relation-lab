BEGIN;

CREATE TABLE IF NOT EXISTS ingest.projection_checkpoint (
  source_file_id UUID NOT NULL REFERENCES ingest.source_file(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('people','mobile','address','company')),
  last_raw_record_id BIGINT NOT NULL DEFAULT 0 CHECK (last_raw_record_id >= 0),
  processed_rows BIGINT NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','complete','failed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (source_file_id, stage)
);

CREATE UNIQUE INDEX IF NOT EXISTS relationship_evidence_v3_unique
  ON evidence.relationship_evidence(
    person_a_id, person_b_id, source_record_id, kind, algorithm_version
  )
  WHERE algorithm_version = 'relation-v3';

CREATE INDEX IF NOT EXISTS person_observation_mobile_person_idx
  ON core.person_observation(mobile_hash, person_id)
  WHERE mobile_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_observation_address_person_idx
  ON core.person_observation(address_hash, person_id)
  WHERE address_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_observation_company_person_idx
  ON core.person_observation(company_hash, person_id)
  WHERE company_hash IS NOT NULL;

COMMIT;
