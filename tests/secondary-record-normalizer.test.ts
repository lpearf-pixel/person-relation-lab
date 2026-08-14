import { describe, expect, it } from "vitest";
import { normalizeSecondaryRecord } from "../src/domain/secondary-record-normalizer.js";

describe("secondary record normalizer", () => {
  it("creates a privacy-safe versioned observation", () => {
    const input = {
      Descriot: "测试甲",
      Mobile: "+86 138-0013-8000",
      Address: null,
      Company: "测试制造有限公司 财务部",
      EMail: " Test@Example.COM "
    };
    const result = normalizeSecondaryRecord("1", "person-1", "source-1", input);

    expect(result).toMatchObject({
      rawRecordId: "1",
      personId: "person-1",
      sourceFileId: "source-1",
      normalizerVersion: "normalizer-v1",
      addressHash: null,
      addressRegionHash: null,
      addressDetailLevel: 0,
      qualityFlags: ["address_missing_neutral"]
    });
    expect(result.nameHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mobileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.emailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.organizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.departmentHash).toMatch(/^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(result);
    for (const secret of ["测试甲", "13800138000", "Test@Example.COM", "测试制造有限公司", "财务部"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("is deterministic and never hashes empty values", () => {
    const input = { LastNm: "测", FirstNm: "试", Mobile: " ", EMail: " ", Address: "", Company: null };
    const first = normalizeSecondaryRecord("2", "person-2", "source-2", input);
    const second = normalizeSecondaryRecord("2", "person-2", "source-2", input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mobileHash: null,
      emailHash: null,
      addressHash: null,
      organizationHash: null
    });
    expect(first.qualityFlags).toEqual([
      "address_missing_neutral",
      "company_missing_neutral",
      "email_missing_neutral",
      "mobile_missing_neutral"
    ]);
  });

  it("flags invalid contact values instead of preserving them", () => {
    const result = normalizeSecondaryRecord("3", "person-3", "source-3", {
      CardNo: "测试乙",
      Mobile: "12345",
      EMail: "not-an-email",
      Address: "上海市浦东新区上南路5290号"
    });

    expect(result.mobileHash).toBeNull();
    expect(result.emailHash).toBeNull();
    expect(result.addressDetailLevel).toBe(3);
    expect(result.qualityFlags).toEqual([
      "company_missing_neutral",
      "email_invalid",
      "mobile_invalid"
    ]);
  });
});
