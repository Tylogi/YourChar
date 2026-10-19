import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  createModels,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type SimpleStreamOptions,
  type ThinkingBudgets,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
  ModelProviderAdapter,
  ModelProviderConfiguration,
  ModelProviderConfigurationFieldDescriptor,
  ModelProviderPayloadControls,
} from "./provider-adapter.js";

type NativeProtocol = "anthropic-messages" | "google-generative-ai" | "openai-responses" | "openai-codex-responses";

const presetProtocol = Symbol("rp-agent-native-preset-protocol");
const presetSourceItem = Symbol("rp-agent-native-preset-source-item");

type NativeProviderDefinition = {
  id: "anthropic" | "google" | "openai" | "openai-codex";
  label: string;
  description: string;
  api: NativeProtocol;
  apiKeyDescription: string;
  provider: () => Provider<Api>;
  thinkingBudgetField: boolean;
  authentication?: "oauth";
};

const commonNativeFields = (
  definition: NativeProviderDefinition,
): readonly ModelProviderConfigurationFieldDescriptor[] => Object.freeze([
  {
    key: "model",
    label: "模型名",
    control: "model",
    required: true,
    allowCustom: false,
    description: "仅选择当前 Pi 版本中经过协议标注的模型。",
  },
  {
    key: "apiKey",
    label: "API Key",
    control: "secret",
    required: false,
    sensitive: true,
    description: definition.apiKeyDescription,
  },
  { key: "visionInputEnabled", label: "图片输入", control: "boolean", required: false },
  { key: "temperature", label: "Temperature", control: "number", required: false },
  {
    key: "reasoningEffort",
    label: "CoT 强度",
    control: "select",
    required: false,
    description: "由 Pi 映射为该模型支持的原生 thinking/reasoning 参数。",
  },
  { key: "maxTokens", label: "Max Tokens", control: "number", required: false },
  ...(definition.thinkingBudgetField
    ? [{
        key: "thinkingBudgetTokens" as const,
        label: "思考预算 Tokens",
        control: "number" as const,
        required: false,
        advanced: true,
      }]
    : []),
  {
    key: "contextWindowTokens",
    label: "上下文窗口",
    control: "number",
    required: false,
    advanced: true,
  },
]);

const nativeDefinitions: readonly NativeProviderDefinition[] = Object.freeze([
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Native Anthropic Messages transport with tool use, prompt caching, usage accounting, and adaptive or budgeted thinking.",
    api: "anthropic-messages",
    apiKeyDescription: "留空时可使用进程环境中的 ANTHROPIC_API_KEY。",
    provider: () => anthropicProvider() as Provider<Api>,
    thinkingBudgetField: true,
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Native Google Generative AI transport with Gemini tool calls, thought signatures, usage accounting, and thinking controls.",
    api: "google-generative-ai",
    apiKeyDescription: "留空时可使用进程环境中的 GEMINI_API_KEY。",
    provider: () => googleProvider() as Provider<Api>,
    thinkingBudgetField: true,
  },
  {
    id: "openai",
    label: "OpenAI Responses",
    description: "Native OpenAI Responses transport with response items, strict tools, encrypted reasoning continuity, and prompt-cache semantics.",
    api: "openai-responses",
    apiKeyDescription: "留空时可使用进程环境中的 OPENAI_API_KEY。",
    provider: () => openaiProvider() as Provider<Api>,
    thinkingBudgetField: false,
  },
  {
    id: "openai-codex",
    label: "Codex（ChatGPT 登录）",
    description: "使用 ChatGPT 账号的 Codex 权益与额度；模型目录由 Pi 提供，实际访问权限取决于账号。",
    api: "openai-codex-responses",
    apiKeyDescription: "",
    provider: () => openaiCodexProvider() as Provider<Api>,
    thinkingBudgetField: false,
    authentication: "oauth",
  },
]);

export const firstPartyNativeModelProviderAdapters: readonly ModelProviderAdapter[] =
  Object.freeze(nativeDefinitions.map(createNativeProviderAdapter));

function createNativeProviderAdapter(
  definition: NativeProviderDefinition,
): ModelProviderAdapter {
  let adapter: ModelProviderAdapter;
  adapter = {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    configurationFields: definition.authentication === "oauth"
      ? commonNativeFields(definition).filter((field) => !["apiKey", "temperature", "maxTokens"].includes(field.key))
      : commonNativeFields(definition),
    ...(definition.authentication ? { authentication: definition.authentication } : {}),
    isConfigured: (config) => Boolean(config.model.trim()) &&
      (definition.authentication !== "oauth" || config.oauth?.providerId === definition.id) &&
      validateNativeConfiguration(definition, config).length === 0,
    validateConfiguration: (config) => validateNativeConfiguration(definition, config),
    createModel: (config) => configuredNativeModel(definition, config),
    registerModel: async (modelRuntime, config) => {
      const provider = definition.provider();
      if (definition.authentication === "oauth") {
        if (!config.oauth || config.oauth.providerId !== provider.id) throw new Error("请先登录 ChatGPT 以使用 Codex。");
        const models = createModels({ credentials: config.oauth.credentials });
        models.setProvider(provider);
        // Keep Pi's transport and locked OAuth refresh while resolving the
        // host-owned, profile-scoped credential for every request.
        modelRuntime.registerNativeProvider({
          ...provider,
          stream: ((model, context, options) => provider.stream(model, context, {
            ...options, transport: "sse", temperature: undefined,
          } as never)) as Provider["stream"],
          streamSimple: (model, context, options) => provider.streamSimple(model, context, {
            ...options, transport: "sse", temperature: undefined,
          }),
          auth: { apiKey: {
            name: "ChatGPT OAuth",
            check: ({ signal }) => models.checkAuth(provider.id, { signal }),
            resolve: async ({ signal }) => {
              try {
                const auth = await models.getAuth(provider.id, { signal });
                if (!auth) throw new Error("signed out");
                return auth;
              } catch {
                signal.throwIfAborted();
                throw new Error("Codex 登录已失效或暂时无法续期，请重试或重新登录 ChatGPT。");
              }
            },
          } },
        });
      } else if (config.apiKey) {
        modelRuntime.registerNativeProvider(provider);
        await modelRuntime.setRuntimeApiKey(definition.id, config.apiKey);
      } else {
        modelRuntime.registerNativeProvider(provider);
        await modelRuntime.removeRuntimeApiKey(definition.id);
      }
      return configuredNativeModel(definition, config);
    },
    endpointIdentity: () => definition.provider().baseUrl ?? definition.id,
    interactivePolicy: (config) => nativeInteractivePolicy(
      configuredNativeModel(definition, config),
      config,
    ),
    prepareRequestOptions: (_config, options) => ({
      ...options,
      ...(options.timeoutMs === undefined ? { timeoutMs: 300_000 } : {}),
      ...(options.maxRetries === undefined ? { maxRetries: 2 } : {}),
      ...(options.maxRetryDelayMs === undefined ? { maxRetryDelayMs: 60_000 } : {}),
      // All calls, including subagents, use the host's HTTP transport policy.
      ...(definition.authentication === "oauth" ? { transport: "sse" as const, temperature: undefined } : {}),
    }),
    transformPayload: (config, payload, controls) =>
      transformNativePayload(definition, config, payload, controls),
    finalizePayload: (_config, payload) => finalizeNativePayload(definition.api, payload),
    testConnection: (config) => testNativeConnection(adapter, config),
    discoverModels: async () => definition.provider().getModels().map((model) => model.id),
  };
  return Object.freeze(adapter);
}

function validateNativeConfiguration(
  definition: NativeProviderDefinition,
  config: ModelProviderConfiguration,
): readonly string[] {
  const issues: string[] = [];
  if (definition.authentication === "oauth" && config.apiKey) {
    issues.push("Codex requires ChatGPT login; API keys are not supported by this provider");
  }
  const modelId = config.model.trim();
  const catalogModel = modelId
    ? definition.provider().getModels().find((model) => model.id === modelId)
    : undefined;
  if (modelId && !catalogModel) {
    issues.push(`model is not in the bundled Pi ${definition.label} catalog`);
  }
  if (modelId.length > 256) issues.push("model must be at most 256 characters");
  if (
    config.temperature !== undefined &&
    (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
  ) issues.push("temperature must be between 0 and 2");
  if (catalogModel && config.visionInputEnabled && !catalogModel.input.includes("image")) {
    issues.push("selected model does not support image input");
  }
  if (catalogModel && config.maxTokens !== undefined && config.maxTokens > catalogModel.maxTokens) {
    issues.push(`maxTokens exceeds the catalog limit of ${catalogModel.maxTokens}`);
  }
  if (
    catalogModel &&
    config.contextWindowTokens !== undefined &&
    config.contextWindowTokens > catalogModel.contextWindow
  ) issues.push(`contextWindowTokens exceeds the catalog limit of ${catalogModel.contextWindow}`);
  return issues;
}

function configuredNativeModel(
  definition: NativeProviderDefinition,
  config: ModelProviderConfiguration,
): Model<Api> {
  const model = definition.provider().getModels().find((entry) => entry.id === config.model.trim());
  if (!model || model.api !== definition.api) {
    throw new Error(`native ${definition.label} model is unavailable: ${config.model}`);
  }
  return {
    ...model,
    input: config.visionInputEnabled
      ? [...model.input]
      : model.input.filter((input) => input !== "image"),
    contextWindow: config.contextWindowTokens ?? model.contextWindow,
    maxTokens: config.maxTokens ?? model.maxTokens,
  };
}

function nativeInteractivePolicy(
  model: Model<Api>,
  config: ModelProviderConfiguration,
): {
  thinkingLevel: ModelThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
} {
  const thinkingLevel = nativeThinkingLevel(model, config);
  if (thinkingLevel === "off" || config.thinkingBudgetTokens === undefined) {
    return { thinkingLevel };
  }
  return {
    thinkingLevel,
    thinkingBudgets: {
      minimal: config.thinkingBudgetTokens,
      low: config.thinkingBudgetTokens,
      medium: config.thinkingBudgetTokens,
      high: config.thinkingBudgetTokens,
    },
  };
}

function nativeThinkingLevel(
  model: Model<Api>,
  config: ModelProviderConfiguration,
): ModelThinkingLevel {
  if (!model.reasoning || config.reasoningEffort === "none") return "off";
  if (config.reasoningEffort === "ultra") return "max";
  return config.reasoningEffort ?? "medium";
}

async function testNativeConnection(
  adapter: ModelProviderAdapter,
  config: ModelProviderConfiguration,
): Promise<{ ok: true; status: number; latencyMs: number }> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = await adapter.registerModel(modelRuntime, config);
  let status = 200;
  const startedAt = performance.now();
  const message = await modelRuntime.completeSimple(model, diagnosticContext(), {
    ...adapter.prepareRequestOptions?.(config, {}),
    apiKey: config.apiKey,
    maxTokens: 8,
    maxRetries: 0,
    timeoutMs: 10_000,
    signal: AbortSignal.timeout(10_000),
    onResponse: (response) => {
      status = response.status;
    },
  });
  assertSuccessfulDiagnostic(message);
  return { ok: true, status, latencyMs: Math.round(performance.now() - startedAt) };
}

function diagnosticContext(): Context {
  return {
    systemPrompt: "Return a short health-check response.",
    messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
  };
}

function assertSuccessfulDiagnostic(message: AssistantMessage): void {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `native model diagnostic stopped: ${message.stopReason}`);
  }
}

function transformNativePayload(
  definition: NativeProviderDefinition,
  config: ModelProviderConfiguration,
  payload: unknown,
  controls: ModelProviderPayloadControls,
): unknown {
  if (!isRecord(payload)) return payload;
  if (definition.api === "anthropic-messages") {
    return transformAnthropicPayload(payload, controls);
  }
  if (definition.api === "google-generative-ai") {
    return transformGooglePayload(config, payload, controls);
  }
  const transformed = transformOpenAiResponsesPayload(config, payload, controls);
  if (definition.api === "openai-codex-responses") {
    // The Codex subscription endpoint does not accept API output-token caps
    // or sampling parameters. Preserve its store:false and instructions.
    delete transformed.max_output_tokens;
    delete transformed.temperature;
    delete transformed.top_p;
  }
  return transformed;
}

function transformAnthropicPayload(
  payload: Record<string, unknown>,
  controls: ModelProviderPayloadControls,
): Record<string, unknown> {
  const current = { ...payload };
  const thinkingEnabled = isRecord(current.thinking) && current.thinking.type !== "disabled";
  if (!thinkingEnabled && typeof controls.temperature === "number") {
    current.temperature = controls.temperature;
  }
  if (!thinkingEnabled && typeof controls.topP === "number") current.top_p = controls.topP;
  if (typeof controls.maxTokens === "number") current.max_tokens = controls.maxTokens;
  if (controls.thinkingMode === "off") {
    delete current.output_config;
    if (isRecord(current.thinking)) current.thinking = { type: "disabled" };
  }
  if (controls.appendSystemInstruction) {
    current.system = appendAnthropicSystem(current.system, controls.appendSystemInstruction);
  }
  if (controls.disableTools) {
    delete current.tools;
    delete current.tool_choice;
  }
  return current;
}

function finalizeAnthropicPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  const systemMessages = payload.messages.filter((message) =>
    isRecord(message) && message.role === "system"
  );
  if (!systemMessages.length) return payload;
  let system = payload.system;
  for (const message of systemMessages) {
    system = appendAnthropicSystem(system, message.content);
  }
  return {
    ...payload,
    system,
    messages: payload.messages.filter((message) =>
      !isRecord(message) || message.role !== "system"
    ),
  };
}

function finalizeNativePayload(protocol: NativeProtocol, payload: unknown): unknown {
  if (protocol === "anthropic-messages") return finalizeAnthropicPayload(payload);
  if (protocol === "google-generative-ai") return finalizeGooglePayload(payload);
  return finalizeOpenAiResponsesPayload(payload);
}

function appendAnthropicSystem(current: unknown, addition: unknown): unknown {
  const blocks = Array.isArray(current)
    ? [...current]
    : typeof current === "string" && current
      ? [{ type: "text", text: current }]
      : [];
  if (Array.isArray(addition)) {
    blocks.push(...addition);
  } else if (typeof addition === "string" && addition) {
    blocks.push({ type: "text", text: addition });
  }
  return blocks;
}

function transformGooglePayload(
  modelConfig: ModelProviderConfiguration,
  payload: Record<string, unknown>,
  controls: ModelProviderPayloadControls,
): Record<string, unknown> {
  const config = isRecord(payload.config) ? { ...payload.config } : {};
  if (typeof controls.temperature === "number") config.temperature = controls.temperature;
  if (typeof controls.topP === "number") config.topP = controls.topP;
  if (typeof controls.maxTokens === "number") config.maxOutputTokens = controls.maxTokens;
  if (controls.thinkingMode === "off") {
    config.thinkingConfig = disabledGoogleThinking(modelConfig.model);
  }
  if (controls.appendSystemInstruction) {
    const current = typeof config.systemInstruction === "string"
      ? `${config.systemInstruction}\n\n`
      : "";
    config.systemInstruction = `${current}${controls.appendSystemInstruction}`;
  }
  if (controls.disableTools) {
    delete config.tools;
    delete config.toolConfig;
  }
  return exposeGooglePresetMessages({ ...payload, config });
}

function disabledGoogleThinking(model: string): Record<string, unknown> {
  const normalized = model.toLowerCase();
  if (/gemini-3(?:\.\d+)?-pro/.test(normalized)) return { thinkingLevel: "LOW" };
  if (
    /gemini-3(?:\.\d+)?-flash/.test(normalized) ||
    normalized === "gemini-flash-latest" ||
    normalized === "gemini-flash-lite-latest" ||
    /gemma-?4/.test(normalized)
  ) return { thinkingLevel: "MINIMAL" };
  return { thinkingBudget: 0 };
}

function transformOpenAiResponsesPayload(
  config: ModelProviderConfiguration,
  payload: Record<string, unknown>,
  controls: ModelProviderPayloadControls,
): Record<string, unknown> {
  const current = { ...payload };
  const thinkingEnabled = isRecord(current.reasoning) && current.reasoning.effort !== "none";
  if (!thinkingEnabled && typeof controls.temperature === "number") {
    current.temperature = controls.temperature;
  }
  if (!thinkingEnabled && typeof controls.topP === "number") current.top_p = controls.topP;
  if (typeof controls.maxTokens === "number") current.max_output_tokens = controls.maxTokens;
  if (controls.thinkingMode === "off") {
    const model = (config.provider === "openai-codex" ? openaiCodexProvider() : openaiProvider())
      .getModels().find((entry) => entry.id === config.model);
    if (model?.reasoning && model.thinkingLevelMap?.off !== null) {
      current.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    } else {
      delete current.reasoning;
    }
  }
  if (controls.appendSystemInstruction) {
    const input = Array.isArray(current.input) ? [...current.input] : [];
    input.unshift({ role: "developer", content: controls.appendSystemInstruction });
    current.input = input;
  }
  if (controls.disableTools) {
    current.tools = [];
    current.tool_choice = "none";
    current.parallel_tool_calls = false;
  }
  return exposeOpenAiResponsesPresetMessages(current);
}

function exposeOpenAiResponsesPresetMessages(
  payload: Record<string, unknown>,
): Record<string | symbol, unknown> {
  if (!Array.isArray(payload.input)) return payload;
  const messages = payload.input.map((item) => {
    if (isRecord(item) && typeof item.role === "string") {
      return {
        role: item.role === "developer" ? "system" : item.role,
        content: item.content,
        [presetSourceItem]: item,
      };
    }
    if (isRecord(item) && item.type === "function_call_output") {
      return { role: "tool", content: item.output, [presetSourceItem]: item };
    }
    if (isRecord(item) && item.type === "function_call") {
      return {
        role: "assistant",
        content: [{ type: "toolCall", name: item.name, arguments: item.arguments }],
        tool_calls: [item],
        [presetSourceItem]: item,
      };
    }
    return { role: "assistant", content: [], [presetSourceItem]: item };
  });
  return { ...payload, messages, [presetProtocol]: "openai-responses" };
}

function finalizeOpenAiResponsesPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const tagged = payload as Record<string | symbol, unknown>;
  if (tagged[presetProtocol] !== "openai-responses" ||
      !Array.isArray(payload.messages)) return payload;
  const input: unknown[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    if (presetSourceItem in message) {
      input.push(message[presetSourceItem]);
      continue;
    }
    if (typeof message.role !== "string") continue;
    input.push({ role: message.role, content: message.content ?? "" });
  }
  const current = { ...payload, input } as Record<string | symbol, unknown>;
  delete current.messages;
  delete current[presetProtocol];
  return current;
}

function exposeGooglePresetMessages(
  payload: Record<string, unknown>,
): Record<string | symbol, unknown> {
  if (!Array.isArray(payload.contents)) return payload;
  const messages = payload.contents.map((item) => {
    if (!isRecord(item)) {
      return { role: "user", content: item, [presetSourceItem]: item };
    }
    const parts = Array.isArray(item.parts) ? item.parts : [];
    const hasFunctionResponse = parts.some((part) => isRecord(part) && "functionResponse" in part);
    const hasFunctionCall = parts.some((part) => isRecord(part) && "functionCall" in part);
    return {
      role: hasFunctionResponse ? "tool" : item.role === "model" ? "assistant" : "user",
      content: parts,
      ...(hasFunctionCall ? { tool_calls: [{}] } : {}),
      [presetSourceItem]: item,
    };
  });
  return { ...payload, messages, [presetProtocol]: "google-generative-ai" };
}

function finalizeGooglePayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const tagged = payload as Record<string | symbol, unknown>;
  if (tagged[presetProtocol] !== "google-generative-ai" ||
      !Array.isArray(payload.messages)) return payload;
  const contents: unknown[] = [];
  const systemAdditions: string[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    if (presetSourceItem in message) {
      contents.push(message[presetSourceItem]);
      continue;
    }
    if (message.role === "system") {
      const text = providerMessageText(message.content);
      if (text) systemAdditions.push(text);
      continue;
    }
    if (typeof message.role !== "string") continue;
    const text = providerMessageText(message.content);
    if (!text) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    });
  }
  const config = isRecord(payload.config) ? { ...payload.config } : {};
  if (systemAdditions.length) {
    const prefix = typeof config.systemInstruction === "string" && config.systemInstruction
      ? `${config.systemInstruction}\n\n`
      : "";
    config.systemInstruction = `${prefix}${systemAdditions.join("\n\n")}`;
  }
  const current = { ...payload, contents, config } as Record<string | symbol, unknown>;
  delete current.messages;
  delete current[presetProtocol];
  return current;
}

function providerMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => isRecord(part) && typeof part.text === "string"
    ? [part.text]
    : []).join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
