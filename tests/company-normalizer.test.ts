import { describe, expect, it } from "vitest";
import { normalizeCompany } from "../src/domain/company-normalizer.js";
import { digestNormalized, NORMALIZER_VERSION } from "../src/domain/normalized-value.js";

describe("company normalizer v1", () => {
  it("splits an explicit trailing department without removing the organization suffix", () => {
    expect(normalizeCompany("上海江达机械加工部 总经办")).toEqual({
      organization: "上海江达机械加工部",
      department: "总经办",
      version: "normalizer-v1",
      flags: []
    });
  });

  it("keeps a missing company neutral", () => {
    expect(normalizeCompany(" ")).toEqual({
      organization: null,
      department: null,
      version: "normalizer-v1",
      flags: ["company_missing_neutral"]
    });
  });

  it("normalizes full-width text and preserves a legal organization name", () => {
    expect(normalizeCompany("测试制造（上海）有限公司")).toEqual({
      organization: "测试制造(上海)有限公司",
      department: null,
      version: "normalizer-v1",
      flags: []
    });
  });

  it("produces a stable non-plaintext digest", () => {
    const first = digestNormalized("测试制造有限公司");
    expect(first).toBe(digestNormalized("测试制造有限公司"));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("测试制造");
    expect(NORMALIZER_VERSION).toBe("normalizer-v1");
  });
});
