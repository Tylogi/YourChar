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

// Image payloads are encoded transport bytes, not text tokens. Use a bounded
// allowance when provider usage is unavailable; measured usage takes precedence.
export const estimatedImageTokens = 4_096;

export function estimateModelMessageTokens(value: unknown): number {
  let images = 0;
  const text = JSON.stringify(value, (_key, part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const block = part as Record<string, unknown>;
    if (
      (block.type === "image_url" && block.image_url) ||
      (block.type === "input_image" && (block.image_url || block.file_id)) ||
      (block.type === "image" && (block.data || block.source)) ||
      (block.inlineData && typeof block.inlineData === "object" &&
        String((block.inlineData as Record<string, unknown>).mimeType).startsWith("image/"))
    ) {
      images += 1;
      return { type: "image" };
    }
    return part;
  });
  return estimateTokens(text ?? "") + images * estimatedImageTokens;
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
