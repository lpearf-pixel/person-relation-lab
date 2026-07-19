export type ChineseIdResult = {
  normalized: string;
  valid: boolean;
  birthday?: string;
  gender?: "M" | "F";
  error?: "invalid_format" | "invalid_birthday" | "checksum_failed";
};

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const CHECK_CODES = "10X98765432";

export function normalizeChineseId(value: string): ChineseIdResult {
  const normalized = value.replace(/\s/g, "").toUpperCase();
  if (!/^\d{17}[0-9X]$/.test(normalized)) return { normalized, valid: false, error: "invalid_format" };
  const birthday = `${normalized.slice(6, 10)}-${normalized.slice(10, 12)}-${normalized.slice(12, 14)}`;
  const parsed = new Date(`${birthday}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== birthday) {
    return { normalized, valid: false, error: "invalid_birthday" };
  }
  const checksum = normalized.slice(0, 17).split("").reduce((sum, digit, index) => {
    return sum + Number(digit) * (WEIGHTS[index] ?? 0);
  }, 0) % 11;
  if (normalized.at(-1) !== CHECK_CODES[checksum]) {
    return { normalized, valid: false, birthday, error: "checksum_failed" };
  }
  return { normalized, valid: true, birthday, gender: Number(normalized[16]) % 2 ? "M" : "F" };
}

export function normalizeMobile(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
  return /^1\d{10}$/.test(digits) ? digits : null;
}
