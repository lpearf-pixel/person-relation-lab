import { createHash } from "node:crypto";
import { normalizeChineseId, normalizeMobile } from "./identity.js";

export type NormalizedRecord = {
  rawRecordId: string; identityKey: string; name: string | null; birthday: string | null; gender: "M" | "F" | null;
  idHash: string | null; mobileHash: string | null; addressHash: string | null; companyHash: string | null;
};

export function normalizeRecord(rawRecordId: string, values: Record<string, unknown>): NormalizedRecord {
  const name = pickName(values);
  const id = text(values.CtfId);
  const normalizedId = id ? normalizeChineseId(id) : null;
  const mobile = normalizeMobile(text(values.Mobile) ?? text(values.Tel) ?? "");
  const birthday = normalizedId?.valid ? normalizedId.birthday ?? null : normalizeBirthday(text(values.Birthday));
  const gender = normalizedId?.valid ? normalizedId.gender ?? null : normalizeGender(text(values.Gender));
  const address = normalizeLoose(text(values.Address) ?? text(values.CAddress));
  const company = normalizeLoose(text(values.Company));
  const idHash = normalizedId?.valid ? digest(normalizedId.normalized) : null;
  const mobileHash = mobile ? digest(mobile) : null;
  let identityKey = `record:${rawRecordId}`;
  if (idHash) identityKey = `id:${idHash}`;
  else if (name && birthday && mobileHash) identityKey = `composite:${digest(`${name}|${birthday}|${mobileHash}`)}`;
  return {
    rawRecordId, identityKey, name, birthday, gender,
    idHash, mobileHash, addressHash: address ? digest(address) : null, companyHash: company ? digest(company) : null
  };
}

function pickName(values: Record<string, unknown>): string | null {
  const described = normalizeLoose(text(values.Descriot));
  if (described) return described;
  const full = normalizeLoose(`${text(values.LastNm) ?? ""}${text(values.FirstNm) ?? ""}`);
  if (full) return full;
  const card = normalizeLoose(text(values.CardNo));
  return card && /^[\u3400-\u9fff·]{2,20}$/.test(card) ? card : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function normalizeLoose(value: string | null): string | null { return value?.replace(/\s+/g, "").trim() || null; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function normalizeBirthday(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const currentYear = new Date().getUTCFullYear();
  if (year < 1900 || year > currentYear) return null;
  const formatted = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const date = new Date(`${formatted}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== formatted ? null : formatted;
}
function normalizeGender(value: string | null): "M" | "F" | null {
  const upper = value?.toUpperCase();
  if (upper === "M" || value === "男") return "M";
  if (upper === "F" || value === "女") return "F";
  return null;
}
