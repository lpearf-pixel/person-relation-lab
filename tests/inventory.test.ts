import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileInventory, hashFile } from "../src/ingest/inventory.js";

describe("file inventory", () => {
  it("streams stable SHA-256 so renamed copies deduplicate", async () => {
    const root = join(process.cwd(), "data", "test-hash");
    await mkdir(root, { recursive: true });
    const first = join(root, "a.xlsx");
    const renamed = join(root, "renamed.xlsx");
    await writeFile(first, "same content");
    await writeFile(renamed, "same content");
    expect(await hashFile(first)).toBe(await hashFile(renamed));
  });

  it("queues only unchanged files after the settling period", () => {
    const inventory = new FileInventory(60_000);
    expect(inventory.observe("a.xlsx", { size: 300, mtimeMs: 100, observedAtMs: 1_000 })).toBe("settling");
    expect(inventory.observe("a.xlsx", { size: 300, mtimeMs: 100, observedAtMs: 30_000 })).toBe("settling");
    expect(inventory.observe("a.xlsx", { size: 300, mtimeMs: 100, observedAtMs: 62_000 })).toBe("ready");
    expect(inventory.drainReady()).toEqual(["a.xlsx"]);
    expect(inventory.drainReady()).toEqual([]);
  });
});
