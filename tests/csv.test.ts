import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rowsFromCsv } from "../src/ingest/csv.js";

describe("CSV adapter", () => {
  it("streams quoted Chinese rows with provenance", async () => {
    const root = join(process.cwd(), "data", "test-csv");
    await mkdir(root, { recursive: true });
    const path = join(root, "people.csv");
    await writeFile(path, "Name,Address,Mobile\n张三,\"南京市,鼓楼区\",13800138000\n", "utf8");
    const rows = [];
    for await (const row of rowsFromCsv(path, "file-2")) rows.push(row);
    expect(rows).toEqual([{ sourceFileId: "file-2", sheetName: "people", sourceRowNumber: 2,
      values: { Name: "张三", Address: "南京市,鼓楼区", Mobile: "13800138000" } }]);
  });
});
