import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("local API", () => {
  it("serves the local operator console", async () => {
    const app = buildApp({ listImports: async () => ({ roots: [], files: [] }), queryRelationship: async () => null });
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("关系证据工作台");
    await app.close();
  });
  it("reports health and masks the approved directory boundary", async () => {
    const app = buildApp({
      listImports: async () => ({ roots: ["/imports"], files: [{ path: "batch/people.xlsx", state: "ready", size: 300 }] }),
      queryRelationship: async () => null
    });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    const status = await app.inject({ method: "GET", url: "/api/v1/imports/status" });
    expect(health.json()).toEqual({ status: "ok" });
    expect(status.json()).toMatchObject({ roots: ["/imports"] });
    await app.close();
  });

  it("returns evidence-backed relationship results", async () => {
    const app = buildApp({
      listImports: async () => ({ roots: [], files: [] }),
      queryRelationship: async () => ({
        relationType: "possible_partner_association", confidence: 0.82, completeness: 0.55,
        evidence: ["共同家庭编号", "共用私人联系方式"], disclaimer: "不能证明恋爱或婚外关系"
      })
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/relations/query", payload: { personA: "张三", personB: "李四" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ relationType: "possible_partner_association", disclaimer: expect.stringContaining("不能证明") });
    await app.close();
  });

  it("rejects empty or identical people", async () => {
    const app = buildApp({ listImports: async () => ({ roots: [], files: [] }), queryRelationship: async () => null });
    const response = await app.inject({ method: "POST", url: "/api/v1/relations/query", payload: { personA: "张三", personB: "张三" } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
