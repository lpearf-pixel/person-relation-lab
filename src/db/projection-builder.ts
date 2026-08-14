import type { ConnectableDatabase, DatabaseClient } from "./repository.js";
import { normalizeRecord } from "../domain/record-normalizer.js";
import { RELATION_STAGES, relationshipBatchSql, type RelationStage } from "./projection-sql.js";

export class PgProjectionBuilder {
  constructor(
    private readonly database: ConnectableDatabase,
    private readonly pageSize = 2_000,
    private readonly relationBatchSize = 2_000
  ) {
    if (pageSize <= 0) throw new Error("pageSize must be positive");
    if (relationBatchSize <= 0) throw new Error("relationBatchSize must be positive");
  }

  async projectSource(sourceFileId: string): Promise<{ projectedRecords: number }> {
    const client = await this.database.connect();
    let locked = false;
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [sourceFileId]
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new Error(`projection already running for source ${sourceFileId}`);

      await this.preparePeopleStage(client, sourceFileId);
      await this.materializePeople(client, sourceFileId);
      await this.materializeRelationships(client, sourceFileId);
      const verification = await client.query(
        `SELECT
           (SELECT COUNT(*)::text FROM raw.record WHERE source_file_id = $1) AS raw_records,
           (SELECT COUNT(*)::text
            FROM core.person_observation o
            JOIN raw.record r ON r.id = o.raw_record_id
            WHERE r.source_file_id = $1) AS projected_records,
           (SELECT COUNT(*)::text
            FROM ingest.projection_checkpoint
            WHERE source_file_id = $1
              AND stage IN ('people','mobile','address','company')
              AND state = 'complete') AS completed_stages`,
        [sourceFileId]
      );
      const rawRecords = Number(verification.rows[0]?.raw_records);
      const projectedRecords = Number(verification.rows[0]?.projected_records);
      const completedStages = Number(verification.rows[0]?.completed_stages);
      if (![rawRecords, projectedRecords, completedStages].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("projection verification returned an invalid count");
      }
      if (rawRecords !== projectedRecords || completedStages !== 4) {
        throw new Error(
          `projection incomplete for source ${sourceFileId}: raw=${rawRecords}, projected=${projectedRecords}, stages=${completedStages}/4`
        );
      }
      return { projectedRecords };
    } finally {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [sourceFileId]);
      }
      client.release();
    }
  }

  private async preparePeopleStage(client: DatabaseClient, sourceFileId: string): Promise<void> {
    const result = await client.query(
      `WITH coverage AS MATERIALIZED (
         SELECT
           (SELECT COUNT(*) FROM raw.record WHERE source_file_id = $1) AS raw_records,
           (SELECT COUNT(*)
            FROM core.person_observation o
            JOIN raw.record r ON r.id = o.raw_record_id
            WHERE r.source_file_id = $1) AS projected_records,
           COALESCE((
             SELECT state FROM ingest.projection_checkpoint
             WHERE source_file_id = $1 AND stage = 'people'
           ), 'pending') AS people_state
       ), stale AS (
         SELECT 1 FROM coverage
         WHERE raw_records <> projected_records AND people_state = 'complete'
       ), stages(stage) AS (
         VALUES ('people'), ('mobile'), ('address'), ('company')
       ), invalidated AS (
         INSERT INTO ingest.projection_checkpoint(
           source_file_id, stage, last_raw_record_id, processed_rows, state, updated_at, completed_at
         )
         SELECT $1, stages.stage, 0, 0,
           CASE WHEN stages.stage = 'people' THEN 'running' ELSE 'pending' END,
           now(), NULL
         FROM stages CROSS JOIN stale
         WHERE true
         ON CONFLICT (source_file_id, stage) DO UPDATE SET
           last_raw_record_id = 0, processed_rows = 0,
           state = EXCLUDED.state, updated_at = now(), completed_at = NULL
         RETURNING stage
       )
       SELECT raw_records::text, projected_records::text, people_state,
         (SELECT COUNT(*)::text FROM invalidated) AS invalidated_stages
       FROM coverage`,
      [sourceFileId]
    );
    const row = result.rows[0];
    if (!row) return;
    const invalidatedStages = Number(row.invalidated_stages);
    if (invalidatedStages !== 0 && invalidatedStages !== 4) {
      throw new Error(`stale projection checkpoint invalidation affected ${invalidatedStages}/4 stages`);
    }
    if (invalidatedStages === 4) {
      console.info(JSON.stringify({
        event: "projection_stale_checkpoints_invalidated",
        sourceFileId,
        rawRecords: Number(row.raw_records),
        projectedRecords: Number(row.projected_records)
      }));
    }
  }

  private async materializePeople(client: DatabaseClient, sourceFileId: string): Promise<void> {
    const checkpoint = await client.query(
      `SELECT last_raw_record_id::text
       FROM ingest.projection_checkpoint
       WHERE source_file_id = $1 AND stage = 'people'`,
      [sourceFileId]
    );
    let cursor = String(checkpoint.rows[0]?.last_raw_record_id ?? "0");
    while (true) {
      const page = await client.query(
        `SELECT r.id::text, r.values FROM raw.record r
         WHERE r.source_file_id = $1 AND r.id > $2::bigint
           AND NOT EXISTS (
             SELECT 1 FROM core.person_observation o WHERE o.raw_record_id = r.id
           )
         ORDER BY r.id LIMIT $3`,
        [sourceFileId, cursor, this.pageSize]
      );
      if (!page.rows.length) {
        await this.completeStage(client, sourceFileId, "people", cursor);
        return;
      }
      const candidates = page.rows.map((row) => normalizeRecord(String(row.id), row.values as Record<string, unknown>));
      cursor = String(page.rows.at(-1)?.id);
      await this.materializeCandidates(client, sourceFileId, cursor, candidates);
    }
  }

  private async materializeCandidates(
    client: DatabaseClient,
    sourceFileId: string,
    lastRawRecordId: string,
    candidates: ReturnType<typeof normalizeRecord>[]
  ): Promise<void> {
    const payload = JSON.stringify(candidates.map((item) => ({
      raw_record_id: item.rawRecordId, identity_key: item.identityKey, name: item.name, birthday: item.birthday,
      gender: item.gender, id_hash: item.idHash, mobile_hash: item.mobileHash,
      address_hash: item.addressHash, company_hash: item.companyHash
    })));
    await client.query(
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
         FROM input i JOIN inserted_people p USING(identity_key)
         ON CONFLICT (raw_record_id) DO NOTHING RETURNING raw_record_id, person_id, id_hash
       ), identifiers AS (
       INSERT INTO core.identifier(person_id, kind, value_hash, masked_value, valid, source_record_id)
       SELECT person_id, 'chinese_id', id_hash, '******************', true, raw_record_id FROM observations WHERE id_hash IS NOT NULL
       ON CONFLICT (person_id, kind, value_hash, source_record_id) DO NOTHING
       ), checkpointed AS (
         INSERT INTO ingest.projection_checkpoint(
           source_file_id, stage, last_raw_record_id, processed_rows, state, updated_at, completed_at
         ) VALUES ($2, 'people', $3::bigint, $4::bigint, 'running', now(), NULL)
         ON CONFLICT (source_file_id, stage) DO UPDATE SET
           last_raw_record_id = GREATEST(ingest.projection_checkpoint.last_raw_record_id, EXCLUDED.last_raw_record_id),
           processed_rows = ingest.projection_checkpoint.processed_rows + EXCLUDED.processed_rows,
           state = 'running', updated_at = now(), completed_at = NULL
         RETURNING last_raw_record_id
       )
       SELECT last_raw_record_id::text FROM checkpointed`,
      [payload, sourceFileId, lastRawRecordId, candidates.length]
    );
  }

  private async completeStage(client: DatabaseClient, sourceFileId: string, stage: string, cursor: string): Promise<void> {
    await client.query(
      `INSERT INTO ingest.projection_checkpoint(
         source_file_id, stage, last_raw_record_id, processed_rows, state, updated_at, completed_at
       ) VALUES ($1, $2, $3::bigint, 0, 'complete', now(), now())
       ON CONFLICT (source_file_id, stage) DO UPDATE SET
         last_raw_record_id = GREATEST(ingest.projection_checkpoint.last_raw_record_id, EXCLUDED.last_raw_record_id),
         state = 'complete', updated_at = now(), completed_at = now()`,
      [sourceFileId, stage, cursor]
    );
  }

  private async materializeRelationships(client: DatabaseClient, sourceFileId: string): Promise<void> {
    for (const stage of RELATION_STAGES) await this.materializeRelationshipStage(client, sourceFileId, stage);
  }

  private async materializeRelationshipStage(
    client: DatabaseClient,
    sourceFileId: string,
    stage: RelationStage
  ): Promise<void> {
    const checkpoint = await client.query(
      `SELECT last_raw_record_id::text
       FROM ingest.projection_checkpoint
       WHERE source_file_id = $1 AND stage = $2`,
      [sourceFileId, stage.stage]
    );
    let cursor = String(checkpoint.rows[0]?.last_raw_record_id ?? "0");
    try {
      while (true) {
        const result = await client.query(relationshipBatchSql(stage), [sourceFileId, cursor, this.relationBatchSize]);
        const processedRows = Number(result.rows[0]?.processed_rows ?? 0);
        if (!Number.isSafeInteger(processedRows) || processedRows < 0) {
          throw new Error(`invalid ${stage.stage} projection batch count`);
        }
        if (processedRows === 0) {
          await this.completeStage(client, sourceFileId, stage.stage, cursor);
          console.info(JSON.stringify({ event: "projection_stage_complete", sourceFileId, stage: stage.stage, cursor }));
          return;
        }
        const nextCursor = String(result.rows[0]?.last_raw_record_id ?? "");
        if (!/^\d+$/.test(nextCursor) || BigInt(nextCursor) <= BigInt(cursor)) {
          throw new Error(`${stage.stage} projection cursor did not advance`);
        }
        cursor = nextCursor;
        console.info(JSON.stringify({ event: "projection_batch_complete", sourceFileId, stage: stage.stage, cursor, processedRows }));
      }
    } catch (error) {
      await client.query(
        `INSERT INTO ingest.projection_checkpoint(source_file_id, stage, last_raw_record_id, processed_rows, state)
         VALUES ($1, $2, $3::bigint, 0, 'failed')
         ON CONFLICT (source_file_id, stage) DO UPDATE SET state = 'failed', updated_at = now(), completed_at = NULL`,
        [sourceFileId, stage.stage, cursor]
      );
      throw error;
    }
  }
}
