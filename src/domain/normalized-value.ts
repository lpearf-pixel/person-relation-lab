import { createHash } from "node:crypto";

export const NORMALIZER_VERSION = "normalizer-v1" as const;

export type NormalizerVersion = typeof NORMALIZER_VERSION;

export function normalizeStructuredText(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize("NFKC")
    .replace(/[（]/gu, "(")
    .replace(/[）]/gu, ")")
    .replace(/[，,；;]+/gu, " ")
    .replace(/\s+/gu, "")
    .trim();
  return normalized || null;
}

export function digestNormalized(value: string): string {
  if (!value) throw new Error("cannot digest an empty normalized value");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
