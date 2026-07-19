import { describe, expect, it, vi } from "vitest";
import { PgProjectionBuilder } from "../src/db/projection-builder.js";

describe("person and relationship projection", () => {
  it("pages raw records and bulk materializes normalized candidates", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "10", values: { Descriot: "张三", Birthday: "19900102", Mobile: "13800138000" } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });
    const builder = new PgProjectionBuilder({ query }, 100);
    await expect(builder.projectSource("11111111-1111-1111-1111-111111111111")).resolves.toEqual({ projectedRecords: 1 });
    expect(query.mock.calls.some((call) => String(call[0]).includes("jsonb_to_recordset"))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes("relationship_evidence"))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes("CROSS JOIN LATERAL"))).toBe(true);
  });
});
