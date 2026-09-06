import {
  isMlxThinkingModel,
  type ModelReasoningEffort,
} from "./reasoning-effort.js";

export type BackgroundThinkingScenario =
  | "group_gate"
  | "memory_extraction"
  | "relationship_extraction"
  | "post_turn_analysis"
  | "world_planning"
  | "proactive_message"
  | "character_interaction"
  | "character_function_inference"
  | "character_skill_reflection"
  | "quality_judge"
  | "world_analysis"
  | "diary_memory"
  | "diary_narrative";

export type BackgroundThinkingPolicy = {
  requested: "off";
  enforced: boolean;
  mechanism: "mlx_chat_template_kwargs" | "unsupported";
  maxTokens: number;
};

type ModelIdentity = {
  model: string;
  reasoningEffort?: ModelReasoningEffort;
};

export const minimumInteractiveThinkingCharacters = 16;
export const maxInteractiveThinkingRetries = 2;

export function interactiveThinkingTemplateKwargs(
  config: ModelIdentity,
): Record<string, boolean> | undefined {
  return isMlxThinkingModel(config.model)
    ? { enable_thinking: config.reasoningEffort !== "none", preserve_thinking: true }
    : undefined;
}

export function requiresInteractiveThinking(config: ModelIdentity): boolean {
  return isMlxThinkingModel(config.model) && config.reasoningEffort !== "none";
}

const budgets: Record<BackgroundThinkingScenario, { thinkingOff: number; fallback: number }> = {
  group_gate: { thinkingOff: 256, fallback: 768 },
  memory_extraction: { thinkingOff: 1_024, fallback: 2_400 },
  relationship_extraction: { thinkingOff: 1_024, fallback: 2_400 },
  post_turn_analysis: { thinkingOff: 1_024, fallback: 2_400 },
  world_planning: { thinkingOff: 1_200, fallback: 2_400 },
  proactive_message: { thinkingOff: 640, fallback: 1_200 },
  character_interaction: { thinkingOff: 900, fallback: 1_600 },
  character_function_inference: { thinkingOff: 900, fallback: 1_600 },
  character_skill_reflection: { thinkingOff: 900, fallback: 1_600 },
  quality_judge: { thinkingOff: 1_200, fallback: 2_800 },
  world_analysis: { thinkingOff: 1_400, fallback: 2_800 },
  diary_memory: { thinkingOff: 2_400, fallback: 2_400 },
  diary_narrative: { thinkingOff: 6_000, fallback: 6_000 },
};

export function backgroundThinkingPolicy(
  config: ModelIdentity,
  scenario: BackgroundThinkingScenario,
): BackgroundThinkingPolicy {
  const enforced = isMlxThinkingModel(config.model);
  return {
    requested: "off",
    enforced,
    mechanism: enforced ? "mlx_chat_template_kwargs" : "unsupported",
    maxTokens: enforced ? budgets[scenario].thinkingOff : budgets[scenario].fallback,
  };
}

export function applyBackgroundThinkingPolicy(
  payload: unknown,
  config: ModelIdentity,
  scenario: BackgroundThinkingScenario,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const policy = backgroundThinkingPolicy(config, scenario);
  const { reasoning_effort: _reasoningEffort, ...current } = payload as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...current,
    max_tokens: policy.maxTokens,
  };
  if (!policy.enforced) return next;

  const existing = current.chat_template_kwargs
    && typeof current.chat_template_kwargs === "object"
    && !Array.isArray(current.chat_template_kwargs)
    ? current.chat_template_kwargs as Record<string, unknown>
    : {};
  return {
    ...next,
    chat_template_kwargs: {
      ...existing,
      enable_thinking: false,
      preserve_thinking: true,
    },
  };
}
