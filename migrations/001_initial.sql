BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS evidence;
CREATE SCHEMA IF NOT EXISTS projection;
CREATE SCHEMA IF NOT EXISTS review;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE ingest.source_file (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), approved_root TEXT NOT NULL,
  relative_path TEXT NOT NULL, size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  modified_at TIMESTAMPTZ NOT NULL, sha256 CHAR(64) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('discovered','settling','ready','importing','complete','quarantined')),
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  UNIQUE (approved_root, relative_path, sha256)
);
CREATE TABLE ingest.import_checkpoint (
  source_file_id UUID NOT NULL REFERENCES ingest.source_file(id), sheet_name TEXT NOT NULL,
  last_source_row BIGINT NOT NULL DEFAULT 0, state TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_file_id, sheet_name)
);
CREATE TABLE raw.record (
  id BIGSERIAL PRIMARY KEY, source_file_id UUID NOT NULL REFERENCES ingest.source_file(id),
  sheet_name TEXT NOT NULL, source_row_number BIGINT NOT NULL, values JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (source_file_id, sheet_name, source_row_number)
);
CREATE TABLE core.person (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), canonical_name TEXT, gender CHAR(1), birthday DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE core.identifier (
  id BIGSERIAL PRIMARY KEY, person_id UUID NOT NULL REFERENCES core.person(id),
  kind TEXT NOT NULL, value_hash CHAR(64) NOT NULL, masked_value TEXT NOT NULL,
  encrypted_value BYTEA, valid BOOLEAN NOT NULL, source_record_id BIGINT NOT NULL REFERENCES raw.record(id),
  UNIQUE (person_id, kind, value_hash, source_record_id)
);
CREATE TABLE evidence.relationship_evidence (
  id BIGSERIAL PRIMARY KEY, person_a_id UUID NOT NULL REFERENCES core.person(id),
  person_b_id UUID NOT NULL REFERENCES core.person(id), source_record_id BIGINT REFERENCES raw.record(id),
  kind TEXT NOT NULL, channel TEXT NOT NULL, weight INTEGER NOT NULL, supports BOOLEAN NOT NULL,
  explanation TEXT NOT NULL, algorithm_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE projection.relationship (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), person_a_id UUID NOT NULL REFERENCES core.person(id),
  person_b_id UUID NOT NULL REFERENCES core.person(id), relation_type TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL, completeness NUMERIC(5,4) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('observed','inferred','confirmed','rejected','superseded')),
  algorithm_version TEXT NOT NULL, first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (person_a_id <> person_b_id)
);
CREATE INDEX relationship_a_idx ON projection.relationship(person_a_id);
CREATE INDEX relationship_b_idx ON projection.relationship(person_b_id);
CREATE TABLE review.decision (
  id BIGSERIAL PRIMARY KEY, relationship_id UUID REFERENCES projection.relationship(id),
  decision TEXT NOT NULL CHECK (decision IN ('confirmed','rejected','superseded')),
  reason TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit.event (
  id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, actor TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
