import { rowsFromWorkbook, type RowEnvelope } from "./workbook.js";

export type ImportSink = {
  checkpoint(sourceFileId: string, sheetName: string): Promise<number>;
  insertRows(rows: RowEnvelope[]): Promise<void>;
  saveCheckpoint(sourceFileId: string, sheetName: string, lastSourceRow: number): Promise<void>;
};

export async function importXlsx(path: string, sourceFileId: string, sink: ImportSink, batchSize = 2_000): Promise<{ importedRows: number; lastSourceRow: number }> {
  if (batchSize <= 0) throw new Error("batchSize must be positive");
  const checkpoints = new Map<string, number>();
  const batches = new Map<string, RowEnvelope[]>();
  let importedRows = 0;
  let lastSourceRow = 0;
  for await (const row of rowsFromWorkbook(path, sourceFileId)) {
    let checkpoint = checkpoints.get(row.sheetName);
    if (checkpoint === undefined) {
      checkpoint = await sink.checkpoint(sourceFileId, row.sheetName);
      checkpoints.set(row.sheetName, checkpoint);
    }
    if (row.sourceRowNumber <= checkpoint) continue;
    const batch = batches.get(row.sheetName) ?? [];
    batch.push(row);
    batches.set(row.sheetName, batch);
    if (batch.length >= batchSize) {
      await flush(sourceFileId, row.sheetName, batch, sink);
      importedRows += batch.length;
      lastSourceRow = Math.max(lastSourceRow, row.sourceRowNumber);
      batches.set(row.sheetName, []);
    }
  }
  for (const [sheetName, batch] of batches) {
    if (!batch.length) continue;
    await flush(sourceFileId, sheetName, batch, sink);
    importedRows += batch.length;
    lastSourceRow = Math.max(lastSourceRow, batch.at(-1)?.sourceRowNumber ?? 0);
  }
  return { importedRows, lastSourceRow };
}

async function flush(sourceFileId: string, sheetName: string, rows: RowEnvelope[], sink: ImportSink): Promise<void> {
  await sink.insertRows(rows);
  await sink.saveCheckpoint(sourceFileId, sheetName, rows.at(-1)?.sourceRowNumber ?? 0);
}
