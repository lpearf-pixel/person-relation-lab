import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("提供只读且失败时返回非零的二次加工质量门禁", async () => {
  const script = await readFile("scripts/secondary-quality-report.sh", "utf8");

  expect(script).toContain("set -Eeuo pipefail");
  expect(script).toContain("SET TRANSACTION READ ONLY");
  expect(script).toContain("SECONDARY_QUALITY_PASS");
  expect(script).toContain("SECONDARY_QUALITY_FAIL");
  expect(script).toContain("/tmp/person-relation-secondary-quality-latest.log");
  expect(script).toContain("normalizer-v1");
  expect(script).toContain("expected_profile_buckets");
  expect(script).toContain("normalized_mismatches");
  expect(script).toContain("empty_hash_rows");
  expect(script).toContain("if ! grep -q '^SECONDARY_QUALITY_PASS$'");
  expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+/i);
});

it("质量报告只输出聚合结果，不读取个人字段或单个哈希", async () => {
  const script = await readFile("scripts/secondary-quality-report.sh", "utf8");

  expect(script).toContain("analytics.normalized_observation");
  expect(script).toContain("analytics.value_profile");
  expect(script).toContain("ingest.processing_checkpoint");
  expect(script).toContain("jsonb_build_object");
  expect(script).toContain("WITH profiled_values AS");
  expect(script).toContain("person_count_band_order");
  expect(script).not.toContain("CASE person_count_band");
  expect(script).not.toContain("r.values");
  expect(script).not.toMatch(/\b(?:CtfId|Mobile|EMail|Address|Company|canonical_name|identity_number)\b/);
  expect(script).not.toMatch(/SELECT\s+(?:\w+\.)?(?:normalized_hash|name_hash|mobile_hash|email_hash|address_hash|organization_hash)\b/i);
});
