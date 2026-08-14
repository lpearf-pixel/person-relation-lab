export type RelationStage = {
  stage: "mobile" | "address" | "company";
  column: "mobile_hash" | "address_hash" | "company_hash";
  kind: "shared_private_mobile" | "same_address" | "same_company";
  channel: "contact" | "household" | "organization";
  weight: number;
  maxPeople: number;
  explanation: string;
};

export const RELATION_STAGES = [
  { stage: "mobile", column: "mobile_hash", kind: "shared_private_mobile", channel: "contact", weight: 45, maxPeople: 5, explanation: "归一化私人联系方式相同" },
  { stage: "address", column: "address_hash", kind: "same_address", channel: "household", weight: 35, maxPeople: 10, explanation: "非空归一化地址相同" },
  { stage: "company", column: "company_hash", kind: "same_company", channel: "organization", weight: 15, maxPeople: 5, explanation: "归一化单位相同" }
] as const satisfies readonly RelationStage[];

export function relationshipBatchSql(definition: RelationStage): string {
  const { stage, column, kind, channel, weight, maxPeople, explanation } = definition;
  return `WITH batch AS MATERIALIZED (
    SELECT o.raw_record_id, o.person_id, o.${column} AS hash
    FROM core.person_observation o
    JOIN raw.record r ON r.id = o.raw_record_id
    WHERE r.source_file_id = $1 AND o.raw_record_id > $2::bigint
    ORDER BY o.raw_record_id LIMIT $3
  ), candidate_hash AS (
    SELECT DISTINCT hash FROM batch WHERE hash IS NOT NULL
  ), eligible_hash AS (
    SELECT candidate.hash
    FROM candidate_hash candidate
    JOIN LATERAL (
      SELECT DISTINCT matched.person_id
      FROM core.person_observation matched
      WHERE matched.${column} = candidate.hash
      LIMIT ${maxPeople + 1}
    ) people ON true
    GROUP BY candidate.hash
    HAVING COUNT(*) BETWEEN 2 AND ${maxPeople}
  ), matched_people AS (
    SELECT eligible.hash, matched.person_id
    FROM eligible_hash eligible
    JOIN LATERAL (
      SELECT DISTINCT matched.person_id
      FROM core.person_observation matched
      WHERE matched.${column} = eligible.hash
    ) matched ON true
  ), matches AS (
    SELECT DISTINCT
      LEAST(source.person_id, matched.person_id) AS person_a_id,
      GREATEST(source.person_id, matched.person_id) AS person_b_id,
      source.raw_record_id AS source_record_id
    FROM batch source
    JOIN matched_people matched
      ON matched.hash = source.hash AND matched.person_id <> source.person_id
  ), inserted_evidence AS (
    INSERT INTO evidence.relationship_evidence(
      person_a_id, person_b_id, source_record_id, kind, channel, weight,
      supports, explanation, algorithm_version
    )
    SELECT person_a_id, person_b_id, source_record_id, '${kind}', '${channel}', ${weight},
      true, '${explanation}', 'relation-v3'
    FROM matches
    ON CONFLICT (person_a_id, person_b_id, source_record_id, kind, algorithm_version)
      WHERE algorithm_version = 'relation-v3'
    DO NOTHING
    RETURNING person_a_id, person_b_id, channel, weight
  ), affected_pairs AS (
    SELECT DISTINCT person_a_id, person_b_id FROM matches
  ), visible_evidence AS (
    SELECT evidence.person_a_id, evidence.person_b_id, evidence.channel, evidence.weight
    FROM evidence.relationship_evidence evidence
    JOIN affected_pairs affected
      ON affected.person_a_id = evidence.person_a_id
     AND affected.person_b_id = evidence.person_b_id
    WHERE evidence.algorithm_version = 'relation-v3'
    UNION ALL
    SELECT person_a_id, person_b_id, channel, weight FROM inserted_evidence
  ), scores AS (
    SELECT evidence.person_a_id, evidence.person_b_id,
      COUNT(DISTINCT evidence.channel) AS channels,
      BOOL_OR(evidence.channel = 'contact') AS has_contact,
      BOOL_OR(evidence.channel = 'household') AS has_household,
      BOOL_OR(evidence.channel = 'organization') AS has_organization,
      LEAST(95, SUM(DISTINCT evidence.weight)) AS score
    FROM visible_evidence evidence
    GROUP BY evidence.person_a_id, evidence.person_b_id
  ), classified AS (
    SELECT scores.*,
      CASE
        WHEN has_contact AND has_household AND channels >= 2 THEN 'possible_partner_association'
        WHEN has_household THEN 'household_association'
        WHEN has_contact THEN 'contact_association'
        WHEN has_organization THEN 'organization_association'
        ELSE 'generic_association'
      END AS relation_type
    FROM scores
  ), projected AS (
    INSERT INTO projection.relationship(
      person_a_id, person_b_id, relation_type, confidence, completeness,
      status, algorithm_version, first_seen_at, last_seen_at
    )
    SELECT person_a_id, person_b_id, relation_type, score / 100.0,
      LEAST(1.0, channels / 3.0), 'inferred', 'relation-v3', now(), now()
    FROM classified
    ON CONFLICT (person_a_id, person_b_id, relation_type, algorithm_version)
    DO UPDATE SET confidence = EXCLUDED.confidence,
      completeness = EXCLUDED.completeness, last_seen_at = now(), updated_at = now()
    RETURNING id
  ), checkpointed AS (
    INSERT INTO ingest.projection_checkpoint(
      source_file_id, stage, last_raw_record_id, processed_rows, state, updated_at, completed_at
    )
    SELECT $1, '${stage}', MAX(raw_record_id), COUNT(*), 'running', now(), NULL
    FROM batch HAVING COUNT(*) > 0
    ON CONFLICT (source_file_id, stage) DO UPDATE SET
      last_raw_record_id = GREATEST(ingest.projection_checkpoint.last_raw_record_id, EXCLUDED.last_raw_record_id),
      processed_rows = ingest.projection_checkpoint.processed_rows + EXCLUDED.processed_rows,
      state = 'running', updated_at = now(), completed_at = NULL
    RETURNING last_raw_record_id
  )
  SELECT COUNT(*)::text AS processed_rows,
    MAX(batch.raw_record_id)::text AS last_raw_record_id
  FROM batch`;
}
