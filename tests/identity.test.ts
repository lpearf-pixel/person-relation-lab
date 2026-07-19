import { describe, expect, it } from "vitest";
import { normalizeChineseId, normalizeMobile } from "../src/domain/identity.js";

describe("identity normalization", () => {
  it("validates checksum and extracts birthday and gender", () => {
    expect(normalizeChineseId("11010519491231002x")).toEqual({
      normalized: "11010519491231002X",
      valid: true,
      birthday: "1949-12-31",
      gender: "F"
    });
  });

  it("preserves invalid values with an error", () => {
    expect(normalizeChineseId("110105194912310021")).toMatchObject({
      normalized: "110105194912310021",
      valid: false,
      error: "checksum_failed"
    });
  });

  it("normalizes mainland mobile country prefix", () => {
    expect(normalizeMobile("+86 138-0013-8000")).toBe("13800138000");
  });
});
