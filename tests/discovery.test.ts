import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles, isStable } from "../src/ingest/discovery.js";

describe("directory discovery", () => {
  it("recurses and ignores hidden, lock, and unsupported files", async () => {
    const root = join(process.cwd(), "data", "test-discovery");
    await mkdir(join(root, "batch"), { recursive: true });
    await writeFile(join(root, "batch", "people.xlsx"), "ready");
    await writeFile(join(root, "batch", "~$people.xlsx"), "lock");
    await writeFile(join(root, "batch", ".hidden.xlsx"), "hidden");
    await writeFile(join(root, "batch", "notes.txt"), "ignore");

    const files = await discoverFiles(root);
    expect(files.map((file) => file.relativePath)).toEqual(["batch/people.xlsx"]);
  });

  it("requires unchanged size and mtime for the full settling period", () => {
    const previous = { size: 300, mtimeMs: 100, observedAtMs: 1_000 };
    expect(isStable(previous, { ...previous, observedAtMs: 30_000 }, 60_000)).toBe(false);
    expect(isStable(previous, { ...previous, observedAtMs: 62_000 }, 60_000)).toBe(true);
    expect(isStable(previous, { size: 301, mtimeMs: 101, observedAtMs: 62_000 }, 60_000)).toBe(false);
  });
});
