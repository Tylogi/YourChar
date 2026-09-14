import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CompanionKernel,
  ModelApiConfigValidationError,
  ModelProviderNotFoundError,
  ModelProviderRegistry,
  ModelProviderRegistryError,
  type ModelProviderAdapter,
} from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { runTaskBench } from "../src/evaluation/task-bench.js";

const nativeAdapterId = "native_test";

test("provider registry validates deployment adapters and fails closed on unknown ids", () => {
  const faux = fauxProvider({
    provider: "rp-native-registry-test",
    models: [{ id: "native-model" }],
  });
  const counters = adapterCounters();
  const adapter = nativeTestAdapter(faux, counters);
  const registry = new ModelProviderRegistry([adapter]);

  assert.deepEqual(registry.list(), [{
    id: nativeAdapterId,
    label: "Native test provider",
    description: "Test-only native Pi transport.",
    configurationFields: [{
      key: "model",
      label: "Model",
      control: "model",
      required: true,
      allowCustom: true,
    }],
    connectionTestSupported: true,
    modelDiscoverySupported: true,
  }]);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.list()[0]), true);
  assert.equal(Object.isFrozen(registry.list()[0]?.configurationFields), true);
  assert.equal(Object.isFrozen(registry.list()[0]?.configurationFields[0]), true);
  assert.equal(JSON.stringify(registry.list()).includes("adapter-secret"), false);

  assert.throws(
    () => registry.createModel(modelConfiguration("missing_provider")),
    ModelProviderNotFoundError,
  );
  assert.deepEqual(counters, adapterCounters(), "unknown ids must not fall through to another adapter");

  assert.throws(
    () => new ModelProviderRegistry([{ ...adapter, id: "Invalid.Provider" }]),
    ModelProviderRegistryError,
  );
  assert.throws(
    () => new ModelProviderRegistry([adapter, adapter]),
    /duplicate model provider adapter: native_test/,
  );
  assert.throws(
    () => new ModelProviderRegistry([{ ...adapter, configurationFields: [] }]),
    /must declare configurationFields/,
  );
  assert.throws(
    () => new ModelProviderRegistry([{
      ...adapter,
      configurationFields: [
        { key: "model", label: "Model", control: "model", required: true },
        { key: "model", label: "Duplicate", control: "model", required: true },
      ],
    }]),
    /duplicate configuration field model/,
  );
});

test("kernel routes sessions and diagnostics through an injected native Pi provider", async () => {
  const faux = fauxProvider({
    provider: "rp-native-kernel-test",
    models: [{ id: "native-model" }],
  });
  faux.setResponses([fauxAssistantMessage("native adapter reply")]);
  const counters = adapterCounters();
  const adapter = nativeTestAdapter(faux, counters);
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    memoryExtractor: async () => ({ candidates: [] }),
    modelProviderAdapters: [adapter],
  });
  try {
    const saved = kernel.patchModelApiConfig({
      enabled: true,
      provider: nativeAdapterId,
      baseUrl: "native://kernel-test",
      model: "native-model",
      apiKey: "adapter-secret",
    });
    assert.equal(saved.provider, nativeAdapterId);
    assert.equal(JSON.stringify(saved).includes("adapter-secret"), false);

    const response = await kernel.sendMessage("native-provider-session", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.reply, "native adapter reply");
    assert.ok(counters.registerModel >= 1);
    assert.equal(faux.state.callCount, 1);

    assert.deepEqual(await kernel.testModelConnection(), {
      ok: true,
      status: 204,
      latencyMs: 7,
    });
    assert.deepEqual(await kernel.discoverModels(), ["native-model", "secondary-model"]);
    assert.equal(counters.testConnection, 1);
    assert.equal(counters.discoverModels, 1);

    assert.throws(
      () => kernel.patchModelApiConfig({ provider: "unregistered_provider" }),
      (error: unknown) => error instanceof ModelApiConfigValidationError &&
        error.message === "model provider is not registered: unregistered_provider",
    );
    assert.equal(kernel.getModelApiConfig().provider, nativeAdapterId);
  } finally {
    kernel.dispose();
  }
});

test("provider descriptors are exposed without credentials and persisted missing adapters do not fall back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-provider-adapter-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "model-api.json"), JSON.stringify({
    version: 2,
    defaultProfileId: "default",
    profiles: [{
      id: "default",
      name: "Default",
      enabled: true,
      provider: "missing_native",
      baseUrl: "https://must-not-be-contacted.invalid/v1",
      model: "missing-model",
      visionInputEnabled: false,
      apiKey: "missing-adapter-secret",
    }],
  }));
  const kernel = new CompanionKernel({
    stateDir,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(kernel.getModelApiConfig().provider, "missing_native");
    assert.equal(kernel.readiness().modelConfigured, false);
    const response = await kernel.sendMessage("missing-provider", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.eventType, "model_unavailable");

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const providersResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/model-providers`,
    );
    assert.equal(providersResponse.status, 200);
    const body = await providersResponse.json() as {
      providers: Array<{
        id: string;
        label: string;
        description: string;
        configurationFields: Array<{ key: string; sensitive?: boolean; allowCustom?: boolean }>;
        connectionTestSupported: boolean;
        modelDiscoverySupported: boolean;
      }>;
    };
    assert.deepEqual(body.providers.map((provider) => provider.id), [
      "openai_compatible",
      "anthropic",
      "google",
      "openai",
    ]);
    assert.ok(body.providers.every((provider) => provider.description.length > 0));
    assert.ok(body.providers.every((provider) => provider.configurationFields.length > 0));
    assert.equal(
      body.providers.find((provider) => provider.id === "openai_compatible")
        ?.configurationFields.find((field) => field.key === "model")?.allowCustom,
      true,
    );
    assert.ok(body.providers.slice(1).every((provider) =>
      provider.configurationFields.find((field) => field.key === "model")?.allowCustom === false
    ));
    assert.equal(JSON.stringify(body).includes("missing-adapter-secret"), false);
    assert.equal(JSON.stringify(body).includes("must-not-be-contacted"), false);

    const rejected = await fetch(
      `http://127.0.0.1:${address.port}/api/settings/model-api`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "another_missing_provider" }),
      },
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      code: "MODEL_API_CONFIG_INVALID",
      error: "model provider is not registered: another_missing_provider",
    });
    assert.equal(kernel.getModelApiConfig().provider, "missing_native");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("task bench recreates explicitly injected model adapters in its disposable runtime", async () => {
  const faux = fauxProvider({
    provider: "rp-native-task-bench-test",
    models: [{ id: "native-model" }],
  });
  faux.setResponses([fauxAssistantMessage("NATIVE_BENCH_OK")]);
  const counters = adapterCounters();
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    modelProviderAdapters: [nativeTestAdapter(faux, counters)],
  });
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      provider: nativeAdapterId,
      baseUrl: "native://task-bench",
      model: "native-model",
    });
    const profileId = kernel.listModelApiProfiles().defaultProfileId;
    const { report } = await runTaskBench(kernel, {
      targetMode: "model",
      modelProfileId: profileId,
      task: "Return the readiness marker.",
      repetitions: 1,
      assertions: { requiredPhrases: ["NATIVE_BENCH_OK"] },
    });
    assert.equal(report.summary.passedRuns, 1);
    assert.equal(report.runs[0]?.reply, "NATIVE_BENCH_OK");
    assert.equal(faux.state.callCount, 1);
    assert.ok(counters.registerModel >= 1);
  } finally {
    kernel.dispose();
  }
});

test("incognito child kernels retain the selected deployment adapter", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-provider-incognito-"));
  const faux = fauxProvider({
    provider: "rp-native-incognito-test",
    models: [{ id: "native-model" }],
  });
  faux.setResponses([fauxAssistantMessage("native incognito reply")]);
  const counters = adapterCounters();
  const kernel = new CompanionKernel({
    stateDir,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    memoryExtractor: async () => ({ candidates: [] }),
    modelProviderAdapters: [nativeTestAdapter(faux, counters)],
  });
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      provider: nativeAdapterId,
      baseUrl: "native://incognito",
      model: "native-model",
    });
    const character = kernel.createCharacter({ name: "Adapter Incognito" });
    const incognito = await kernel.openIncognitoConversation(character.id);
    const response = await kernel.sendMessage(incognito.id, { text: "hello" });
    assert.equal(response.reply, "native incognito reply");
    assert.equal(faux.state.callCount, 1);
    assert.ok(counters.registerModel >= 1);
    await kernel.closeIncognitoConversation(incognito.id);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function nativeTestAdapter(
  faux: FauxProviderHandle,
  counters: ReturnType<typeof adapterCounters>,
): ModelProviderAdapter {
  return {
    id: nativeAdapterId,
    label: "Native test provider",
    description: "Test-only native Pi transport.",
    configurationFields: [{
      key: "model",
      label: "Model",
      control: "model",
      required: true,
      allowCustom: true,
    }],
    isConfigured: (config) => config.model === "native-model",
    createModel: (config) => {
      counters.createModel += 1;
      const model = faux.getModel(config.model);
      if (!model) throw new Error(`native model not found: ${config.model}`);
      return model;
    },
    registerModel: async (modelRuntime, config) => {
      await Promise.resolve();
      counters.registerModel += 1;
      modelRuntime.registerNativeProvider(faux.provider);
      const model = modelRuntime.getModel(faux.provider.id, config.model);
      if (!model) throw new Error(`registered native model not found: ${config.model}`);
      return model;
    },
    endpointIdentity: () => "native-test-provider",
    testConnection: async () => {
      counters.testConnection += 1;
      return { ok: true, status: 204, latencyMs: 7 };
    },
    discoverModels: async () => {
      counters.discoverModels += 1;
      return ["secondary-model", "native-model", "native-model", " "];
    },
  };
}

function adapterCounters() {
  return {
    createModel: 0,
    registerModel: 0,
    testConnection: 0,
    discoverModels: 0,
  };
}

function modelConfiguration(provider: string) {
  return {
    enabled: true,
    provider,
    baseUrl: "native://registry-test",
    model: "native-model",
    visionInputEnabled: false,
    apiKey: "adapter-secret",
  };
}
