import { describe, expect, it, vi } from "vitest";
import { PgProjectionBuilder } from "../src/db/projection-builder.js";

describe("person and relationship projection", () => {
  it("pages raw records and bulk materializes normalized candidates", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "10", values: { Descriot: "张三", Birthday: "19900102", Mobile: "13800138000" } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ projected_records: "7" }] });
    const builder = new PgProjectionBuilder({ query }, 100);
    await expect(builder.projectSource("11111111-1111-1111-1111-111111111111")).resolves.toEqual({ projectedRecords: 7 });
    expect(query.mock.calls.some((call) => String(call[0]).includes("jsonb_to_recordset"))).toBe(true);
    const candidateSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("jsonb_to_recordset")) ?? "";
    expect(candidateSql).toContain("JOIN inserted_people p USING(identity_key)");
    expect(candidateSql).not.toContain("JOIN core.person p USING(identity_key)");
    expect(query.mock.calls.some((call) => String(call[0]).includes("relationship_evidence"))).toBe(true);
    const relationshipSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("relationship_evidence")) ?? "";
    expect(relationshipSql).toContain("eligible_mobile");
    expect(relationshipSql).toContain("COUNT(DISTINCT o.person_id) BETWEEN 2 AND 5");
    expect(relationshipSql).not.toContain("CROSS JOIN LATERAL");
  });
});
