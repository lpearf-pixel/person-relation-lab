BEGIN;
ALTER TABLE core.person ADD COLUMN IF NOT EXISTS identity_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS person_identity_key_uq ON core.person(identity_key) WHERE identity_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS core.person_observation (
  raw_record_id BIGINT PRIMARY KEY REFERENCES raw.record(id),
  person_id UUID NOT NULL REFERENCES core.person(id), name TEXT, birthday DATE, gender CHAR(1),
  id_hash CHAR(64), mobile_hash CHAR(64), address_hash CHAR(64), company_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS person_observation_mobile_idx ON core.person_observation(mobile_hash) WHERE mobile_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_observation_address_idx ON core.person_observation(address_hash) WHERE address_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_observation_company_idx ON core.person_observation(company_hash) WHERE company_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS relationship_unique_projection
  ON projection.relationship(person_a_id, person_b_id, relation_type, algorithm_version);
COMMIT;
