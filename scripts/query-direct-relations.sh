#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_NAME=${1:-SUWENLONG}
RESULT_LIMIT=${2:-100}
OUTPUT=${3:-/tmp/person-relation-direct-relations-latest.csv}
GENDER_MODE=${4:-opposite}

case "$RESULT_LIMIT" in
  ''|*[!0-9]*)
    echo "usage: $0 [exact-name] [positive-limit] [output.csv]" >&2
    exit 2
    ;;
esac

if [ "$RESULT_LIMIT" -le 0 ]; then
  echo "usage: $0 [exact-name] [positive-limit] [output.csv]" >&2
  exit 2
fi

case "$GENDER_MODE" in
  opposite|all) ;;
  *)
    echo "gender mode must be opposite or all" >&2
    exit 2
    ;;
esac

echo "Querying direct relationships for exact name: $TARGET_NAME" >&2
echo "Gender mode: $GENDER_MODE" >&2
echo "CSV output: $OUTPUT" >&2

docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -v target_name="$TARGET_NAME" \
  -v result_limit="$RESULT_LIMIT" \
  -v gender_mode="$GENDER_MODE" \
  -U person_relation \
  -d person_relation \
  --csv <<'SQL' | tee "$OUTPUT"
WITH target_people AS MATERIALIZED (
  SELECT person.id
  FROM core.person person
  WHERE person.canonical_name = :'target_name'
), direct_candidates AS MATERIALIZED (
  SELECT
    target.id AS target_id,
    relationship.person_b_id AS related_id,
    relationship.id,
    relationship.person_a_id,
    relationship.person_b_id,
    relationship.relation_type,
    relationship.confidence,
    relationship.completeness,
    relationship.status,
    relationship.algorithm_version,
    relationship.updated_at
  FROM projection.relationship relationship
  JOIN target_people target ON target.id = relationship.person_a_id
  WHERE relationship.status IN ('observed', 'inferred', 'confirmed')

  UNION ALL

  SELECT
    target.id AS target_id,
    relationship.person_a_id AS related_id,
    relationship.id,
    relationship.person_a_id,
    relationship.person_b_id,
    relationship.relation_type,
    relationship.confidence,
    relationship.completeness,
    relationship.status,
    relationship.algorithm_version,
    relationship.updated_at
  FROM projection.relationship relationship
  JOIN target_people target ON target.id = relationship.person_b_id
  WHERE relationship.status IN ('observed', 'inferred', 'confirmed')
), ranked_direct AS (
  SELECT
    candidate.*,
    ROW_NUMBER() OVER (
      PARTITION BY candidate.target_id, candidate.related_id
      ORDER BY
        CASE candidate.algorithm_version
          WHEN 'relation-v3' THEN 0
          WHEN 'relation-v2' THEN 1
          ELSE 2
        END,
        candidate.confidence DESC,
        candidate.completeness DESC,
        candidate.updated_at DESC,
        candidate.id
    ) AS version_rank
  FROM direct_candidates candidate
), gender_filtered AS (
  SELECT ranked.*
  FROM ranked_direct ranked
  JOIN core.person target_person ON target_person.id = ranked.target_id
  JOIN core.person related_person ON related_person.id = ranked.related_id
  WHERE ranked.version_rank = 1
    AND (
      :'gender_mode' = 'all'
      OR (
        target_person.gender IN ('M', 'F')
        AND related_person.gender IN ('M', 'F')
        AND target_person.gender <> related_person.gender
      )
    )
), limited_direct AS MATERIALIZED (
  SELECT *
  FROM gender_filtered
  ORDER BY confidence DESC, updated_at DESC
  LIMIT :result_limit
), relevant_people AS MATERIALIZED (
  SELECT target_id AS person_id FROM limited_direct
  UNION
  SELECT related_id AS person_id FROM limited_direct
), profiles AS MATERIALIZED (
  SELECT DISTINCT ON (observation.person_id)
    observation.person_id,
    person.canonical_name,
    person.gender,
    person.birthday,
    NULLIF(raw.values->>'CtfId', '') AS identity_number,
    COALESCE(
      NULLIF(raw.values->>'Mobile', ''),
      NULLIF(raw.values->>'Tel', '')
    ) AS mobile,
    COALESCE(
      NULLIF(raw.values->>'Address', ''),
      NULLIF(raw.values->>'CAddress', '')
    ) AS address,
    NULLIF(raw.values->>'Company', '') AS company
  FROM relevant_people relevant
  JOIN core.person person ON person.id = relevant.person_id
  LEFT JOIN core.person_observation observation
    ON observation.person_id = relevant.person_id
  LEFT JOIN raw.record raw ON raw.id = observation.raw_record_id
  ORDER BY observation.person_id, observation.raw_record_id DESC
), evidence_summaries AS MATERIALIZED (
  SELECT
    direct.id AS relationship_id,
    STRING_AGG(
      DISTINCT CONCAT(
        evidence.explanation,
        '[', evidence.channel, ':', evidence.weight, ']'
      ),
      '; '
    ) AS evidence_summary
  FROM limited_direct direct
  LEFT JOIN evidence.relationship_evidence evidence
    ON evidence.person_a_id = direct.person_a_id
   AND evidence.person_b_id = direct.person_b_id
   AND evidence.algorithm_version = direct.algorithm_version
  GROUP BY direct.id
)
SELECT
  direct.target_id,
  target.canonical_name AS target_name,
  target.gender AS target_gender,
  target.birthday AS target_birthday,
  CASE
    WHEN LENGTH(target.identity_number) >= 10
      THEN LEFT(target.identity_number, 6) || '********' || RIGHT(target.identity_number, 4)
    ELSE NULL
  END AS target_id_masked,
  CASE
    WHEN LENGTH(target.mobile) >= 7
      THEN LEFT(target.mobile, 3) || '****' || RIGHT(target.mobile, 4)
    ELSE target.mobile
  END AS target_mobile_masked,
  target.address AS target_address,
  target.company AS target_company,
  direct.related_id,
  related.canonical_name AS related_name,
  related.gender AS related_gender,
  related.birthday AS related_birthday,
  CASE
    WHEN LENGTH(related.identity_number) >= 10
      THEN LEFT(related.identity_number, 6) || '********' || RIGHT(related.identity_number, 4)
    ELSE NULL
  END AS related_id_masked,
  CASE
    WHEN LENGTH(related.mobile) >= 7
      THEN LEFT(related.mobile, 3) || '****' || RIGHT(related.mobile, 4)
    ELSE related.mobile
  END AS related_mobile_masked,
  related.address AS related_address,
  related.company AS related_company,
  CONCAT(target.gender, '-', related.gender) AS gender_pair,
  direct.relation_type,
  direct.confidence,
  CASE
    WHEN direct.confidence >= 0.80 THEN 'high'
    WHEN direct.confidence >= 0.45 THEN 'medium'
    ELSE 'low'
  END AS review_priority,
  direct.completeness,
  direct.status,
  direct.algorithm_version,
  summary.evidence_summary
FROM limited_direct direct
LEFT JOIN profiles target ON target.person_id = direct.target_id
LEFT JOIN profiles related ON related.person_id = direct.related_id
LEFT JOIN evidence_summaries summary ON summary.relationship_id = direct.id
ORDER BY direct.confidence DESC, related.canonical_name;
SQL

echo "Query complete: $OUTPUT" >&2
