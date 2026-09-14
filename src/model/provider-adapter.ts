import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type ThinkingBudgets,
  type ThinkingTokenBudgetField,
} from "@earendil-works/pi-ai";
import type { ModelReasoningEffort } from "./reasoning-effort.js";
import {
  redactModelCredentialText,
  redactModelCredentialValue,
} from "./credential-store.js";

export type ModelProviderConfiguration = {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  visionInputEnabled: boolean;
  apiKey?: string;
  credentialRef?: string;
  credentialStatus?: "not_set" | "active" | "missing" | "revoked";
  credentialRevision?: number;
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

export const modelProviderConfigurationFieldKeys = [
  "baseUrl",
  "model",
  "apiKey",
  "visionInputEnabled",
  "temperature",
  "reasoningEffort",
  "maxTokens",
  "contextWindowTokens",
  "thinkingTokenBudgetField",
  "thinkingBudgetTokens",
] as const;

export type ModelProviderConfigurationFieldKey =
  (typeof modelProviderConfigurationFieldKeys)[number];

export type ModelProviderConfigurationFieldDescriptor = {
  key: ModelProviderConfigurationFieldKey;
  label: string;
  control: "url" | "text" | "secret" | "boolean" | "number" | "select" | "model";
  required: boolean;
  sensitive?: boolean;
  advanced?: boolean;
  allowCustom?: boolean;
  description?: string;
};

export type ModelProviderDescriptor = {
  id: string;
  label: string;
  description: string;
  configurationFields: readonly ModelProviderConfigurationFieldDescriptor[];
  connectionTestSupported: boolean;
  modelDiscoverySupported: boolean;
};

export type ModelProviderInteractivePolicy = {
  thinkingLevel: ModelThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  requirePrivateThinking?: boolean;
  chatTemplateKwargs?: Record<string, string | number | boolean | null>;
};

export type ModelProviderPayloadControls = {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  maxTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
  thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  thinkingBudgetTokens?: number;
  chatTemplateKwargs?: Record<string, string | number | boolean | null>;
  thinkingMode?: "configured" | "off";
  appendSystemInstruction?: string;
  disableTools?: boolean;
};

export type ModelProviderRequestPolicy = {
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
};

/**
 * Deployment-trusted model transport boundary. Adapters own provider-specific
 * model construction, Pi registration, endpoint identity, and diagnostics.
 * Persisted configuration and credentials remain owned by the host.
 */
export type ModelProviderAdapter = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly configurationFields: readonly ModelProviderConfigurationFieldDescriptor[];
  isConfigured(config: ModelProviderConfiguration): boolean;
  validateConfiguration?(config: ModelProviderConfiguration): readonly string[];
  createModel(config: ModelProviderConfiguration): Model<Api>;
  registerModel(
    modelRuntime: ModelRuntime,
    config: ModelProviderConfiguration,
  ): Model<Api> | Promise<Model<Api>>;
  endpointIdentity(config: ModelProviderConfiguration): string;
  interactivePolicy?(config: ModelProviderConfiguration): ModelProviderInteractivePolicy;
  prepareRequestOptions?(
    config: ModelProviderConfiguration,
    options: SimpleStreamOptions,
  ): SimpleStreamOptions;
  transformPayload?(
    config: ModelProviderConfiguration,
    payload: unknown,
    controls: ModelProviderPayloadControls,
  ): unknown;
  finalizePayload?(config: ModelProviderConfiguration, payload: unknown): unknown;
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

export class ModelProviderConfigurationError extends Error {
  readonly code = "MODEL_PROVIDER_CONFIG_INVALID";
  readonly providerId: string;
  readonly issues: readonly string[];

  constructor(providerId: string, issues: readonly string[]) {
    super(`model provider ${providerId}: ${issues.join("; ")}`);
    this.name = "ModelProviderConfigurationError";
    this.providerId = providerId;
    this.issues = Object.freeze([...issues]);
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
        description: adapter.description,
        configurationFields: Object.freeze(adapter.configurationFields.map((field) =>
          Object.freeze({ ...field })
        )),
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
    if (!adapter || !config.enabled || this.configurationIssues(config).length) return false;
    try {
      return adapter.isConfigured(config);
    } catch {
      return false;
    }
  }

  configurationIssues(
    config: ModelProviderConfiguration,
    options: { allowIncomplete?: boolean } = {},
  ): readonly string[] {
    const adapter = this.require(config.provider);
    const issues: string[] = [];
    if (!options.allowIncomplete) {
      if (config.credentialStatus === "revoked") {
        issues.push("model credential is revoked");
      } else if (config.credentialStatus === "missing") {
        issues.push("model credential is missing");
      } else if (
        config.credentialRef &&
        (config.credentialStatus !== "active" || !config.apiKey)
      ) {
        issues.push("model credential is missing");
      }
    }
    if (!options.allowIncomplete) {
      for (const field of adapter.configurationFields) {
        if (field.required && configurationFieldMissing(config, field.key)) {
          issues.push(`${field.key} is required`);
        }
      }
    }
    for (const issue of adapter.validateConfiguration?.(config) ?? []) {
      if (typeof issue !== "string") continue;
      const normalized = redactModelCredentialText(issue.trim(), config.apiKey);
      if (normalized && !issues.includes(normalized)) issues.push(normalized.slice(0, 500));
      if (issues.length >= 20) break;
    }
    return Object.freeze(issues);
  }

  assertConfiguration(
    config: ModelProviderConfiguration,
    options: { allowIncomplete?: boolean } = {},
  ): void {
    const issues = this.configurationIssues(config, options);
    if (issues.length) throw new ModelProviderConfigurationError(config.provider, issues);
  }

  createModel(config: ModelProviderConfiguration): Model<Api> {
    this.assertConfiguration(config);
    return this.require(config.provider).createModel(config);
  }

  registerModel(
    modelRuntime: ModelRuntime,
    config: ModelProviderConfiguration,
  ): Model<Api> | Promise<Model<Api>> {
    this.assertConfiguration(config);
    return this.require(config.provider).registerModel(modelRuntime, config);
  }

  interactivePolicy(config: ModelProviderConfiguration): ModelProviderInteractivePolicy {
    this.assertConfiguration(config);
    const policy = this.require(config.provider).interactivePolicy?.(config);
    return policy
      ? {
          ...policy,
          ...(policy.thinkingBudgets ? { thinkingBudgets: { ...policy.thinkingBudgets } } : {}),
          ...(policy.chatTemplateKwargs
            ? { chatTemplateKwargs: { ...policy.chatTemplateKwargs } }
            : {}),
        }
      : { thinkingLevel: "off" };
  }

  configuredThinkingOptions(
    config: ModelProviderConfiguration,
  ): Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets"> {
    const policy = this.interactivePolicy(config);
    if (policy.thinkingLevel === "off") return {};
    return {
      reasoning: policy.thinkingLevel,
      ...(policy.thinkingBudgets ? { thinkingBudgets: policy.thinkingBudgets } : {}),
    };
  }

  transformPayload(
    config: ModelProviderConfiguration,
    payload: unknown,
    controls: ModelProviderPayloadControls,
  ): unknown {
    const adapter = this.require(config.provider);
    return adapter.transformPayload?.(config, payload, controls) ?? payload;
  }

  finalizePayload(config: ModelProviderConfiguration, payload: unknown): unknown {
    const adapter = this.require(config.provider);
    return adapter.finalizePayload?.(config, payload) ?? payload;
  }

  prepareRequestOptions(
    config: ModelProviderConfiguration,
    options: SimpleStreamOptions = {},
  ): SimpleStreamOptions {
    this.assertConfiguration(config);
    const adapter = this.require(config.provider);
    return adapter.prepareRequestOptions?.(config, options) ?? options;
  }

  requestPolicy(config: ModelProviderConfiguration): ModelProviderRequestPolicy {
    const options = this.prepareRequestOptions(config);
    return Object.freeze({
      timeoutMs: options.timeoutMs ?? 300_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 60_000,
    });
  }

  async complete(
    config: ModelProviderConfiguration,
    context: Context,
    options: SimpleStreamOptions = {},
  ): Promise<AssistantMessage> {
    this.assertConfiguration(config);
    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const adapter = this.require(config.provider);
      const model = await adapter.registerModel(modelRuntime, config);
      const requestOptions = this.prepareRequestOptions(config, options);
      const message = await modelRuntime.completeSimple(model, context, {
        ...requestOptions,
        ...(requestOptions.apiKey === undefined && config.apiKey
          ? { apiKey: config.apiKey }
          : {}),
      });
      return redactModelCredentialValue(message, config.apiKey);
    } catch (error) {
      throw redactModelProviderError(error, config.apiKey);
    }
  }

  endpointIdentity(config: ModelProviderConfiguration): string {
    return this.require(config.provider).endpointIdentity(config);
  }

  async testConnection(
    config: ModelProviderConfiguration,
  ): Promise<ModelProviderConnectionResult> {
    this.assertConfiguration(config);
    const adapter = this.require(config.provider);
    if (!adapter.testConnection) {
      throw new ModelProviderOperationUnsupportedError(adapter.id, "connection_test");
    }
    try {
      return redactModelCredentialValue(await adapter.testConnection(config), config.apiKey);
    } catch (error) {
      throw redactModelProviderError(error, config.apiKey);
    }
  }

  async discoverModels(
    config: ModelProviderConfiguration,
  ): Promise<readonly string[]> {
    const credentialIssue = modelCredentialConfigurationIssue(config);
    if (credentialIssue) {
      throw new ModelProviderConfigurationError(config.provider, [credentialIssue]);
    }
    const adapter = this.require(config.provider);
    if (!adapter.discoverModels) {
      throw new ModelProviderOperationUnsupportedError(adapter.id, "model_discovery");
    }
    try {
      const models = await adapter.discoverModels(config);
      return [...new Set(models.filter((model) => typeof model === "string" && model.trim())
        .map((model) => redactModelCredentialText(model.trim(), config.apiKey)))].sort();
    } catch (error) {
      throw redactModelProviderError(error, config.apiKey);
    }
  }
}

function modelCredentialConfigurationIssue(
  config: ModelProviderConfiguration,
): string | undefined {
  if (config.credentialStatus === "revoked") return "model credential is revoked";
  if (config.credentialStatus === "missing") return "model credential is missing";
  if (
    config.credentialRef &&
    (config.credentialStatus !== "active" || !config.apiKey)
  ) return "model credential is missing";
  return undefined;
}

function redactModelProviderError(error: unknown, secret: string | undefined): unknown {
  if (!secret) return error;
  return new Error(redactModelCredentialText(
    error instanceof Error ? error.message : String(error),
    secret,
  ));
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
  if (
    typeof adapter.description !== "string" ||
    !adapter.description.trim() ||
    adapter.description !== adapter.description.trim() ||
    adapter.description.length > 240
  ) {
    throw new ModelProviderRegistryError(
      `model provider adapter ${adapter.id} must have a trimmed description of at most 240 characters`,
    );
  }
  assertConfigurationFields(adapter);
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
  for (const method of [
    "validateConfiguration",
    "interactivePolicy",
    "prepareRequestOptions",
    "transformPayload",
    "finalizePayload",
  ] as const) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} has an invalid ${method}`,
      );
    }
  }
}

function assertConfigurationFields(adapter: ModelProviderAdapter): void {
  if (!Array.isArray(adapter.configurationFields) || !adapter.configurationFields.length) {
    throw new ModelProviderRegistryError(
      `model provider adapter ${adapter.id} must declare configurationFields`,
    );
  }
  const knownKeys = new Set<string>(modelProviderConfigurationFieldKeys);
  const seen = new Set<string>();
  for (const field of adapter.configurationFields) {
    if (!field || typeof field !== "object" || !knownKeys.has(field.key)) {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} has an invalid configuration field`,
      );
    }
    if (seen.has(field.key)) {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} has duplicate configuration field ${field.key}`,
      );
    }
    seen.add(field.key);
    if (
      typeof field.label !== "string" ||
      !field.label.trim() ||
      field.label !== field.label.trim() ||
      field.label.length > 80 ||
      !new Set(["url", "text", "secret", "boolean", "number", "select", "model"])
        .has(field.control) ||
      typeof field.required !== "boolean" ||
      (field.description !== undefined &&
        (typeof field.description !== "string" ||
          !field.description.trim() ||
          field.description !== field.description.trim() ||
          field.description.length > 240)) ||
      (field.allowCustom !== undefined &&
        (typeof field.allowCustom !== "boolean" || field.key !== "model")) ||
      (field.sensitive !== undefined &&
        (typeof field.sensitive !== "boolean" ||
          (field.sensitive === true && field.key !== "apiKey"))) ||
      (field.advanced !== undefined && typeof field.advanced !== "boolean") ||
      (field.key === "apiKey" && field.control !== "secret")
    ) {
      throw new ModelProviderRegistryError(
        `model provider adapter ${adapter.id} has invalid metadata for field ${field.key}`,
      );
    }
  }
}

function configurationFieldMissing(
  config: ModelProviderConfiguration,
  key: ModelProviderConfigurationFieldKey,
): boolean {
  const value = config[key];
  return value === undefined || value === null ||
    (typeof value === "string" && value.trim() === "");
}
