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

  it("adds indexed person observations for incremental relationship projection", async () => {
    const sql = await readFile(new URL("../migrations/002_projection.sql", import.meta.url), "utf8");
    expect(sql).toContain("core.person_observation");
    expect(sql).toContain("person_observation_mobile_idx");
    expect(sql).toContain("relationship_unique_projection");
  });

  it("indexes bounded relationship evidence lookups", async () => {
    const sql = await readFile(new URL("../migrations/003_relation_indexes.sql", import.meta.url), "utf8");
    expect(sql).toContain("relationship_evidence_a_algorithm_idx");
    expect(sql).toContain("relationship_evidence_b_algorithm_idx");
  });
});
