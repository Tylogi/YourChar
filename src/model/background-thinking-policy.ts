export type BackgroundThinkingScenario =
  | "group_gate"
  | "memory_extraction"
  | "relationship_extraction";

export type BackgroundThinkingPolicy = {
  requested: "off";
  enforced: boolean;
  mechanism: "mlx_chat_template_kwargs" | "unsupported";
  maxTokens: number;
};

type ModelIdentity = {
  model: string;
};

const budgets: Record<BackgroundThinkingScenario, { thinkingOff: number; fallback: number }> = {
  group_gate: { thinkingOff: 256, fallback: 768 },
  memory_extraction: { thinkingOff: 1_024, fallback: 2_400 },
  relationship_extraction: { thinkingOff: 1_024, fallback: 2_400 },
};

export function backgroundThinkingPolicy(
  config: ModelIdentity,
  scenario: BackgroundThinkingScenario,
): BackgroundThinkingPolicy {
  const enforced = supportsMlxThinkingControl(config.model);
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
  const current = payload as Record<string, unknown>;
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

function supportsMlxThinkingControl(model: string): boolean {
  return /(?:^|[-_ ])mlx(?:$|[-_ ])/iu.test(model);
}
