import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  CompanionKernel,
  firstPartyNativeModelProviderAdapters,
  ModelApiConfigValidationError,
  ModelProviderRegistry,
  type ModelProviderConfiguration,
  type ModelProviderPayloadControls,
} from "../src/domain/index.js";
import { openAiCompatibleProviderAdapter } from "../src/model/openai-compatible.js";

const registry = () => new ModelProviderRegistry([
  openAiCompatibleProviderAdapter,
  ...firstPartyNativeModelProviderAdapters,
]);

test("first-party native providers expose safe schemas and validate catalog constraints atomically", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
  });
  try {
    const descriptors = kernel.listModelProviders();
    assert.deepEqual(descriptors.map((provider) => provider.id), [
      "openai_compatible",
      "anthropic",
      "google",
      "openai",
    ]);
    assert.ok(descriptors.every((provider) => provider.configurationFields.length > 0));
    assert.ok(descriptors.every((provider) =>
      provider.configurationFields.filter((field) => field.key === "apiKey")
        .every((field) => field.sensitive === true)
    ));
    assert.equal(JSON.stringify(descriptors).includes("sk-test-secret"), false);

    const before = kernel.getModelApiConfig();
    assert.throws(
      () => kernel.patchModelApiConfig({
        provider: "anthropic",
        model: "not-a-catalog-model",
        apiKey: "sk-test-secret",
      }),
      (error: unknown) => error instanceof ModelApiConfigValidationError &&
        /bundled Pi Anthropic catalog/u.test(error.message),
    );
    assert.deepEqual(kernel.getModelApiConfig(), before);

    assert.throws(
      () => kernel.patchModelApiConfig({
        provider: "openai",
        model: "gpt-4",
        visionInputEnabled: true,
      }),
      (error: unknown) => error instanceof ModelApiConfigValidationError &&
        /does not support image input/u.test(error.message),
    );
    assert.deepEqual(kernel.getModelApiConfig(), before);

    const saved = kernel.patchModelApiConfig({
      enabled: true,
      provider: "anthropic",
      baseUrl: "",
      model: "claude-haiku-4-5",
      visionInputEnabled: true,
      reasoningEffort: "high",
      thinkingBudgetTokens: 4_096,
      apiKey: "sk-test-secret",
    });
    assert.equal(saved.provider, "anthropic");
    assert.equal(saved.model, "claude-haiku-4-5");
    assert.equal(JSON.stringify(saved).includes("sk-test-secret"), false);
    assert.ok((await kernel.discoverModels()).includes("claude-haiku-4-5"));
  } finally {
    kernel.dispose();
  }
});

test("native adapters register Pi providers with scoped runtime credentials and thinking policy", async () => {
  const providers = registry();
  const config = modelConfiguration("anthropic", "claude-haiku-4-5", {
    apiKey: "sk-runtime-only",
    reasoningEffort: "high",
    thinkingBudgetTokens: 3_072,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = await providers.registerModel(modelRuntime, config);
  assert.equal(model.provider, "anthropic");
  assert.equal(model.api, "anthropic-messages");
  assert.equal(modelRuntime.getRegisteredNativeProvider("anthropic")?.id, "anthropic");
  assert.equal((await modelRuntime.getAuth("anthropic"))?.auth.apiKey, "sk-runtime-only");
  assert.deepEqual(providers.interactivePolicy(config), {
    thinkingLevel: "high",
    thinkingBudgets: {
      minimal: 3_072,
      low: 3_072,
      medium: 3_072,
      high: 3_072,
    },
  });
  assert.deepEqual(providers.requestPolicy(config), {
    timeoutMs: 300_000,
    maxRetries: 2,
    maxRetryDelayMs: 60_000,
  });
  assert.deepEqual(
    pickRequestPolicy(providers.prepareRequestOptions(config, {
      timeoutMs: 1_000,
      maxRetries: 0,
      maxRetryDelayMs: 10,
    })),
    { timeoutMs: 1_000, maxRetries: 0, maxRetryDelayMs: 10 },
  );
  assert.deepEqual(
    providers.interactivePolicy(modelConfiguration("openai", "gpt-4")),
    { thinkingLevel: "off" },
  );
  assert.equal(
    providers.interactivePolicy(modelConfiguration("openai", "gpt-5", {
      reasoningEffort: "ultra",
    })).thinkingLevel,
    "max",
  );
});

test("native payload hooks own protocol-specific controls", () => {
  const providers = registry();
  const controls: ModelProviderPayloadControls = {
    temperature: 0.4,
    topP: 0.8,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
    seed: 7,
    maxTokens: 321,
    thinkingMode: "off",
    appendSystemInstruction: "Finalize now.",
    disableTools: true,
  };

  const anthropicConfig = modelConfiguration("anthropic", "claude-haiku-4-5");
  const anthropic = providers.finalizePayload(
    anthropicConfig,
    providers.transformPayload(anthropicConfig, {
      model: anthropicConfig.model,
      system: [{ type: "text", text: "System" }],
      messages: [{ role: "system", content: "Preset" }, { role: "user", content: "Task" }],
      max_tokens: 64,
      thinking: { type: "enabled", budget_tokens: 1_024 },
      tools: [{ name: "lookup" }],
      tool_choice: { type: "auto" },
    }, controls),
  ) as Record<string, any>;
  assert.equal(anthropic.max_tokens, 321);
  assert.deepEqual(anthropic.thinking, { type: "disabled" });
  assert.equal("temperature" in anthropic, false, "Anthropic thinking payloads must not receive temperature");
  assert.equal("frequency_penalty" in anthropic, false);
  assert.equal("tools" in anthropic, false);
  assert.deepEqual(anthropic.messages, [{ role: "user", content: "Task" }]);
  assert.match(JSON.stringify(anthropic.system), /System.*Finalize now\..*Preset/u);

  const googleConfig = modelConfiguration("google", "gemini-2.5-flash");
  const googlePrepared = providers.transformPayload(googleConfig, {
    model: googleConfig.model,
    contents: [{ role: "user", parts: [{ text: "Task" }] }],
    config: {
      thinkingConfig: { thinkingBudget: 1_024 },
      tools: [{ functionDeclarations: [] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    },
  }, controls) as Record<string | symbol, any>;
  assert.ok(Array.isArray(googlePrepared.messages));
  const google = providers.finalizePayload(googleConfig, {
    ...googlePrepared,
    messages: [
      { role: "system", content: "Preset system" },
      ...googlePrepared.messages,
      { role: "assistant", content: "Preset example" },
    ],
  }) as Record<string, any>;
  assert.equal(google.config.temperature, 0.4);
  assert.equal(google.config.topP, 0.8);
  assert.equal(google.config.maxOutputTokens, 321);
  assert.deepEqual(google.config.thinkingConfig, { thinkingBudget: 0 });
  assert.equal("tools" in google.config, false);
  assert.equal("toolConfig" in google.config, false);
  assert.equal(google.config.systemInstruction, "Finalize now.\n\nPreset system");
  assert.equal("frequency_penalty" in google.config, false);
  assert.equal("messages" in google, false);
  assert.deepEqual(google.contents.at(-1), {
    role: "model",
    parts: [{ text: "Preset example" }],
  });

  const openAiConfig = modelConfiguration("openai", "gpt-4o");
  const openAiPrepared = providers.transformPayload(openAiConfig, {
    model: openAiConfig.model,
    input: [{ role: "user", content: "Task" }],
    tools: [{ type: "function", name: "lookup" }],
    reasoning: { effort: "high" },
  }, controls) as Record<string | symbol, any>;
  assert.ok(Array.isArray(openAiPrepared.messages));
  const openAi = providers.finalizePayload(openAiConfig, {
    ...openAiPrepared,
    messages: [
      { role: "system", content: "Preset system" },
      ...openAiPrepared.messages,
      { role: "assistant", content: "Preset example" },
    ],
  }) as Record<string, any>;
  assert.equal(openAi.max_output_tokens, 321);
  assert.equal("reasoning" in openAi, false, "non-reasoning models must not receive reasoning fields");
  assert.equal("temperature" in openAi, false, "an existing reasoning request suppresses temperature");
  assert.deepEqual(openAi.tools, []);
  assert.equal(openAi.tool_choice, "none");
  assert.equal(openAi.input[0]?.role, "system");
  assert.ok(openAi.input.some((item: Record<string, unknown>) => item.role === "developer"));
  assert.equal("frequency_penalty" in openAi, false);
  assert.equal("messages" in openAi, false);
  assert.deepEqual(openAi.input.at(-1), { role: "assistant", content: "Preset example" });
});

test("the same gpt-4o task succeeds through native Responses and compatible Chat Completions", async () => {
  const providers = registry();
  const context: Context = {
    systemPrompt: "Return the parity marker only.",
    messages: [{ role: "user", content: "Say PARITY_OK", timestamp: 1 }],
  };
  const captured = new Map<string, Record<string, unknown>>();
  const mockFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
    if (request.url.endsWith("/responses")) {
      captured.set("native-http", body);
      return sseResponse(openAiResponsesEvents("PARITY_OK"));
    }
    if (request.url.endsWith("/chat/completions")) {
      captured.set("compatible-http", body);
      return sseResponse(openAiCompletionsEvents("PARITY_OK"));
    }
    throw new Error(`unexpected request: ${request.url}`);
  };

  const nativeConfig = modelConfiguration("openai", "gpt-4o", { apiKey: "test-key" });
  const compatibleConfig = modelConfiguration("openai_compatible", "gpt-4o", {
    apiKey: "test-key",
    baseUrl: "https://compatible.test/v1",
  });
  const nativePayload: Record<string, unknown>[] = [];
  const compatiblePayload: Record<string, unknown>[] = [];
  const native = await completeWithAdapterPolicy(
    providers,
    nativeConfig,
    context,
    mockFetch,
    nativePayload,
  );
  const compatible = await completeWithAdapterPolicy(
    providers,
    compatibleConfig,
    context,
    mockFetch,
    compatiblePayload,
  );

  assert.equal(assistantText(native), "PARITY_OK");
  assert.equal(assistantText(compatible), "PARITY_OK");
  assert.equal(native.stopReason, "stop");
  assert.equal(compatible.stopReason, "stop");
  assert.equal(native.usage.output, 2);
  assert.equal(compatible.usage.output, 2);
  assert.equal(nativePayload[0]?.max_output_tokens, 32);
  assert.equal(compatiblePayload[0]?.max_tokens, 32);
  assert.ok(Array.isArray(nativePayload[0]?.input));
  assert.ok(Array.isArray(compatiblePayload[0]?.messages));
  assert.deepEqual(captured.get("native-http"), jsonValue(nativePayload[0]));
  assert.deepEqual(captured.get("compatible-http"), jsonValue(compatiblePayload[0]));
});

async function completeWithAdapterPolicy(
  providers: ModelProviderRegistry,
  config: ModelProviderConfiguration,
  context: Context,
  fetchImplementation: typeof fetch,
  captured: Record<string, unknown>[],
) {
  const controls: ModelProviderPayloadControls = {
    temperature: 0,
    maxTokens: 32,
    thinkingMode: "configured",
  };
  const options: SimpleStreamOptions = {
    fetch: fetchImplementation,
    temperature: 0,
    maxTokens: 32,
    maxRetries: 0,
    onPayload: (payload) => {
      const transformed = providers.finalizePayload(
        config,
        providers.transformPayload(config, payload, controls),
      );
      assert.ok(transformed && typeof transformed === "object" && !Array.isArray(transformed));
      captured.push(transformed as Record<string, unknown>);
      return transformed;
    },
  };
  return providers.complete(config, context, options);
}

function modelConfiguration(
  provider: string,
  model: string,
  overrides: Partial<ModelProviderConfiguration> = {},
): ModelProviderConfiguration {
  return {
    enabled: true,
    provider,
    baseUrl: "",
    model,
    visionInputEnabled: false,
    ...overrides,
  };
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("");
}

function pickRequestPolicy(options: SimpleStreamOptions) {
  return {
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxRetryDelayMs: options.maxRetryDelayMs,
  };
}

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function sseResponse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiResponsesEvents(text: string): string[] {
  const item = {
    id: "msg_parity",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    JSON.stringify({ type: "response.created", response: { id: "resp_parity", status: "in_progress" } }),
    JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text }),
    JSON.stringify({ type: "response.output_item.done", output_index: 0, item }),
    JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_parity",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }),
    "[DONE]",
  ];
}

function openAiCompletionsEvents(text: string): string[] {
  const common = {
    id: "chatcmpl-parity",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
  };
  return [
    JSON.stringify({
      ...common,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    JSON.stringify({
      ...common,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    "[DONE]",
  ];
}
