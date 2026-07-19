import { describe, expect, it } from "vitest";
import { normalizeRecord } from "../src/domain/record-normalizer.js";

describe("raw record normalization", () => {
  it("uses a valid Chinese ID as the strongest identity and hashes private values", () => {
    const result = normalizeRecord("42", {
      Descriot: "胡永虹", CtfId: "360425198612112036", Gender: "M", Birthday: "19861211",
      Address: " 江西省赣县昌市青山湖区 ", Mobile: "138-0013-8000", Company: "江西工业职业技术学院"
    });
    expect(result).toMatchObject({ rawRecordId: "42", name: "胡永虹", birthday: "1986-12-11", gender: "M" });
    expect(result.identityKey).toMatch(/^id:[a-f0-9]{64}$/);
    expect(result.idHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.addressHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("360425198612112036");
  });

  it("keeps missing address neutral and creates a record-scoped identity when evidence is weak", () => {
    const result = normalizeRecord("99", { FirstNm: "三", LastNm: "张", Address: "", Mobile: "" });
    expect(result).toMatchObject({ name: "张三", addressHash: null, mobileHash: null, identityKey: "record:99" });
  });

  it("uses name, birthday and mobile together when ID is absent", () => {
    const result = normalizeRecord("8", { CardNo: "李四", Birthday: "19900102", Mobile: "+86 139 0000 0000" });
    expect(result.identityKey).toMatch(/^composite:[a-f0-9]{64}$/);
  });

  it("rejects year zero and implausible birthdays before PostgreSQL projection", () => {
    expect(normalizeRecord("10", { Descriot: "异常甲", Birthday: "00001111", Mobile: "13800138000" }).birthday).toBeNull();
    expect(normalizeRecord("11", { Descriot: "异常乙", Birthday: "22000101", Mobile: "13800138001" }).birthday).toBeNull();
  });
});
