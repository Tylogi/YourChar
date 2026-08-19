export const modelReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ModelReasoningEffort = (typeof modelReasoningEfforts)[number];

export type ModelReasoningConfig = {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string" && modelReasoningEfforts.includes(value as ModelReasoningEffort);
}

/**
 * Apply the configured OpenAI-compatible reasoning control without inventing a
 * default. An omitted setting deliberately leaves provider-specific defaults
 * untouched; `none` is an explicit request to disable reasoning.
 */
export function applyConfiguredReasoningEffort(
  payload: unknown,
  config: ModelReasoningConfig,
): unknown {
  const reasoningEffort = config.reasoningEffort;
  if (
    reasoningEffort === undefined ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  if (reasoningEffort === "none" && isMlxThinkingModel(config.model)) {
    const { reasoning_effort: _reasoningEffort, ...withoutReasoningEffort } =
      payload as Record<string, unknown>;
    return withoutReasoningEffort;
  }
  return {
    ...(payload as Record<string, unknown>),
    reasoning_effort: reasoningEffort,
  };
}

export function isMlxThinkingModel(model: string | undefined): boolean {
  return typeof model === "string" && /(?:^|[-_ ])mlx(?:$|[-_ ])/iu.test(model);
}
