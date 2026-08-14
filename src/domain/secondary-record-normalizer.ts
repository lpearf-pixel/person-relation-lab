import { normalizeMobile } from "./identity.js";
import { normalizeAddress, type AddressDetailLevel } from "./address-normalizer.js";
import { normalizeCompany } from "./company-normalizer.js";
import {
  digestNormalized,
  NORMALIZER_VERSION,
  normalizeStructuredText,
  type NormalizerVersion
} from "./normalized-value.js";

export type SecondaryNormalizedRecord = {
  rawRecordId: string;
  personId: string;
  sourceFileId: string;
  normalizerVersion: NormalizerVersion;
  nameHash: string | null;
  mobileHash: string | null;
  emailHash: string | null;
  addressHash: string | null;
  addressRegionHash: string | null;
  addressDetailLevel: AddressDetailLevel;
  organizationHash: string | null;
  departmentHash: string | null;
  qualityFlags: string[];
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeSecondaryRecord(
  rawRecordId: string,
  personId: string,
  sourceFileId: string,
  values: Record<string, unknown>
): SecondaryNormalizedRecord {
  const name = pickName(values);
  const rawMobile = text(values.Mobile) ?? text(values.Tel);
  const mobile = rawMobile ? normalizeMobile(rawMobile) : null;
  const rawEmail = text(values.EMail);
  const email = rawEmail?.toLowerCase() ?? null;
  const validEmail = email && EMAIL_PATTERN.test(email) ? email : null;
  const address = normalizeAddress(text(values.Address) ?? text(values.CAddress));
  const company = normalizeCompany(text(values.Company));

  const flags = [...address.flags, ...company.flags];
  if (!rawMobile) flags.push("mobile_missing_neutral");
  else if (!mobile) flags.push("mobile_invalid");
  if (!rawEmail) flags.push("email_missing_neutral");
  else if (!validEmail) flags.push("email_invalid");

  return {
    rawRecordId,
    personId,
    sourceFileId,
    normalizerVersion: NORMALIZER_VERSION,
    nameHash: hashOrNull(name),
    mobileHash: hashOrNull(mobile),
    emailHash: hashOrNull(validEmail),
    addressHash: hashOrNull(address.value),
    addressRegionHash: hashOrNull(address.region),
    addressDetailLevel: address.detailLevel,
    organizationHash: hashOrNull(company.organization),
    departmentHash: hashOrNull(company.department),
    qualityFlags: [...new Set(flags)].sort()
  };
}

function hashOrNull(value: string | null): string | null {
  return value ? digestNormalized(value) : null;
}

function pickName(values: Record<string, unknown>): string | null {
  const described = normalizeStructuredText(text(values.Descriot));
  if (described) return described;
  const combined = normalizeStructuredText(`${text(values.LastNm) ?? ""}${text(values.FirstNm) ?? ""}`);
  if (combined) return combined;
  const card = normalizeStructuredText(text(values.CardNo));
  return card && /^[\p{Script=Han}·]{2,20}$/u.test(card) ? card : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}
