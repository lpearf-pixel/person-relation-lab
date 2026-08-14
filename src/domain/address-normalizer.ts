import { NORMALIZER_VERSION, normalizeStructuredText, type NormalizerVersion } from "./normalized-value.js";

export type AddressDetailLevel = 0 | 1 | 2 | 3 | 4;

export type NormalizedAddress = {
  value: string | null;
  region: string | null;
  detailLevel: AddressDetailLevel;
  version: NormalizerVersion;
  flags: string[];
};

const MUNICIPALITY_REGION = /^(北京市|上海市|天津市|重庆市)([^省市区县旗州盟]{1,12}(?:区|县|旗))?/u;
const PROVINCE_REGION = /^(.{2,12}?(?:省|自治区|特别行政区))(.{1,12}?(?:市|州|盟))?(.{1,12}?(?:区|县|旗))?/u;
const ORGANIZATION_MARKER = /(有限公司|有限责任公司|股份有限公司|集团|学校|学院|医院|委员会|事务所|公司)/u;

export function normalizeAddress(input: string | null | undefined): NormalizedAddress {
  const value = normalizeStructuredText(input);
  if (!value) {
    return {
      value: null,
      region: null,
      detailLevel: 0,
      version: NORMALIZER_VERSION,
      flags: ["address_missing_neutral"]
    };
  }

  const region = extractRegion(value);
  const flags: string[] = [];
  if (!region) flags.push("address_region_unparsed");
  if (ORGANIZATION_MARKER.test(value)) flags.push("address_contains_organization");

  return {
    value,
    region,
    detailLevel: detectDetailLevel(value, region),
    version: NORMALIZER_VERSION,
    flags
  };
}

function extractRegion(value: string): string | null {
  const municipality = value.match(MUNICIPALITY_REGION)?.[0];
  if (municipality) return municipality;
  return value.match(PROVINCE_REGION)?.[0] ?? null;
}

function detectDetailLevel(value: string, region: string | null): AddressDetailLevel {
  if (/(?:室|房|单元|栋|幢)\d*$/u.test(value) || /\d+(?:室|房|单元|栋|幢)/u.test(value)) return 4;
  if (/(?:路|街|道|巷|弄).{0,20}\d+号/u.test(value)) return 3;
  if (region && value.length > region.length) return 2;
  if (region) return 1;
  return 1;
}
