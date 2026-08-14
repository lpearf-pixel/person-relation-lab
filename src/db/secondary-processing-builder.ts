import type { ConnectableDatabase, DatabaseClient } from "./repository.js";
import { NORMALIZER_VERSION } from "../domain/normalized-value.js";
import { normalizeSecondaryRecord, type SecondaryNormalizedRecord } from "../domain/secondary-record-normalizer.js";
import {
  SECONDARY_COVERAGE_SQL,
  SECONDARY_PIPELINE_NAME,
  SECONDARY_STAGE,
  UPSERT_NORMALIZED_OBSERVATIONS_SQL
} from "./secondary-processing-sql.js";

export class PgSecondaryProcessingBuilder {
  constructor(
    private readonly database: ConnectableDatabase,
    private readonly pageSize = 2_000
  ) {
    if (pageSize <= 0) throw new Error("pageSize must be positive");
  }

  async processSource(sourceFileId: string): Promise<{ processedRecords: number }> {
    const client = await this.database.connect();
    const lockKey = `${SECONDARY_PIPELINE_NAME}:${NORMALIZER_VERSION}:${sourceFileId}`;
    let locked = false;
    try {
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [lockKey]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new Error(`secondary processing already running for source ${sourceFileId}`);

      const checkpoint = await client.query(
        `SELECT last_raw_record_id::text, processed_rows::text
         FROM ingest.processing_checkpoint
         WHERE pipeline_name = $1 AND pipeline_version = $2
           AND source_file_id = $3 AND stage = $4`,
        [SECONDARY_PIPELINE_NAME, NORMALIZER_VERSION, sourceFileId, SECONDARY_STAGE]
      );
      let cursor = String(checkpoint.rows[0]?.last_raw_record_id ?? "0");

      while (true) {
        const page = await client.query(
          `SELECT r.id::text, o.person_id::text, r.values
           FROM raw.record r
           JOIN core.person_observation o ON o.raw_record_id = r.id
           WHERE r.source_file_id = $1 AND r.id > $2::bigint
           ORDER BY r.id LIMIT $3`,
          [sourceFileId, cursor, this.pageSize]
        );
        if (!page.rows.length) break;

        const candidates = page.rows.map((row) => normalizeSecondaryRecord(
          String(row.id), String(row.person_id), sourceFileId, row.values as Record<string, unknown>
        ));
        const nextCursor = String(page.rows.at(-1)?.id);
        await this.writeBatch(client, sourceFileId, nextCursor, candidates);
        cursor = nextCursor;
      }

      const processedRecords = await this.verifyAndComplete(client, sourceFileId);
      return { processedRecords };
    } catch (error) {
      if (locked) await this.markFailed(client, sourceFileId);
      throw error;
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [lockKey]);
      client.release();
    }
  }

  private async writeBatch(
    client: DatabaseClient,
    sourceFileId: string,
    lastRawRecordId: string,
    candidates: SecondaryNormalizedRecord[]
  ): Promise<void> {
    const payload = JSON.stringify(candidates.map((candidate) => ({
      raw_record_id: candidate.rawRecordId,
      person_id: candidate.personId,
      source_file_id: candidate.sourceFileId,
      normalizer_version: candidate.normalizerVersion,
      name_hash: candidate.nameHash,
      mobile_hash: candidate.mobileHash,
      email_hash: candidate.emailHash,
      address_hash: candidate.addressHash,
      address_region_hash: candidate.addressRegionHash,
      address_detail_level: candidate.addressDetailLevel,
      organization_hash: candidate.organizationHash,
      department_hash: candidate.departmentHash,
      quality_flags: candidate.qualityFlags
    })));

    await client.query("BEGIN");
    try {
      await client.query(UPSERT_NORMALIZED_OBSERVATIONS_SQL, [
        payload,
        SECONDARY_PIPELINE_NAME,
        NORMALIZER_VERSION,
        sourceFileId,
        SECONDARY_STAGE,
        lastRawRecordId,
        candidates.length
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private async verifyAndComplete(client: DatabaseClient, sourceFileId: string): Promise<number> {
    const result = await client.query(SECONDARY_COVERAGE_SQL, [sourceFileId, NORMALIZER_VERSION]);
    const rawRecords = parseCount(result.rows[0]?.raw_records);
    const projectedRecords = parseCount(result.rows[0]?.projected_records);
    const normalizedRecords = parseCount(result.rows[0]?.normalized_records);
    if (rawRecords !== projectedRecords || rawRecords !== normalizedRecords) {
      throw new Error(
        `secondary normalization incomplete for source ${sourceFileId}: raw=${rawRecords}, projected=${projectedRecords}, normalized=${normalizedRecords}`
      );
    }

    await client.query(
      `INSERT INTO ingest.processing_checkpoint(
         pipeline_name, pipeline_version, source_file_id, stage,
         last_raw_record_id, processed_rows, state, last_error_code, updated_at, completed_at
       ) VALUES ($1, $2, $3, $4,
         COALESCE((SELECT MAX(id) FROM raw.record WHERE source_file_id = $3), 0),
         $5, 'complete', NULL, now(), now())
       ON CONFLICT ON CONSTRAINT processing_checkpoint_scope_uq DO UPDATE SET
         last_raw_record_id = GREATEST(ingest.processing_checkpoint.last_raw_record_id, EXCLUDED.last_raw_record_id),
         state = 'complete', last_error_code = NULL, updated_at = now(), completed_at = now()`,
      [SECONDARY_PIPELINE_NAME, NORMALIZER_VERSION, sourceFileId, SECONDARY_STAGE, normalizedRecords]
    );
    return normalizedRecords;
  }

  private async markFailed(client: DatabaseClient, sourceFileId: string): Promise<void> {
    try {
      await client.query(
        `INSERT INTO ingest.processing_checkpoint(
           pipeline_name, pipeline_version, source_file_id, stage,
           last_raw_record_id, processed_rows, state, last_error_code, updated_at, completed_at
         ) VALUES ($1, $2, $3, $4, 0, 0, 'failed', 'secondary_processing_failed', now(), NULL)
         ON CONFLICT ON CONSTRAINT processing_checkpoint_scope_uq DO UPDATE SET
           state = 'failed', last_error_code = 'secondary_processing_failed', updated_at = now(), completed_at = NULL`,
        [SECONDARY_PIPELINE_NAME, NORMALIZER_VERSION, sourceFileId, SECONDARY_STAGE]
      );
    } catch {
      // Preserve the original processing error if recording the safe status also fails.
    }
  }
}

function parseCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("secondary coverage returned an invalid count");
  return count;
}
