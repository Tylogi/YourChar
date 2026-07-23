import type { Model } from "@earendil-works/pi-ai/compat";

export type OpenAiCompatibleModelConfig = {
  baseUrl: string;
  model: string;
  visionInputEnabled: boolean;
  contextWindowTokens?: number;
  maxTokens?: number;
};

export function createOpenAiCompatibleModel(
  config: OpenAiCompatibleModelConfig,
): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "rp-openai-compatible",
    baseUrl: normalizeOpenAiCompatibleBaseUrl(config.baseUrl),
    reasoning: false,
    input: config.visionInputEnabled ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindowTokens ?? 131_072,
    maxTokens: config.maxTokens ?? 4_096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      supportsStrictMode: false,
    },
  };
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.replace(/\/chat\/completions$/i, "");
}
