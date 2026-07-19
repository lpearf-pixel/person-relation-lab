import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { importXlsx, type ImportSink } from "../src/ingest/pipeline.js";

describe("resumable import pipeline", () => {
  it("batches immutable rows and resumes after a checkpoint", async () => {
    const root = join(process.cwd(), "data", "test-pipeline");
    await mkdir(root, { recursive: true });
    const path = join(root, "people.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("人员");
    sheet.addRow(["Name", "Address"]);
    sheet.addRow(["张三", null]);
    sheet.addRow(["李四", "南京"]);
    sheet.addRow(["王五", "上海"]);
    await workbook.xlsx.writeFile(path);

    const inserted: number[] = [];
    const sink: ImportSink = {
      checkpoint: async () => 2,
      insertRows: async (rows) => { inserted.push(...rows.map((row) => row.sourceRowNumber)); },
      saveCheckpoint: async () => undefined
    };
    const result = await importXlsx(path, "file-1", sink, 1);
    expect(inserted).toEqual([3, 4]);
    expect(result).toEqual({ importedRows: 2, lastSourceRow: 4 });
  });
});
