import type { ConnectableDatabase, DatabaseClient } from "./repository.js";
import { NORMALIZER_VERSION } from "../domain/normalized-value.js";
import { PROFILE_CHANNELS, profileBucketSql, type ProfileChannel } from "./secondary-processing-sql.js";

const PROFILE_PIPELINE_NAME = "secondary-value-profile";
const HASH_PREFIXES = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));
const ALL_CHANNELS = Object.keys(PROFILE_CHANNELS) as ProfileChannel[];

export class PgValueProfiler {
  constructor(
    private readonly database: ConnectableDatabase,
    private readonly prefixes: readonly string[] = HASH_PREFIXES,
    private readonly channels: readonly ProfileChannel[] = ALL_CHANNELS
  ) {
    if (!prefixes.length || prefixes.some((prefix) => !/^[0-9a-f]{2}$/u.test(prefix))) {
      throw new Error("profile prefixes must be lowercase two-digit hexadecimal values");
    }
    if (!channels.length) throw new Error("at least one profile channel is required");
  }

  async rebuild(normalizerVersion = NORMALIZER_VERSION): Promise<{ profiledValues: number }> {
    const client = await this.database.connect();
    const lockKey = `${PROFILE_PIPELINE_NAME}:${normalizerVersion}`;
    let locked = false;
    try {
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [lockKey]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new Error(`value profiling already running for ${normalizerVersion}`);

      await this.verifyCoverage(client, normalizerVersion);
      const completed = await this.completedStages(client, normalizerVersion);
      let profiledValues = 0;
      for (const channel of this.channels) {
        for (const prefix of this.prefixes) {
          const stage = profileStage(channel, prefix);
          if (completed.has(stage)) continue;
          profiledValues += await this.profileBucket(client, normalizerVersion, channel, prefix, stage);
        }
      }
      return { profiledValues };
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [lockKey]);
      client.release();
    }
  }

  private async verifyCoverage(client: DatabaseClient, normalizerVersion: string): Promise<void> {
    const result = await client.query(
      `WITH source_coverage AS (
         SELECT f.id,
           COUNT(DISTINCT r.id)::bigint AS raw_records,
           COUNT(DISTINCT o.raw_record_id)::bigint AS projected_records,
           COUNT(DISTINCT n.raw_record_id)::bigint AS normalized_records,
           BOOL_OR(c.state = 'complete') AS checkpoint_complete
         FROM ingest.source_file f
         LEFT JOIN raw.record r ON r.source_file_id = f.id
         LEFT JOIN core.person_observation o ON o.raw_record_id = r.id
         LEFT JOIN analytics.normalized_observation n
           ON n.raw_record_id = r.id AND n.normalizer_version = $1
         LEFT JOIN ingest.processing_checkpoint c
           ON c.pipeline_name = 'secondary-normalization'
          AND c.pipeline_version = $1
          AND c.source_file_id = f.id
          AND c.stage = 'observations'
         WHERE f.state = 'complete'
         GROUP BY f.id
       )
       SELECT COUNT(*) FILTER (WHERE NOT checkpoint_complete)::text AS incomplete_sources,
         COUNT(*) FILTER (
           WHERE raw_records <> projected_records OR raw_records <> normalized_records
         )::text AS mismatched_sources
       FROM source_coverage`,
      [normalizerVersion]
    );
    const incompleteSources = parseCount(result.rows[0]?.incomplete_sources);
    const mismatchedSources = parseCount(result.rows[0]?.mismatched_sources);
    if (incompleteSources || mismatchedSources) {
      throw new Error(
        `normalized source coverage is incomplete: checkpoints=${incompleteSources}, mismatches=${mismatchedSources}`
      );
    }
  }

  private async completedStages(client: DatabaseClient, normalizerVersion: string): Promise<Set<string>> {
    const result = await client.query(
      `SELECT stage FROM ingest.processing_checkpoint
       WHERE pipeline_name = $1 AND pipeline_version = $2
         AND source_file_id IS NULL AND state = 'complete'`,
      [PROFILE_PIPELINE_NAME, normalizerVersion]
    );
    return new Set(result.rows.map((row) => String(row.stage)));
  }

  private async profileBucket(
    client: DatabaseClient,
    normalizerVersion: string,
    channel: ProfileChannel,
    prefix: string,
    stage: string
  ): Promise<number> {
    await client.query("BEGIN");
    try {
      const result = await client.query(profileBucketSql(channel), [
        normalizerVersion,
        prefix,
        channel,
        PROFILE_PIPELINE_NAME,
        stage
      ]);
      const profiledValues = parseCount(result.rows[0]?.profiled_values ?? 0);
      await client.query("COMMIT");
      return profiledValues;
    } catch (error) {
      await client.query("ROLLBACK");
      await this.markBucketFailed(client, normalizerVersion, stage);
      throw error;
    }
  }

  private async markBucketFailed(client: DatabaseClient, normalizerVersion: string, stage: string): Promise<void> {
    try {
      await client.query(
        `INSERT INTO ingest.processing_checkpoint(
           pipeline_name, pipeline_version, source_file_id, stage,
           last_raw_record_id, processed_rows, state, last_error_code, updated_at, completed_at
         ) VALUES ($1, $2, NULL, $3, 0, 0, 'failed', 'profile_bucket_failed', now(), NULL)
         ON CONFLICT ON CONSTRAINT processing_checkpoint_scope_uq DO UPDATE SET
           state = 'failed', last_error_code = 'profile_bucket_failed', updated_at = now(), completed_at = NULL`,
        [PROFILE_PIPELINE_NAME, normalizerVersion, stage]
      );
    } catch {
      // Preserve the original bucket error.
    }
  }
}

function profileStage(channel: ProfileChannel, prefix: string): string {
  return `profile:${channel}:${prefix}`;
}

function parseCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("value profile returned an invalid count");
  return count;
}
