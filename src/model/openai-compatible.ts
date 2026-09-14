import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Model,
  type SimpleStreamOptions,
  type ThinkingBudgets,
  type ThinkingTokenBudgetField,
} from "@earendil-works/pi-ai";
import {
  isMlxThinkingModel,
  applyConfiguredReasoningEffort,
  type ModelReasoningEffort,
} from "./reasoning-effort.js";
import { interactiveThinkingTemplateKwargs } from "./background-thinking-policy.js";
import type { ModelProviderAdapter } from "./provider-adapter.js";

export type OpenAiCompatibleModelConfig = {
  baseUrl: string;
  model: string;
  visionInputEnabled: boolean;
  apiKey?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
  thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  thinkingBudgetTokens?: number;
};

export const openAiCompatibleProviderId = "rp-openai-compatible";
export const openAiCompatibleAdapterId = "openai_compatible";

export function openAiCompatibleThinkingOptions(
  config: OpenAiCompatibleModelConfig,
): Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets"> {
  if (!config.thinkingTokenBudgetField || config.reasoningEffort === "none") return {};
  const reasoning = config.reasoningEffort === "ultra"
    ? "max"
    : config.reasoningEffort ?? "medium";
  if (config.thinkingBudgetTokens === undefined) return { reasoning };
  const thinkingBudgets: ThinkingBudgets = {
    minimal: config.thinkingBudgetTokens,
    low: config.thinkingBudgetTokens,
    medium: config.thinkingBudgetTokens,
    high: config.thinkingBudgetTokens,
  };
  return { reasoning, thinkingBudgets };
}

export function createOpenAiCompatibleModel(
  config: OpenAiCompatibleModelConfig,
): Model<"openai-completions"> {
  const nativeThinkingBudgetEnabled = config.thinkingTokenBudgetField !== undefined;
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: openAiCompatibleProviderId,
    baseUrl: normalizeOpenAiCompatibleBaseUrl(config.baseUrl),
    reasoning: nativeThinkingBudgetEnabled,
    ...(nativeThinkingBudgetEnabled
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
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
      thinkingFormat: isMlxThinkingModel(config.model) ? "qwen-chat-template" : "openai",
      thinkingTokenBudgetField: config.thinkingTokenBudgetField,
      supportsStrictMode: false,
    },
  };
}

export function registerOpenAiCompatibleModel(
  modelRuntime: ModelRuntime,
  config: OpenAiCompatibleModelConfig,
): Model<"openai-completions"> {
  const model = createOpenAiCompatibleModel(config);
  return registerOpenAiCompatibleModelDefinition(modelRuntime, model, config.apiKey);
}

function registerOpenAiCompatibleModelDefinition(
  modelRuntime: ModelRuntime,
  model: Model<"openai-completions">,
  apiKey: string | undefined,
): Model<"openai-completions"> {
  modelRuntime.registerProvider(model.provider, {
    name: "RP OpenAI-compatible",
    baseUrl: model.baseUrl,
    apiKey: apiKey || "unused",
    api: model.api,
    models: [model],
  });
  return (modelRuntime.getModel(model.provider, model.id) ?? model) as Model<"openai-completions">;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.replace(/\/chat\/completions$/i, "");
}

export const openAiCompatibleProviderAdapter: ModelProviderAdapter = {
  id: openAiCompatibleAdapterId,
  label: "OpenAI-compatible",
  isConfigured: (config) => Boolean(config.baseUrl.trim() && config.model.trim()),
  createModel: (config) => createOpenAiCompatibleModel(config),
  registerModel: (modelRuntime, config) => registerOpenAiCompatibleModel(modelRuntime, config),
  endpointIdentity: (config) => normalizeOpenAiCompatibleBaseUrl(config.baseUrl),
  testConnection: async (config) => {
    if (!config.baseUrl.trim() || !config.model.trim()) {
      throw new Error("Base URL and model are required");
    }
    const startedAt = performance.now();
    const response = await fetch(
      `${normalizeOpenAiCompatibleBaseUrl(config.baseUrl)}/chat/completions`,
      {
        method: "POST",
        headers: openAiCompatibleHeaders(config.apiKey),
        body: JSON.stringify(openAiCompatibleDiagnosticPayload(config)),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`model endpoint returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return {
      ok: true,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  },
  discoverModels: async (config) => {
    if (!config.baseUrl.trim()) throw new Error("Base URL is required");
    const response = await fetch(`${normalizeOpenAiCompatibleBaseUrl(config.baseUrl)}/models`, {
      headers: openAiCompatibleHeaders(config.apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`model discovery returned ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
  },
};

function openAiCompatibleDiagnosticPayload(
  config: OpenAiCompatibleModelConfig,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
  };
  const current = config.thinkingTokenBudgetField
    ? payload
    : applyConfiguredReasoningEffort(payload, config) as Record<string, unknown>;
  const templateKwargs = interactiveThinkingTemplateKwargs(config);
  return templateKwargs
    ? { ...current, chat_template_kwargs: templateKwargs }
    : current;
}

function openAiCompatibleHeaders(apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}
