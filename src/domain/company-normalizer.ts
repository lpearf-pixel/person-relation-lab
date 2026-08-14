import { NORMALIZER_VERSION, normalizeStructuredText, type NormalizerVersion } from "./normalized-value.js";

export type NormalizedCompany = {
  organization: string | null;
  department: string | null;
  version: NormalizerVersion;
  flags: string[];
};

const DEPARTMENT_SUFFIX = /(总经办|采购部|财务部|经理室|人事部|销售部)$/u;
const UNRECOGNIZED_DEPARTMENT = /(部|室|中心|处|科)$/u;

export function normalizeCompany(input: string | null | undefined): NormalizedCompany {
  const normalized = normalizeStructuredText(input);
  if (!normalized) {
    return {
      organization: null,
      department: null,
      version: NORMALIZER_VERSION,
      flags: ["company_missing_neutral"]
    };
  }

  const match = normalized.match(DEPARTMENT_SUFFIX);
  const department = match?.[1] ?? null;
  const organization = department ? normalized.slice(0, -department.length) || null : normalized;
  const flags: string[] = [];
  if (department && !organization) flags.push("company_subject_missing");
  else if (!department && UNRECOGNIZED_DEPARTMENT.test(normalized)) flags.push("department_unparsed");

  return { organization, department, version: NORMALIZER_VERSION, flags };
}
