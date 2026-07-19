import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PostgreSQL schema", () => {
  it("separates immutable observations, entities, evidence, projection and audit", async () => {
    const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
    for (const schema of ["ingest", "raw", "core", "evidence", "projection", "review", "audit"]) {
      expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    }
    expect(sql).toContain("UNIQUE (approved_root, relative_path, sha256)");
    expect(sql).toContain("source_row_number BIGINT NOT NULL");
    expect(sql).toContain("algorithm_version TEXT NOT NULL");
  });
});
