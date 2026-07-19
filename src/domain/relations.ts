export type PersonEvidence = {
  identityId?: string | null;
  identityValid?: boolean;
  name?: string | null;
  birthday?: string | null;
  mobile?: string | null;
  email?: string | null;
  address?: string | null;
};

export type MatchResult = { score: number; decision: "match" | "conflict" | "review" | "association"; reasons: string[] };
export type RelationSignal = { kind: string; weight: number; channel: "identity" | "household" | "contact" | "address" | "organization" };
export type RelationshipInference = { type: string; status: "inferred"; score: number; confidence: number; explanation: string[] };

export function scoreEntityMatch(left: PersonEvidence, right: PersonEvidence): MatchResult {
  if (left.identityValid && right.identityValid && left.identityId && right.identityId) {
    if (left.identityId !== right.identityId) return { score: 0, decision: "conflict", reasons: ["conflicting_valid_identity"] };
    return { score: 100, decision: "match", reasons: ["same_valid_identity"] };
  }
  let score = 0;
  const reasons: string[] = [];
  score += same(left.name, right.name, 25, "same_name", reasons);
  score += same(left.birthday, right.birthday, 30, "same_birthday", reasons);
  score += same(left.mobile, right.mobile, 45, "same_mobile", reasons);
  score += same(left.email, right.email, 50, "same_email", reasons);
  if (left.address == null || right.address == null) reasons.push("address_missing_neutral");
  else score += same(left.address, right.address, 35, "same_address", reasons);
  score = Math.min(score, 100);
  return { score, decision: score >= 100 ? "match" : score >= 75 ? "review" : "association", reasons };
}

function same(left: string | null | undefined, right: string | null | undefined, weight: number, reason: string, reasons: string[]): number {
  if (left != null && right != null && left === right) { reasons.push(reason); return weight; }
  return 0;
}

export function inferRelationship(signals: RelationSignal[]): RelationshipInference {
  const score = Math.min(signals.reduce((sum, signal) => sum + Math.max(0, signal.weight), 0), 100);
  const kinds = new Set(signals.map((signal) => signal.kind));
  const privateChannels = new Set(signals.filter((signal) => signal.weight > 0 && ["household", "contact", "address"].includes(signal.channel)).map((signal) => signal.channel));
  let type = "generic_association";
  let cap = 0.6;
  if (kinds.has("same_household") && privateChannels.size >= 2) { type = "possible_partner_association"; cap = 0.95; }
  else if (kinds.has("same_employer")) { type = "organization_association"; cap = 0.7; }
  else if (kinds.has("same_household")) { type = "household_association"; cap = 0.85; }
  return { type, status: "inferred", score, confidence: Math.min(score / 100, cap), explanation: signals.map((signal) => signal.kind) };
}
