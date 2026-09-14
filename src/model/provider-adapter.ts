import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingTokenBudgetField,
} from "@earendil-works/pi-ai";
import type { ModelReasoningEffort } from "./reasoning-effort.js";

export type ModelProviderConfiguration = {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  visionInputEnabled: boolean;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
  thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  thinkingBudgetTokens?: number;
};

export type ModelProviderConnectionResult = {
  ok: true;
  status: number;
  latencyMs: number;
};

export type ModelProviderDescriptor = {
  id: string;
  label: string;
  connectionTestSupported: boolean;
  modelDiscoverySupported: boolean;
};

/**
 * Deployment-trusted model transport boundary. Adapters own provider-specific
 * model construction, Pi registration, endpoint identity, and diagnostics.
 * Persisted configuration and credentials remain owned by the host.
 */
export type ModelProviderAdapter = {
  readonly id: string;
  readonly label: string;
  isConfigured(config: ModelProviderConfiguration): boolean;
  createModel(config: ModelProviderConfiguration): Model<Api>;
  registerModel(
    modelRuntime: ModelRuntime,
    config: ModelProviderConfiguration,
  ): Model<Api> | Promise<Model<Api>>;
  endpointIdentity(config: ModelProviderConfiguration): string;
  testConnection?(
    config: ModelProviderConfiguration,
  ): Promise<ModelProviderConnectionResult>;
  discoverModels?(
    config: ModelProviderConfiguration,
  ): Promise<readonly string[]>;
};

export class ModelProviderRegistryError extends Error {
  readonly code = "MODEL_PROVIDER_REGISTRY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ModelProviderRegistryError";
  }
}

export class ModelProviderNotFoundError extends Error {
  readonly code = "MODEL_PROVIDER_NOT_FOUND";
  readonly providerId: string;

  constructor(providerId: string) {
    super(`model provider is not registered: ${providerId}`);
    this.name = "ModelProviderNotFoundError";
    this.providerId = providerId;
  }
}

export class ModelProviderOperationUnsupportedError extends Error {
  readonly code = "MODEL_PROVIDER_OPERATION_UNSUPPORTED";
  readonly providerId: string;
  readonly operation: "connection_test" | "model_discovery";

  constructor(
    providerId: string,
    operation: "connection_test" | "model_discovery",
  ) {
    super(`model provider ${providerId} does not support ${operation}`);
    this.name = "ModelProviderOperationUnsupportedError";
    this.providerId = providerId;
    this.operation = operation;
  }
}

const providerIdPattern = /^[a-z][a-z0-9_-]{0,63}$/;

export function isModelProviderId(value: unknown): value is string {
  return typeof value === "string" && providerIdPattern.test(value);
}

export class ModelProviderRegistry {
  private readonly adaptersById = new Map<string, ModelProviderAdapter>();
  private readonly descriptors: readonly ModelProviderDescriptor[];

  constructor(adapters: readonly ModelProviderAdapter[]) {
    for (const adapter of adapters) {
      assertModelProviderAdapter(adapter);
      if (this.adaptersById.has(adapter.id)) {
        throw new ModelProviderRegistryError(`duplicate model provider adapter: ${adapter.id}`);
      }
      this.adaptersById.set(adapter.id, adapter);
    }
    this.descriptors = Object.freeze(
      [...this.adaptersById.values()].map((adapter) => Object.freeze({
        id: adapter.id,
        label: adapter.label,
        connectionTestSupported: Boolean(adapter.testConnection),
        modelDiscoverySupported: Boolean(adapter.discoverModels),
      })),
    );
  }

  list(): readonly ModelProviderDescriptor[] {
    return this.descriptors;
  }

  has(providerId: string): boolean {
    return this.adaptersById.has(providerId);
  }

  require(providerId: string): ModelProviderAdapter {
    const adapter = this.adaptersById.get(providerId);
    if (!adapter) throw new ModelProviderNotFoundError(providerId);
    return adapter;
  }

  isConfigured(config: ModelProviderConfiguration): boolean {
    const adapter = this.adaptersById.get(config.provider);
    return Boolean(adapter && config.enabled && adapter.isConfigured(config));
  }

  createModel(config: ModelProviderConfiguration): Model<Api> {
    return this.require(config.provider).createModel(config);
  }

  registerModel(
    modelRuntime: ModelRuntime,
    config: ModelProviderConfiguration,
  ): Model<Api> | Promise<Model<Api>> {
    return this.require(config.provider).registerModel(modelRuntime, config);
  }

  async complete(
    config: ModelProviderConfiguration,
    context: Context,
    options: SimpleStreamOptions = {},
  ): Promise<AssistantMessage> {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = await this.registerModel(modelRuntime, config);
    return modelRuntime.completeSimple(model, context, {
      ...options,
      ...(options.apiKey === undefined && config.apiKey
        ? { apiKey: config.apiKey }
        : {}),
    });
  }

  endpointIdentity(config: ModelProviderConfiguration): string {
    return this.require(config.provider).endpointIdentity(config);
  }

  async testConnection(
    config: ModelProviderConfiguration,
  ): Promise<ModelProviderConnectionResult> {
    const adapter = this.require(config.provider);
    if (!adapter.testConnection) {
      throw new ModelProviderOperationUnsupportedError(adapter.id, "connection_test");
    }
    return adapter.testConnection(config);
  }

  async discoverModels(
    config: ModelProviderConfiguration,
  ): Promise<readonly string[]> {
    const adapter = this.require(config.provider);
    if (!adapter.discoverModels) {
      throw new ModelProviderOperationUnsupportedError(adapter.id, "model_discovery");
    }
    const models = await adapter.discoverModels(config);
    return [...new Set(models.filter((model) => typeof model === "string" && model.trim())
      .map((model) => model.trim()))].sort();
  }
}

function assertModelProviderAdapter(adapter: ModelProviderAdapter): void {
  if (!adapter || typeof adapter !== "object") {
    throw new ModelProviderRegistryError("model provider adapter must be an object");
  }
  if (!isModelProviderId(adapter.id)) {
    throw new ModelProviderRegistryError(
      "model provider adapter id must match ^[a-z][a-z0-9_-]{0,63}$",
    );
  }
  if (
    typeof adapter.label !== "string" ||
    !adapter.label.trim() ||
    adapter.label !== adapter.label.trim() ||
    adapter.label.length > 80
  ) {
    throw new ModelProviderRegistryError(
      `model provider adapter ${adapter.id} must have a trimmed label of at most 80 characters`,
    );
  }
  for (const method of [
    "isConfigured",
    "createModel",
    "registerModel",
    "endpointIdentity",
  ] as const) {
    if (typeof adapter[method] !== "function") {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} is missing ${method}`,
      );
    }
  }
  for (const method of ["testConnection", "discoverModels"] as const) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} has an invalid ${method}`,
      );
    }
  }
}
