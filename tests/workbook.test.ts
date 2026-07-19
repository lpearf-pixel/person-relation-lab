import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { rowsFromWorkbook } from "../src/ingest/workbook.js";

describe("workbook adapter", () => {
  it("streams xlsx rows with source provenance and missing address", async () => {
    const root = join(process.cwd(), "data", "test-workbook");
    await mkdir(root, { recursive: true });
    const path = join(root, "people.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("人员");
    sheet.addRow(["CardNo", "CtfId", "Birthday", "Address", "Mobile"]);
    sheet.addRow(["C001", "11010519491231002X", "19491231", null, "13800138000"]);
    await workbook.xlsx.writeFile(path);

    const rows = [];
    for await (const row of rowsFromWorkbook(path, "file-1")) rows.push(row);

    expect(rows).toEqual([{
      sourceFileId: "file-1",
      sheetName: "人员",
      sourceRowNumber: 2,
      values: { CardNo: "C001", CtfId: "11010519491231002X", Birthday: "19491231", Address: null, Mobile: "13800138000" }
    }]);
  });
});
