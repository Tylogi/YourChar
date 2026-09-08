import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingBudgets,
  type ThinkingTokenBudgetField,
} from "@earendil-works/pi-ai";
import {
  isMlxThinkingModel,
  type ModelReasoningEffort,
} from "./reasoning-effort.js";

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

/**
 * Run one non-session model request through Pi's canonical model/auth runtime.
 * Background jobs intentionally use an ephemeral runtime so credentials cannot
 * leak between profiles or survive beyond the request.
 */
export async function completeOpenAiCompatible(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions = {},
): Promise<AssistantMessage> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { apiKey, ...requestOptions } = options;
  const registered = registerOpenAiCompatibleModelDefinition(modelRuntime, model, apiKey);
  return modelRuntime.completeSimple(registered, context, requestOptions);
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
