import { describe, expect, it, vi } from "vitest";
import { AutoImportWorker } from "../src/ingest/worker.js";

describe("automatic directory importer", () => {
  it("waits for an unchanged scan, then registers and imports exactly once", async () => {
    const file = { path: "/imports/a.csv", relativePath: "a.csv", size: 10, mtimeMs: 100 };
    const registry = {
      register: vi.fn(async () => ({ id: "source-1", state: "ready" as const })),
      markComplete: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined)
    };
    const importer = vi.fn(async () => ({ importedRows: 2, lastSourceRow: 3 }));
    let now = 1_000;
    const worker = new AutoImportWorker(["/imports"], registry, importer, { settleMs: 500, now: () => now, hash: async () => "a".repeat(64) });
    await worker.scanFiles(async () => [file]);
    expect(importer).not.toHaveBeenCalled();
    now = 1_600;
    await worker.scanFiles(async () => [file]);
    expect(registry.register).toHaveBeenCalledWith("/imports", file, expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(importer).toHaveBeenCalledWith(file.path, "source-1");
    expect(registry.markComplete).toHaveBeenCalledWith("source-1", 2);
    now = 2_200;
    await worker.scanFiles(async () => [file]);
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
