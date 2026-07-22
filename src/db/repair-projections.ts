import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { PgProjectionBuilder } from "./projection-builder.js";
import type { ConnectableDatabase } from "./repository.js";

type Projector = { projectSource(sourceFileId: string): Promise<{ projectedRecords: number }> };

export type RepairOptions = {
  projectionBatchSize: number;
  relationBatchSize: number;
  projectorFactory?: (database: ConnectableDatabase, projectionBatchSize: number, relationBatchSize: number) => Projector;
};

export type RepairSummary = {
  selectedSources: number;
  completedSources: number;
  projectedRecords: number;
};

export async function repairRegisteredSources(
  database: ConnectableDatabase,
  options: RepairOptions
): Promise<RepairSummary> {
  const selected = await database.query(`
    WITH source_counts AS (
      SELECT f.id, f.relative_path, f.discovered_at,
        (SELECT COUNT(*) FROM raw.record r WHERE r.source_file_id = f.id) AS raw_records,
        (SELECT COUNT(*) FROM core.person_observation o
          JOIN raw.record r ON r.id = o.raw_record_id WHERE r.source_file_id = f.id) AS projected_records,
        (SELECT COUNT(*) FROM ingest.projection_checkpoint c
          WHERE c.source_file_id = f.id
            AND c.stage IN ('people','mobile','address','company')
            AND c.state = 'complete') AS completed_stages
      FROM ingest.source_file f
    )
    SELECT id::text, relative_path
    FROM source_counts
    WHERE raw_records <> projected_records OR completed_stages <> 4
    ORDER BY discovered_at, id
  `);
  const projector = options.projectorFactory
    ? options.projectorFactory(database, options.projectionBatchSize, options.relationBatchSize)
    : new PgProjectionBuilder(database, options.projectionBatchSize, options.relationBatchSize);
  let completedSources = 0;
  let projectedRecords = 0;
  for (const row of selected.rows) {
    const sourceFileId = String(row.id);
    const relativePath = String(row.relative_path);
    console.info(JSON.stringify({ event: "RECOVERY_SOURCE_START", sourceFileId, relativePath }));
    try {
      const result = await projector.projectSource(sourceFileId);
      projectedRecords += result.projectedRecords;
      completedSources += 1;
      console.info(JSON.stringify({
        event: "RECOVERY_SOURCE_COMPLETE", sourceFileId, relativePath,
        projectedRecords: result.projectedRecords
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await database.query(
        `INSERT INTO audit.event(event_type, actor, payload)
         VALUES ('projection_failed', 'projection-repair',
           jsonb_build_object('source_file_id', $1::text, 'reason', $2::text))`,
        [sourceFileId, reason.slice(0, 2_000)]
      );
      console.error(JSON.stringify({ event: "RECOVERY_SOURCE_FAILED", sourceFileId, relativePath, reason }));
      throw error;
    }
  }
  return { selectedSources: selected.rows.length, completedSources, projectedRecords };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const projectionBatchSize = positiveInteger("PROJECTION_BATCH_SIZE", 2_000);
  const relationBatchSize = positiveInteger("RELATION_BATCH_SIZE", 2_000);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, application_name: "person-relation-repair" });
  try {
    const summary = await repairRegisteredSources(pool, { projectionBatchSize, relationBatchSize });
    console.info(JSON.stringify({ event: "RECOVERY_COMPLETE", ...summary }));
  } finally {
    await pool.end();
  }
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
