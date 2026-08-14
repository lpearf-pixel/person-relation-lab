import { describe, expect, it, vi } from "vitest";
import { PgProjectionBuilder } from "../src/db/projection-builder.js";

const sourceId = "11111111-1111-1111-1111-111111111111";

describe("person and relationship projection", () => {
  it("invalidates stale completed checkpoints and projects only missing observations", async () => {
    let missingPage = 0;
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("AS people_state") && text.includes("invalidated_stages")) {
        return { rows: [{ raw_records: "2", projected_records: "1", people_state: "complete", invalidated_stages: "4" }] };
      }
      if (text.includes("SELECT last_raw_record_id::text")) return { rows: [{ last_raw_record_id: "0" }] };
      if (text.includes("SELECT r.id::text, r.values FROM raw.record r")) {
        missingPage += 1;
        return missingPage === 1
          ? { rows: [{ id: "12", values: { Descriot: "李四", Birthday: "19920203" } }] }
          : { rows: [] };
      }
      if (text.includes("processed_rows") && text.includes("FROM batch")) {
        return { rows: [{ processed_rows: "0", last_raw_record_id: null }] };
      }
      if (text.includes("AS projected_records")) {
        return { rows: [{ raw_records: "2", projected_records: "2", completed_stages: "4" }] };
      }
      if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgProjectionBuilder(database, 100, 25).projectSource(sourceId))
      .resolves.toEqual({ projectedRecords: 2 });

    const preflight = query.mock.calls.find((call) => String(call[0]).includes("invalidated_stages"));
    expect(preflight?.[0]).toContain("('people'), ('mobile'), ('address'), ('company')");
    expect(preflight?.[0]).toContain("raw_records <> projected_records");
    const rawPage = query.mock.calls.find((call) => String(call[0]).includes("SELECT r.id::text"));
    expect(rawPage?.[0]).toContain("NOT EXISTS");
    expect(rawPage?.[1]).toEqual([sourceId, "0", 100]);
  });

  it("continues an interrupted missing-observation repair without resetting its cursor", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("AS people_state") && text.includes("invalidated_stages")) {
        return { rows: [{ raw_records: "2", projected_records: "1", people_state: "running", invalidated_stages: "0" }] };
      }
      if (text.includes("SELECT last_raw_record_id::text")) {
        return { rows: values?.[1] === undefined ? [{ last_raw_record_id: "100" }] : [] };
      }
      if (text.includes("SELECT r.id::text, r.values FROM raw.record r")) return { rows: [] };
      if (text.includes("processed_rows") && text.includes("FROM batch")) {
        return { rows: [{ processed_rows: "0", last_raw_record_id: null }] };
      }
      if (text.includes("AS projected_records")) {
        return { rows: [{ raw_records: "2", projected_records: "2", completed_stages: "4" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await new PgProjectionBuilder(database, 100, 25).projectSource(sourceId);

    const rawPage = query.mock.calls.find((call) => String(call[0]).includes("SELECT r.id::text"));
    expect(rawPage?.[1]).toEqual([sourceId, "100", 100]);
    expect(query.mock.calls.filter((call) => String(call[0]).includes("invalidated_stages"))).toHaveLength(1);
  });

  it("locks the source and resumes people projection after the committed cursor", async () => {
    let rawPage = 0;
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("invalidated_stages")) {
        return { rows: [{ raw_records: "1", projected_records: "1", people_state: "running", invalidated_stages: "0" }] };
      }
      if (text.includes("SELECT last_raw_record_id::text")) {
        return { rows: values?.[1] === undefined ? [{ last_raw_record_id: "10" }] : [] };
      }
      if (text.includes("SELECT r.id::text, r.values FROM raw.record r")) {
        rawPage += 1;
        return rawPage === 1
          ? { rows: [{ id: "12", values: { Descriot: "张三", Birthday: "19900102", Mobile: "13800138000" } }] }
          : { rows: [] };
      }
      if (text.includes("processed_rows") && text.includes("FROM batch")) {
        return { rows: [{ processed_rows: "0", last_raw_record_id: null }] };
      }
      if (text.includes("AS projected_records")) {
        return { rows: [{ raw_records: "1", projected_records: "1", completed_stages: "4" }] };
      }
      if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgProjectionBuilder(database, 100).projectSource(sourceId))
      .resolves.toEqual({ projectedRecords: 1 });

    expect(database.connect).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    const rawPageCall = query.mock.calls.find((call) => String(call[0]).includes("SELECT r.id::text"));
    expect(rawPageCall?.[1]).toEqual([sourceId, "10", 100]);
    const candidateSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("jsonb_to_recordset")) ?? "";
    expect(candidateSql).toContain("JOIN inserted_people p USING(identity_key)");
    expect(candidateSql).toContain("ingest.projection_checkpoint");
    expect(candidateSql).toContain("GREATEST(ingest.projection_checkpoint.last_raw_record_id");
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses concurrent projection of the same source and releases the connection", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ locked: false }] });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgProjectionBuilder(database).projectSource(sourceId))
      .rejects.toThrow(`projection already running for source ${sourceId}`);

    expect(query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("runs independently checkpointed indexed batches for every evidence channel", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("invalidated_stages")) {
        return { rows: [{ raw_records: "0", projected_records: "0", people_state: "pending", invalidated_stages: "0" }] };
      }
      if (text.includes("SELECT last_raw_record_id::text")) return { rows: [] };
      if (text.includes("SELECT r.id::text, r.values FROM raw.record r")) return { rows: [] };
      if (text.includes("processed_rows") && text.includes("FROM batch")) {
        return { rows: [{ processed_rows: "0", last_raw_record_id: null }] };
      }
      if (text.includes("AS projected_records")) {
        return { rows: [{ raw_records: "0", projected_records: "0", completed_stages: "4" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await new PgProjectionBuilder(database, 100, 25).projectSource(sourceId);

    const statements = query.mock.calls.map((call) => String(call[0]));
    const batchSql = statements.filter((sql) => sql.includes("FROM batch") && sql.includes("algorithm_version"));
    expect(batchSql).toHaveLength(3);
    for (const sql of batchSql) {
      expect(sql).toContain("ORDER BY o.raw_record_id LIMIT $3");
      expect(sql).toContain("FROM core.person_observation matched");
      expect(sql).toContain("LEAST(source.person_id, matched.person_id)");
      expect(sql).toContain("GREATEST(source.person_id, matched.person_id)");
      expect(sql).toContain("algorithm_version = 'relation-v3'");
      expect(sql).toContain("ON CONFLICT (person_a_id, person_b_id, source_record_id, kind, algorithm_version)");
      expect(sql).toContain("INSERT INTO projection.relationship");
      expect(sql).toContain("INSERT INTO ingest.projection_checkpoint");
      expect(sql).toContain("SELECT person_a_id, person_b_id, channel, weight FROM inserted_evidence");
      expect(sql).not.toContain("source_people");
    }
    expect(statements.filter((sql) => sql.includes("VALUES ($1, $2, $3::bigint, 0, 'complete'"))).toHaveLength(4);
    expect(query.mock.calls.some((call) => call[1]?.[2] === 25)).toBe(true);
  });

  it.each([
    { raw_records: "200", projected_records: "199", completed_stages: "4" },
    { raw_records: "200", projected_records: "200", completed_stages: "3" }
  ])("rejects incomplete projection verification: $raw_records/$projected_records/$completed_stages", async (verification) => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("invalidated_stages")) {
        return { rows: [{ raw_records: "200", projected_records: "200", people_state: "running", invalidated_stages: "0" }] };
      }
      if (text.includes("SELECT last_raw_record_id::text")) return { rows: [] };
      if (text.includes("SELECT r.id::text, r.values FROM raw.record r")) return { rows: [] };
      if (text.includes("processed_rows") && text.includes("FROM batch")) {
        return { rows: [{ processed_rows: "0", last_raw_record_id: null }] };
      }
      if (text.includes("AS projected_records")) return { rows: [verification] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgProjectionBuilder(database).projectSource(sourceId))
      .rejects.toThrow("projection incomplete");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
