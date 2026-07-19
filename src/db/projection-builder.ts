import type { Queryable } from "./repository.js";
import { normalizeRecord } from "../domain/record-normalizer.js";

export class PgProjectionBuilder {
  constructor(private readonly database: Queryable, private readonly pageSize = 2_000) {
    if (pageSize <= 0) throw new Error("pageSize must be positive");
  }

  async projectSource(sourceFileId: string): Promise<{ projectedRecords: number }> {
    let cursor = "0";
    let projectedRecords = 0;
    while (true) {
      const page = await this.database.query(
        `SELECT id::text, values FROM raw.record
         WHERE source_file_id = $1 AND id > $2::bigint ORDER BY id LIMIT $3`,
        [sourceFileId, cursor, this.pageSize]
      );
      if (!page.rows.length) break;
      const candidates = page.rows.map((row) => normalizeRecord(String(row.id), row.values as Record<string, unknown>));
      await this.materializeCandidates(candidates);
      projectedRecords += candidates.length;
      cursor = String(page.rows.at(-1)?.id);
    }
    await this.materializeRelationships(sourceFileId);
    return { projectedRecords };
  }

  private async materializeCandidates(candidates: ReturnType<typeof normalizeRecord>[]): Promise<void> {
    const payload = JSON.stringify(candidates.map((item) => ({
      raw_record_id: item.rawRecordId, identity_key: item.identityKey, name: item.name, birthday: item.birthday,
      gender: item.gender, id_hash: item.idHash, mobile_hash: item.mobileHash,
      address_hash: item.addressHash, company_hash: item.companyHash
    })));
    await this.database.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(raw_record_id bigint, identity_key text, name text,
           birthday date, gender char(1), id_hash char(64), mobile_hash char(64), address_hash char(64), company_hash char(64))
       ), inserted_people AS (
         INSERT INTO core.person(identity_key, canonical_name, birthday, gender)
         SELECT DISTINCT ON (identity_key) identity_key, name, birthday, gender FROM input
         ON CONFLICT (identity_key) WHERE identity_key IS NOT NULL DO UPDATE SET
           canonical_name = COALESCE(core.person.canonical_name, EXCLUDED.canonical_name),
           birthday = COALESCE(core.person.birthday, EXCLUDED.birthday), gender = COALESCE(core.person.gender, EXCLUDED.gender)
         RETURNING id, identity_key
       ), observations AS (
         INSERT INTO core.person_observation(raw_record_id, person_id, name, birthday, gender, id_hash, mobile_hash, address_hash, company_hash)
         SELECT i.raw_record_id, p.id, i.name, i.birthday, i.gender, i.id_hash, i.mobile_hash, i.address_hash, i.company_hash
         FROM input i JOIN core.person p USING(identity_key)
         ON CONFLICT (raw_record_id) DO NOTHING RETURNING raw_record_id, person_id, id_hash
       )
       INSERT INTO core.identifier(person_id, kind, value_hash, masked_value, valid, source_record_id)
       SELECT person_id, 'chinese_id', id_hash, '******************', true, raw_record_id FROM observations WHERE id_hash IS NOT NULL
       ON CONFLICT (person_id, kind, value_hash, source_record_id) DO NOTHING`, [payload]
    );
  }

  private async materializeRelationships(sourceFileId: string): Promise<void> {
    await this.database.query(RELATIONSHIP_EVIDENCE_SQL, [sourceFileId]);
    await this.database.query(RELATIONSHIP_PROJECTION_SQL, [sourceFileId]);
  }
}

const PAIRS = `WITH source_people AS (
  SELECT DISTINCT o.person_id FROM core.person_observation o JOIN raw.record r ON r.id = o.raw_record_id WHERE r.source_file_id = $1
), matches AS (
  SELECT LEAST(a.person_id,b.person_id) person_a_id, GREATEST(a.person_id,b.person_id) person_b_id,
    evidence.kind,evidence.channel,evidence.weight,a.raw_record_id source_record_id
  FROM core.person_observation a JOIN core.person_observation b ON a.person_id < b.person_id
  CROSS JOIN LATERAL (VALUES
    ('shared_private_mobile','contact',45,a.mobile_hash IS NOT NULL AND a.mobile_hash=b.mobile_hash),
    ('same_address','household',35,a.address_hash IS NOT NULL AND a.address_hash=b.address_hash),
    ('same_company','organization',15,a.company_hash IS NOT NULL AND a.company_hash=b.company_hash)
  ) evidence(kind,channel,weight,matched)
  WHERE (a.person_id IN (SELECT person_id FROM source_people) OR b.person_id IN (SELECT person_id FROM source_people))
    AND evidence.matched
)`;

const RELATIONSHIP_EVIDENCE_SQL = `${PAIRS}
INSERT INTO evidence.relationship_evidence(person_a_id,person_b_id,source_record_id,kind,channel,weight,supports,explanation,algorithm_version)
SELECT DISTINCT person_a_id,person_b_id,source_record_id,kind,channel,weight,true,
  CASE channel WHEN 'contact' THEN '归一化私人联系方式相同' WHEN 'household' THEN '非空归一化地址相同' ELSE '归一化单位相同' END,
  'relation-v1' FROM matches m WHERE NOT EXISTS (
    SELECT 1 FROM evidence.relationship_evidence e WHERE e.person_a_id=m.person_a_id AND e.person_b_id=m.person_b_id
      AND e.source_record_id=m.source_record_id AND e.kind=m.kind AND e.algorithm_version='relation-v1')`;

const RELATIONSHIP_PROJECTION_SQL = `${PAIRS}, scores AS (
  SELECT person_a_id,person_b_id,COUNT(DISTINCT channel) channels,BOOL_OR(channel='contact') has_contact,
    BOOL_OR(channel='household') has_household,BOOL_OR(channel='organization') has_organization,
    LEAST(95,SUM(DISTINCT weight)) score FROM matches GROUP BY person_a_id,person_b_id
), classified AS (
  SELECT *, CASE WHEN has_contact AND has_household AND channels>=2 THEN 'possible_partner_association'
    WHEN has_household THEN 'household_association' WHEN has_contact THEN 'contact_association'
    WHEN has_organization THEN 'organization_association' ELSE 'generic_association' END relation_type FROM scores
)
INSERT INTO projection.relationship(person_a_id,person_b_id,relation_type,confidence,completeness,status,algorithm_version)
SELECT person_a_id,person_b_id,relation_type,score/100.0,LEAST(1.0,channels/3.0),'inferred','relation-v1' FROM classified
ON CONFLICT (person_a_id,person_b_id,relation_type,algorithm_version) DO UPDATE SET
 confidence=EXCLUDED.confidence,completeness=EXCLUDED.completeness,updated_at=now()`;
