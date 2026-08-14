import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/domain/address-normalizer.js";

describe("address normalizer v1", () => {
  it("keeps a missing address neutral without creating a value", () => {
    expect(normalizeAddress(null)).toEqual({
      value: null,
      region: null,
      detailLevel: 0,
      version: "normalizer-v1",
      flags: ["address_missing_neutral"]
    });
    expect(normalizeAddress("   ")).toEqual(normalizeAddress(null));
  });

  it("normalizes whitespace and extracts a municipality district", () => {
    expect(normalizeAddress(" 上海市 浦东新区 上南路 5290 号 ")).toEqual({
      value: "上海市浦东新区上南路5290号",
      region: "上海市浦东新区",
      detailLevel: 3,
      version: "normalizer-v1",
      flags: []
    });
  });

  it("preserves unparsed addresses and reports their limitation", () => {
    expect(normalizeAddress("青山湖区江纺五区")).toMatchObject({
      value: "青山湖区江纺五区",
      region: null,
      flags: ["address_region_unparsed"]
    });
  });

  it("flags an organization-like suffix embedded in an address", () => {
    expect(normalizeAddress("上海市浦东新区上南路5290号测试制造有限公司").flags)
      .toContain("address_contains_organization");
  });
});
