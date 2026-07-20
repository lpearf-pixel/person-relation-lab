BEGIN;
CREATE INDEX IF NOT EXISTS relationship_evidence_a_algorithm_idx
  ON evidence.relationship_evidence(person_a_id, algorithm_version);
CREATE INDEX IF NOT EXISTS relationship_evidence_b_algorithm_idx
  ON evidence.relationship_evidence(person_b_id, algorithm_version);
COMMIT;
