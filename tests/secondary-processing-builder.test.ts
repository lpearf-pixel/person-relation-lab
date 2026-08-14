import { describe, expect, it, vi } from "vitest";
import { PgSecondaryProcessingBuilder } from "../src/db/secondary-processing-builder.js";
import { UPSERT_NORMALIZED_OBSERVATIONS_SQL } from "../src/db/secondary-processing-sql.js";

const sourceId = "11111111-1111-1111-1111-111111111111";
const personId = "22222222-2222-2222-2222-222222222222";

describe("secondary processing builder", () => {
  it("locks a source, resumes from its committed cursor and verifies coverage", async () => {
    let page = 0;
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM ingest.processing_checkpoint") && text.includes("last_raw_record_id")) {
        return { rows: [{ last_raw_record_id: "10", processed_rows: "0" }] };
      }
      if (text.includes("SELECT r.id::text, o.person_id::text")) {
        page += 1;
        return page === 1
          ? { rows: [{ id: "12", person_id: personId, values: { Descriot: "测试甲", Mobile: "13800138000" } }] }
          : { rows: [] };
      }
      if (text.includes("AS normalized_records")) {
        return { rows: [{ raw_records: "1", projected_records: "1", normalized_records: "1" }] };
      }
      if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgSecondaryProcessingBuilder(database, 100).processSource(sourceId))
      .resolves.toEqual({ processedRecords: 1 });

    const pageCall = query.mock.calls.find((call) => String(call[0]).includes("SELECT r.id::text"));
    expect(pageCall?.[1]).toEqual([sourceId, "10", 100]);
    expect(query.mock.calls.map((call) => call[0])).toContain("BEGIN");
    expect(query.mock.calls.map((call) => call[0])).toContain("COMMIT");
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a failed batch without committing its cursor", async () => {
    let failed = false;
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM ingest.processing_checkpoint") && text.includes("last_raw_record_id")) return { rows: [] };
      if (text.includes("SELECT r.id::text, o.person_id::text")) {
        return { rows: [{ id: "12", person_id: personId, values: { Descriot: "测试乙" } }] };
      }
      if (text.includes("INSERT INTO analytics.normalized_observation") && !failed) {
        failed = true;
        throw new Error("synthetic batch failure");
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgSecondaryProcessingBuilder(database).processSource(sourceId))
      .rejects.toThrow("synthetic batch failure");

    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.includes("last_error_code"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses concurrent processing of the same source", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ locked: false }] });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgSecondaryProcessingBuilder(database).processSource(sourceId))
      .rejects.toThrow(`secondary processing already running for source ${sourceId}`);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("uses one idempotent statement for observations and checkpoint advancement", () => {
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).toContain("jsonb_to_recordset");
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).toContain("INSERT INTO analytics.normalized_observation");
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).toContain("ON CONFLICT (raw_record_id, normalizer_version)");
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).toContain("INSERT INTO ingest.processing_checkpoint");
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).toContain("GREATEST(ingest.processing_checkpoint.last_raw_record_id");
    expect(UPSERT_NORMALIZED_OBSERVATIONS_SQL).not.toContain("relation-v3");
  });

  it.each([
    { raw_records: "2", projected_records: "2", normalized_records: "1" },
    { raw_records: "2", projected_records: "1", normalized_records: "1" }
  ])("rejects incomplete coverage: $raw_records/$projected_records/$normalized_records", async (coverage) => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM ingest.processing_checkpoint") && text.includes("last_raw_record_id")) return { rows: [] };
      if (text.includes("SELECT r.id::text, o.person_id::text")) return { rows: [] };
      if (text.includes("AS normalized_records")) return { rows: [coverage] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgSecondaryProcessingBuilder(database).processSource(sourceId))
      .rejects.toThrow("secondary normalization incomplete");
  });
});
