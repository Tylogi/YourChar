import type { ActualProviderUsage } from "./types.js";

export function normalizeActualProviderUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}): ActualProviderUsage {
  const available = usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 ||
    usage.cacheRead > 0 || usage.cacheWrite > 0;
  if (!available) {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
  }
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

export function measuredContextInputTokens(usage: ActualProviderUsage): number | null {
  const parts = [
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (parts.every((value) => value === null)) return null;
  // Pi reports uncached, cache-read, and cache-write input as disjoint components.
  return parts.reduce<number>((total, value) => total + (value ?? 0), 0);
}
