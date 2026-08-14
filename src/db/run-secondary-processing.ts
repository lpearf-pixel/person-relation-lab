import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { ConnectableDatabase } from "./repository.js";
import { PgSecondaryProcessingBuilder } from "./secondary-processing-builder.js";
import { PgValueProfiler } from "./value-profiler.js";

type SecondaryBuilder = {
  processSource(sourceFileId: string): Promise<{ processedRecords: number }>;
};

type Profiler = {
  rebuild(): Promise<{ profiledValues: number }>;
};

export type SecondaryRunSummary = {
  selectedSources: number;
  completedSources: number;
  processedRecords: number;
  profiledValues: number;
};

export type SecondaryRunOptions = {
  pageSize: number;
  builderFactory?: (database: ConnectableDatabase, pageSize: number) => SecondaryBuilder;
  profilerFactory?: (database: ConnectableDatabase) => Profiler;
};

export async function runSecondaryProcessing(
  database: ConnectableDatabase,
  options: SecondaryRunOptions
): Promise<SecondaryRunSummary> {
  const selected = await database.query(
    `SELECT id::text, relative_path
     FROM ingest.source_file
     WHERE state = 'complete'
     ORDER BY discovered_at, id`
  );
  const builder = options.builderFactory
    ? options.builderFactory(database, options.pageSize)
    : new PgSecondaryProcessingBuilder(database, options.pageSize);
  const profiler = options.profilerFactory
    ? options.profilerFactory(database)
    : new PgValueProfiler(database);

  let completedSources = 0;
  let processedRecords = 0;
  for (const row of selected.rows) {
    const sourceFileId = String(row.id);
    const relativePath = String(row.relative_path);
    console.info(JSON.stringify({ event: "SECONDARY_SOURCE_START", sourceFileId, relativePath }));
    try {
      const result = await builder.processSource(sourceFileId);
      completedSources += 1;
      processedRecords += result.processedRecords;
      console.info(JSON.stringify({
        event: "SECONDARY_SOURCE_COMPLETE",
        sourceFileId,
        relativePath,
        processedRecords: result.processedRecords
      }));
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : "secondary_processing_error";
      console.error(JSON.stringify({ event: "SECONDARY_SOURCE_FAILED", sourceFileId, relativePath, errorCode }));
      throw error;
    }
  }

  const profile = await profiler.rebuild();
  return {
    selectedSources: selected.rows.length,
    completedSources,
    processedRecords,
    profiledValues: profile.profiledValues
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pageSize = positiveInteger("SECONDARY_BATCH_SIZE", 2_000);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    application_name: "person-relation-secondary-processing"
  });
  try {
    const summary = await runSecondaryProcessing(pool, { pageSize });
    console.info(JSON.stringify({ event: "SECONDARY_PROCESSING_COMPLETE", ...summary }));
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
