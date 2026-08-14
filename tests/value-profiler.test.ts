import { describe, expect, it, vi } from "vitest";
import { PgValueProfiler } from "../src/db/value-profiler.js";
import { profileBucketSql, PROFILE_CHANNELS } from "../src/db/secondary-processing-sql.js";

describe("value profiler", () => {
  it("uses a fixed channel-to-column allowlist", () => {
    expect(PROFILE_CHANNELS).toEqual({
      mobile: "mobile_hash",
      email: "email_hash",
      address: "address_hash",
      organization: "organization_hash"
    });
    const sql = profileBucketSql("mobile");
    expect(sql).toContain("left(mobile_hash, 2) = $2");
    expect(sql).toContain("COUNT(DISTINCT person_id)");
    expect(sql).toContain("COUNT(DISTINCT source_file_id)");
    expect(sql).toContain("BOOL_OR(false)");
    expect(profileBucketSql("address")).toContain("address_contains_organization");
    expect(sql).toContain("ON CONFLICT (channel, normalized_hash, normalizer_version)");
    expect(sql).not.toContain("relation-v3");
  });

  it("skips committed buckets and profiles only missing scopes", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("AS incomplete_sources")) {
        return { rows: [{ incomplete_sources: "0", mismatched_sources: "0" }] };
      }
      if (text.includes("SELECT stage") && text.includes("processing_checkpoint")) {
        return { rows: [{ stage: "profile:mobile:00" }] };
      }
      if (text.includes("INSERT INTO analytics.value_profile")) return { rows: [{ profiled_values: "2" }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };
    const profiler = new PgValueProfiler(database, ["00", "01"], ["mobile"]);

    await expect(profiler.rebuild()).resolves.toEqual({ profiledValues: 2 });

    const profileCalls = query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO analytics.value_profile"));
    expect(profileCalls).toHaveLength(1);
    expect(profileCalls[0]?.[1]?.slice(0, 3)).toEqual(["normalizer-v1", "01", "mobile"]);
    expect(query.mock.calls.map((call) => call[0])).toContain("BEGIN");
    expect(query.mock.calls.map((call) => call[0])).toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses profiling until all complete sources have full normalized coverage", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("AS incomplete_sources")) {
        return { rows: [{ incomplete_sources: "1", mismatched_sources: "1" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgValueProfiler(database, ["00"], ["mobile"]).rebuild())
      .rejects.toThrow("normalized source coverage is incomplete");
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO analytics.value_profile"))).toBe(false);
  });

  it("rolls back a failed bucket and records a safe failure code", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("AS incomplete_sources")) return { rows: [{ incomplete_sources: "0", mismatched_sources: "0" }] };
      if (text.includes("SELECT stage") && text.includes("processing_checkpoint")) return { rows: [] };
      if (text.includes("INSERT INTO analytics.value_profile")) throw new Error("synthetic profile failure");
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { query: vi.fn(), connect: vi.fn(async () => client) };

    await expect(new PgValueProfiler(database, ["00"], ["address"]).rebuild())
      .rejects.toThrow("synthetic profile failure");
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("profile_bucket_failed"))).toBe(true);
  });
});
