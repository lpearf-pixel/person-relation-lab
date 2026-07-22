import { describe, expect, it, vi } from "vitest";
import { FIND_PATHS_SQL, PgImportSink } from "../src/db/repository.js";

describe("PostgreSQL repository", () => {
  it("reads and upserts sheet checkpoints", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ last_source_row: "42" }] }).mockResolvedValue({ rows: [] });
    const sink = new PgImportSink({ query });
    await expect(sink.checkpoint("11111111-1111-1111-1111-111111111111", "人员")).resolves.toBe(42);
    await sink.saveCheckpoint("11111111-1111-1111-1111-111111111111", "人员", 50);
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (source_file_id, sheet_name)");
  });

  it("bulk inserts immutable source rows as JSON", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const sink = new PgImportSink({ query });
    await sink.insertRows([{ sourceFileId: "11111111-1111-1111-1111-111111111111", sheetName: "人员", sourceRowNumber: 2, values: { Name: "张三", Address: null } }]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("jsonb_to_recordset");
    expect(query.mock.calls[0]?.[1]?.[0]).toContain('"Address":null');
  });

  it("bounds recursive paths to four hops and prevents cycles", () => {
    expect(FIND_PATHS_SQL).toContain("WITH RECURSIVE");
    expect(FIND_PATHS_SQL).toContain("path.depth < 4");
    expect(FIND_PATHS_SQL).toContain("NOT next_person = ANY(path.visited)");
    expect(FIND_PATHS_SQL).toContain("ROW_NUMBER() OVER");
    expect(FIND_PATHS_SQL).toContain("WHEN 'relation-v3' THEN 0");
    expect(FIND_PATHS_SQL).toContain("edge_rank = 1");
  });
});
