import { describe, expect, it, vi } from "vitest";
import { PgRelationshipService } from "../src/db/relationship-service.js";

describe("PostgreSQL relationship service", () => {
  it("returns the strongest shortest path with evidence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] })
      .mockResolvedValueOnce({ rows: [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }] })
      .mockResolvedValueOnce({ rows: [{ edge_ids: ["e1", "e2"], depth: 2, strength: "0.72" }] })
      .mockResolvedValueOnce({ rows: [{ explanation: "共同家庭编号" }, { explanation: "共用私人联系方式" }] });
    const service = new PgRelationshipService({ query });
    const result = await service.query("张三", "李四");
    expect(result).toMatchObject({ relationType: "indirect_association", confidence: 0.72,
      evidence: ["共同家庭编号", "共用私人联系方式"] });
    expect(query.mock.calls[3]?.[0]).toContain("ev.algorithm_version = rel.algorithm_version");
  });

  it("does not guess when a name resolves to multiple people", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] });
    const service = new PgRelationshipService({ query });
    await expect(service.query("张三", "李四")).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
});
