import { createHash } from "node:crypto";

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export function stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(canonicalValue(value)) ?? "";
  return createHash("sha256").update(text).digest("hex");
}

export function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}
