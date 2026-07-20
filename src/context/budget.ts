import type { ContextBudgetSnapshot } from "./types.js";
import { roundMetric } from "./tokens.js";

export const assumedContextWindowTokens = 131_072;
export const defaultMaxOutputTokens = 4_096;

export type ContextBudgetInput = {
  sessionId: string;
  modelProfileId: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  estimatedInputTokens: number;
  actualInputTokens?: number | null;
  lifecycleState?: ContextBudgetSnapshot["lifecycleState"];
  lastCompaction?: ContextBudgetSnapshot["lastCompaction"];
  updatedAt: string;
};

export function buildContextBudget(input: ContextBudgetInput): ContextBudgetSnapshot {
  const contextWindowTokens = boundedInteger(
    input.contextWindowTokens,
    assumedContextWindowTokens,
    8_192,
    2_000_000,
  );
  const maxOutputTokens = boundedInteger(
    input.maxOutputTokens,
    defaultMaxOutputTokens,
    1,
    Math.max(1, Math.floor(contextWindowTokens / 2)),
  );
  const safetyReserveTokens = Math.min(
    16_384,
    Math.max(2_048, Math.ceil(contextWindowTokens * 0.08)),
  );
  const usableInputTokens = Math.max(1, contextWindowTokens - maxOutputTokens - safetyReserveTokens);
  const estimatedInputTokens = Math.max(0, Math.floor(input.estimatedInputTokens));
  const actualInputTokens = finiteNonNegative(input.actualInputTokens);
  const usedInputTokens = actualInputTokens ?? estimatedInputTokens;
  const remainingTokens = Math.max(0, usableInputTokens - usedInputTokens);
  const utilizationRatio = roundMetric(Math.min(1, usedInputTokens / usableInputTokens));
  const remainingRatio = roundMetric(Math.max(0, 1 - utilizationRatio));
  const level = utilizationRatio >= 0.9
    ? "critical"
    : utilizationRatio >= 0.75 ? "warning" : "healthy";
  return {
    sessionId: input.sessionId,
    modelProfileId: input.modelProfileId,
    model: input.model,
    contextWindowTokens,
    contextWindowSource: input.contextWindowTokens === undefined ? "assumed" : "configured",
    maxOutputTokens,
    safetyReserveTokens,
    usableInputTokens,
    estimatedInputTokens,
    actualInputTokens,
    usedInputTokens,
    usageSource: actualInputTokens === null ? "estimated" : "measured",
    remainingTokens,
    remainingRatio,
    utilizationRatio,
    level,
    shouldCompact: utilizationRatio >= 0.8,
    lifecycleState: input.lifecycleState ?? "awake",
    ...(input.lastCompaction ? { lastCompaction: { ...input.lastCompaction } } : {}),
    updatedAt: input.updatedAt,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
