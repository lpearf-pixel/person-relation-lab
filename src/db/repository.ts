import type { RowEnvelope } from "../ingest/workbook.js";
import type { ImportSink } from "../ingest/pipeline.js";

export type QueryResult = { rows: Array<Record<string, unknown>> };
export type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };

export class PgImportSink implements ImportSink {
  constructor(private readonly database: Queryable) {}

  async checkpoint(sourceFileId: string, sheetName: string): Promise<number> {
    const result = await this.database.query(
      "SELECT last_source_row FROM ingest.import_checkpoint WHERE source_file_id = $1 AND sheet_name = $2",
      [sourceFileId, sheetName]
    );
    return Number(result.rows[0]?.last_source_row ?? 0);
  }

  async insertRows(rows: RowEnvelope[]): Promise<void> {
    if (!rows.length) return;
    const payload = JSON.stringify(rows.map((row) => ({
      source_file_id: row.sourceFileId,
      sheet_name: row.sheetName,
      source_row_number: row.sourceRowNumber,
      values: row.values
    })));
    await this.database.query(
      `INSERT INTO raw.record (source_file_id, sheet_name, source_row_number, values)
       SELECT source_file_id, sheet_name, source_row_number, values
       FROM jsonb_to_recordset($1::jsonb) AS item(
         source_file_id uuid, sheet_name text, source_row_number bigint, values jsonb
       )
       ON CONFLICT (source_file_id, sheet_name, source_row_number) DO NOTHING`,
      [payload]
    );
  }

  async saveCheckpoint(sourceFileId: string, sheetName: string, lastSourceRow: number): Promise<void> {
    await this.database.query(
      `INSERT INTO ingest.import_checkpoint (source_file_id, sheet_name, last_source_row, state)
       VALUES ($1, $2, $3, 'importing')
       ON CONFLICT (source_file_id, sheet_name) DO UPDATE
       SET last_source_row = GREATEST(ingest.import_checkpoint.last_source_row, EXCLUDED.last_source_row),
           state = EXCLUDED.state, updated_at = now()`,
      [sourceFileId, sheetName, lastSourceRow]
    );
  }
}

export const FIND_PATHS_SQL = `
WITH RECURSIVE edges AS (
  SELECT id, person_a_id, person_b_id, relation_type, confidence
  FROM projection.relationship WHERE status IN ('observed','inferred','confirmed')
  UNION ALL
  SELECT id, person_b_id, person_a_id, relation_type, confidence
  FROM projection.relationship WHERE status IN ('observed','inferred','confirmed')
), path AS (
  SELECT person_b_id AS current_person, ARRAY[person_a_id, person_b_id] AS visited,
         ARRAY[id] AS edge_ids, 1 AS depth, confidence::numeric AS strength
  FROM edges WHERE person_a_id = $1
  UNION ALL
  SELECT next_person, path.visited || next_person, path.edge_ids || edges.id,
         path.depth + 1, path.strength * edges.confidence
  FROM path JOIN edges ON edges.person_a_id = path.current_person
  CROSS JOIN LATERAL (SELECT edges.person_b_id AS next_person) AS next
  WHERE path.depth < 4 AND NOT next_person = ANY(path.visited)
)
SELECT edge_ids, depth, strength FROM path WHERE current_person = $2
ORDER BY depth ASC, strength DESC LIMIT $3`;
