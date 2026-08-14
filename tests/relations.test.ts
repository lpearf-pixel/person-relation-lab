import { describe, expect, it } from "vitest";
import { inferRelationship, scoreEntityMatch } from "../src/domain/relations.js";

describe("evidence policy", () => {
  it("treats a missing address as neutral evidence", () => {
    const result = scoreEntityMatch(
      { name: "张三", birthday: "1990-01-02", address: null },
      { name: "张三", birthday: "1990-01-02", address: "南京市" }
    );
    expect(result.score).toBe(55);
    expect(result.reasons).toContain("address_missing_neutral");
  });

  it("never infers a partner relationship from employer only", () => {
    const result = inferRelationship([{ kind: "same_employer", weight: 15, channel: "organization" }]);
    expect(result.type).toBe("organization_association");
  });

  it("never infers a partner relationship from one private mobile only", () => {
    const result = inferRelationship([
      { kind: "shared_private_mobile", weight: 45, channel: "contact" }
    ]);
    expect(result.type).toBe("generic_association");
  });

  it("never infers a partner relationship from one address only", () => {
    const result = inferRelationship([
      { kind: "same_address", weight: 35, channel: "address" }
    ]);
    expect(result.type).toBe("generic_association");
  });

  it("keeps a two-channel partner candidate unconfirmed", () => {
    const result = inferRelationship([
      { kind: "same_household", weight: 60, channel: "household" },
      { kind: "shared_private_mobile", weight: 45, channel: "contact" }
    ]);
    expect(result).toMatchObject({ type: "possible_partner_association", status: "inferred", confidence: 0.95 });
  });
});
