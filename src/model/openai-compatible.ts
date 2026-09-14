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
import {
  interactiveThinkingTemplateKwargs,
  requiresInteractiveThinking,
} from "./background-thinking-policy.js";
import type {
  ModelProviderAdapter,
  ModelProviderConfiguration,
  ModelProviderPayloadControls,
} from "./provider-adapter.js";

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
  description: "Local or hosted Chat Completions endpoints, including MLX, vLLM, SGLang, llama.cpp, and compatible gateways.",
  configurationFields: [
    { key: "baseUrl", label: "Base URL", control: "url", required: true },
    { key: "model", label: "模型名", control: "model", required: true, allowCustom: true },
    { key: "apiKey", label: "API Key", control: "secret", required: false, sensitive: true },
    { key: "visionInputEnabled", label: "图片输入", control: "boolean", required: false },
    { key: "temperature", label: "Temperature", control: "number", required: false },
    {
      key: "reasoningEffort",
      label: "CoT 强度",
      control: "select",
      required: false,
      description: "使用兼容端点的 reasoning_effort；服务不支持时应保持自动。",
    },
    { key: "maxTokens", label: "Max Tokens", control: "number", required: false },
    {
      key: "thinkingTokenBudgetField",
      label: "原生思考预算协议",
      control: "select",
      required: false,
      advanced: true,
    },
    {
      key: "thinkingBudgetTokens",
      label: "思考预算 Tokens",
      control: "number",
      required: false,
      advanced: true,
    },
    {
      key: "contextWindowTokens",
      label: "上下文窗口",
      control: "number",
      required: false,
      advanced: true,
    },
  ],
  isConfigured: (config) => Boolean(config.baseUrl.trim() && config.model.trim()),
  validateConfiguration: validateOpenAiCompatibleConfiguration,
  createModel: (config) => createOpenAiCompatibleModel(config),
  registerModel: (modelRuntime, config) => registerOpenAiCompatibleModel(modelRuntime, config),
  endpointIdentity: (config) => normalizeOpenAiCompatibleBaseUrl(config.baseUrl),
  interactivePolicy: (config) => {
    const options = openAiCompatibleThinkingOptions(config);
    return {
      thinkingLevel: options.reasoning ?? "off",
      ...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
      ...(requiresInteractiveThinking(config) ? { requirePrivateThinking: true } : {}),
      ...(interactiveThinkingTemplateKwargs(config)
        ? { chatTemplateKwargs: interactiveThinkingTemplateKwargs(config) }
        : {}),
    };
  },
  prepareRequestOptions: (_config, options) => ({
    ...options,
    ...(options.timeoutMs === undefined ? { timeoutMs: 300_000 } : {}),
    ...(options.maxRetries === undefined ? { maxRetries: 2 } : {}),
    ...(options.maxRetryDelayMs === undefined ? { maxRetryDelayMs: 60_000 } : {}),
  }),
  transformPayload: transformOpenAiCompatiblePayload,
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

function validateOpenAiCompatibleConfiguration(
  config: ModelProviderConfiguration,
): readonly string[] {
  const issues: string[] = [];
  if (config.baseUrl.trim()) {
    try {
      const url = new URL(normalizeOpenAiCompatibleBaseUrl(config.baseUrl));
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push("baseUrl must use http or https");
      }
    } catch {
      issues.push("baseUrl must be a valid URL");
    }
  }
  if (config.model.length > 256) issues.push("model must be at most 256 characters");
  if (
    config.temperature !== undefined &&
    (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
  ) issues.push("temperature must be between 0 and 2");
  return issues;
}

function transformOpenAiCompatiblePayload(
  config: ModelProviderConfiguration,
  payload: unknown,
  controls: ModelProviderPayloadControls,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let current = { ...(payload as Record<string, unknown>) };
  if (typeof controls.temperature === "number") current.temperature = controls.temperature;
  if (typeof controls.topP === "number") current.top_p = controls.topP;
  if (typeof controls.frequencyPenalty === "number") {
    current.frequency_penalty = controls.frequencyPenalty;
  }
  if (typeof controls.presencePenalty === "number") {
    current.presence_penalty = controls.presencePenalty;
  }
  if (typeof controls.seed === "number") current.seed = controls.seed;
  if (typeof controls.maxTokens === "number") current.max_tokens = controls.maxTokens;

  if (controls.thinkingMode === "off") {
    delete current.reasoning_effort;
    for (const field of [
      "thinking_token_budget",
      "thinking_budget",
      "thinking_budget_tokens",
    ]) delete current[field];
  } else if (!(controls.thinkingTokenBudgetField ?? config.thinkingTokenBudgetField)) {
    current = applyConfiguredReasoningEffort(current, {
      model: config.model,
      reasoningEffort: controls.reasoningEffort ?? config.reasoningEffort,
    }) as Record<string, unknown>;
  }

  const templateKwargs = controls.thinkingMode === "off" && isMlxThinkingModel(config.model)
    ? { enable_thinking: false, preserve_thinking: true }
    : controls.chatTemplateKwargs;
  if (templateKwargs) {
    const existing = current.chat_template_kwargs &&
        typeof current.chat_template_kwargs === "object" &&
        !Array.isArray(current.chat_template_kwargs)
      ? current.chat_template_kwargs as Record<string, unknown>
      : {};
    current.chat_template_kwargs = { ...existing, ...templateKwargs };
  }
  if (controls.appendSystemInstruction) {
    const messages = Array.isArray(current.messages) ? [...current.messages] : [];
    const systemIndex = messages.findIndex((message) =>
      message && typeof message === "object" && !Array.isArray(message) &&
      (message as Record<string, unknown>).role === "system" &&
      typeof (message as Record<string, unknown>).content === "string"
    );
    if (systemIndex >= 0) {
      const message = messages[systemIndex] as Record<string, unknown>;
      messages[systemIndex] = {
        ...message,
        content: `${String(message.content)}\n\n${controls.appendSystemInstruction}`,
      };
    } else {
      messages.unshift({ role: "system", content: controls.appendSystemInstruction });
    }
    current.messages = messages;
  }
  if (controls.disableTools) {
    current.tools = [];
    current.tool_choice = "none";
    current.parallel_tool_calls = false;
  }
  return current;
}

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
