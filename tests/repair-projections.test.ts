import { describe, expect, it, vi } from "vitest";
import { repairRegisteredSources } from "../src/db/repair-projections.js";

describe("registered source projection repair", () => {
  it("projects selected inconsistent sources serially in discovery order", async () => {
    const database = {
      query: vi.fn().mockResolvedValueOnce({ rows: [
        { id: "source-a", relative_path: "a.csv" },
        { id: "source-b", relative_path: "b.csv" }
      ] }),
      connect: vi.fn()
    };
    const order: string[] = [];
    const projector = { projectSource: vi.fn(async (sourceFileId: string) => {
      order.push(sourceFileId);
      return { projectedRecords: sourceFileId === "source-a" ? 10 : 20 };
    }) };

    await expect(repairRegisteredSources(database, {
      projectionBatchSize: 100,
      relationBatchSize: 25,
      projectorFactory: () => projector
    })).resolves.toEqual({ selectedSources: 2, completedSources: 2, projectedRecords: 30 });

    expect(order).toEqual(["source-a", "source-b"]);
    expect(projector.projectSource).toHaveBeenCalledTimes(2);
  });

  it("audits the first failure and stops before the next source", async () => {
    const database = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [
          { id: "source-a", relative_path: "a.csv" },
          { id: "source-b", relative_path: "b.csv" }
        ] })
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn()
    };
    const projector = { projectSource: vi.fn().mockRejectedValue(new Error("disk failure")) };

    await expect(repairRegisteredSources(database, {
      projectionBatchSize: 100,
      relationBatchSize: 25,
      projectorFactory: () => projector
    })).rejects.toThrow("disk failure");

    expect(projector.projectSource).toHaveBeenCalledOnce();
    const auditCall = database.query.mock.calls.find((call) => String(call[0]).includes("projection_failed"));
    expect(auditCall?.[1]).toEqual(["source-a", "disk failure"]);
  });
});
