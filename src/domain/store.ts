import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import { SystemIdGenerator } from "../app/id-generator.js";
import {
  resolveStateDirectorySelection,
  type ResolvedStateDirectory,
} from "../app/state-directory.js";
import type { ObservabilitySink } from "../storage/observability.js";
import { TraceArchive } from "../storage/trace-archive.js";
import { modelContextTraceScope } from "./types.js";
import { isModelReasoningEffort } from "../model/reasoning-effort.js";
import type {
  ActionRecord,
  ContextLogEntry,
  ModelApiConfig,
  ModelApiConfigPatch,
  ModelApiProfile,
  ModelApiProfileCollection,
  ModelApiProfilePatch,
  ModelContextTrace,
  ModelContextTraceScope,
  TraceArchiveStatus,
} from "./types.js";

type StoredModelApiConfig = ModelApiConfig & { apiKey?: string };
type StoredModelApiProfile = StoredModelApiConfig & { id: string; name: string };
type StoredModelApiDocument = {
  version: 2;
  defaultProfileId: string;
  profiles: StoredModelApiProfile[];
};

export type CompanionStoreOptions = {
  stateDir?: string | false;
  clock?: Clock;
  idGenerator?: IdGenerator;
};

const defaultModelApiConfig: StoredModelApiConfig = {
  enabled: false,
  provider: "openai_compatible",
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "",
  visionInputEnabled: false,
  apiKeySet: false,
  apiKeyMasked: "",
};

const defaultModelProfileId = "default";

export class ModelApiConfigValidationError extends Error {
  readonly code = "MODEL_API_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ModelApiConfigValidationError";
  }
}

export class CompanionStore {
  readonly stateDir?: string;
  readonly stateDirectorySource: ResolvedStateDirectory["source"];
  readonly stateDirectoryMigrationNeeded: boolean;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly actions: ActionRecord[] = [];
  readonly contextLogs: ContextLogEntry[] = [];
  readonly modelContextTraces: ModelContextTrace[] = [];
  private readonly modelApiConfigPath?: string;
  private modelApiDocument: StoredModelApiDocument;
  private observability?: ObservabilitySink;
  private readonly traceArchive: TraceArchive;
  private readonly actionScope = new AsyncLocalStorage<{
    conversationSpace: ActionRecord["conversationSpace"];
    secretOwnerCharacterId?: string;
  }>();
  private modelRequestCount = 0;

  constructor(options: CompanionStoreOptions = {}) {
    const stateDirectory = resolveStateDirectorySelection({ stateDir: options.stateDir });
    this.stateDir = stateDirectory.stateDir;
    this.stateDirectorySource = stateDirectory.source;
    this.stateDirectoryMigrationNeeded = stateDirectory.migrationNeeded;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new SystemIdGenerator();
    this.modelApiConfigPath = this.stateDir ? join(this.stateDir, "model-api.json") : undefined;
    this.traceArchive = new TraceArchive(this.stateDir, this.clock);
    this.modelApiDocument = this.loadModelApiDocument();
    if (this.modelApiConfigPath && existsSync(this.modelApiConfigPath)) {
      this.persistModelApiConfig();
    }
  }

  withActionScope<T>(
    scope: {
      conversationSpace: ActionRecord["conversationSpace"];
      secretOwnerCharacterId?: string;
    },
    operation: () => T,
  ): T {
    assertActionScope(scope.conversationSpace, scope.secretOwnerCharacterId);
    return this.actionScope.run(scope, operation);
  }

  addAction(
    actionType: string,
    status: ActionRecord["status"],
    payload: Record<string, unknown>,
    explicitScope?: {
      conversationSpace: ActionRecord["conversationSpace"];
      secretOwnerCharacterId?: string;
    },
  ): ActionRecord {
    const scope = explicitScope ?? this.actionScope.getStore() ?? { conversationSpace: "normal" as const };
    assertActionScope(scope.conversationSpace, scope.secretOwnerCharacterId);
    const action: ActionRecord = {
      id: this.idGenerator.next("action"),
      actionType,
      status,
      conversationSpace: scope.conversationSpace,
      ...(scope.secretOwnerCharacterId
        ? { secretOwnerCharacterId: scope.secretOwnerCharacterId }
        : {}),
      payload,
      createdAt: this.clock.now().toISOString(),
    };
    this.actions.push(action);
    this.observability?.recordAction(action);
    return action;
  }

  addContextLog(
    entry: Omit<
      ContextLogEntry,
      "id" | "createdAt" | "conversationSpace" | "secretOwnerCharacterId"
    > & Pick<ContextLogEntry, "secretOwnerCharacterId"> & {
      conversationSpace?: ContextLogEntry["conversationSpace"];
    },
  ): ContextLogEntry {
    const log: ContextLogEntry = {
      ...entry,
      conversationSpace: entry.conversationSpace ?? "normal",
      id: this.idGenerator.next("context-log"),
      createdAt: this.clock.now().toISOString(),
    };
    this.contextLogs.unshift(log);
    if (this.contextLogs.length > 100) {
      this.contextLogs.length = 100;
    }
    this.observability?.recordContextLog(log);
    return log;
  }

  persistContextLog(log: ContextLogEntry): void {
    this.observability?.recordContextLog(log);
  }

  recentContextLogs(
    limit = 20,
    conversationSpace: ContextLogEntry["conversationSpace"] = "normal",
    secretOwnerCharacterId?: string,
  ): ContextLogEntry[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    return this.contextLogs.length
      ? this.contextLogs.filter((entry) =>
          entry.conversationSpace === conversationSpace &&
          entry.secretOwnerCharacterId === secretOwnerCharacterId
        ).slice(0, bounded)
      : this.observability?.recentContextLogs(
          bounded,
          conversationSpace,
          secretOwnerCharacterId,
        ) ?? [];
  }

  latestContextLog(sessionId: string): ContextLogEntry | undefined {
    return this.contextLogs.find((entry) => entry.sessionId === sessionId) ??
      this.observability?.recentContextLogsAcrossSpaces(100).find((entry) => entry.sessionId === sessionId);
  }

  addModelContextTrace(
    entry: Omit<
      ModelContextTrace,
      "id" | "createdAt" | "payload" | "scope" | "conversationSpace" |
        "secretOwnerCharacterId"
    > & Pick<ModelContextTrace, "secretOwnerCharacterId"> & {
      conversationSpace?: ModelContextTrace["conversationSpace"];
      payload: Record<string, unknown>;
    },
  ): ModelContextTrace {
    this.modelRequestCount += 1;
    const trace: ModelContextTrace = {
      ...entry,
      conversationSpace: entry.conversationSpace ?? "normal",
      scope: modelContextTraceScope(entry.turnKind),
      payload: sanitizeTracePayload(entry.payload),
      id: this.idGenerator.next("model-trace"),
      createdAt: this.clock.now().toISOString(),
    };
    this.modelContextTraces.unshift(trace);
    trimModelContextTraceScope(this.modelContextTraces, trace.scope, 10);
    if (trace.conversationSpace === "normal") this.traceArchive.append(trace);
    this.observability?.recordModelContextTrace(trace);
    return trace;
  }

  recentModelContextTraces(
    limit = 10,
    scope?: ModelContextTraceScope,
    conversationSpace: ModelContextTrace["conversationSpace"] = "normal",
    secretOwnerCharacterId?: string,
  ): ModelContextTrace[] {
    const requested = Number.isFinite(limit) ? limit : 10;
    const bounded = Math.max(1, Math.min(requested, scope ? 10 : 20));
    const traces = this.observability?.recentModelContextTraces(
      bounded,
      scope,
      conversationSpace,
      secretOwnerCharacterId,
    ) ??
      this.modelContextTraces
        .filter((trace) =>
          (!scope || trace.scope === scope) &&
          trace.conversationSpace === conversationSpace &&
          trace.secretOwnerCharacterId === secretOwnerCharacterId
        )
        .slice(0, bounded);
    return traces.map((trace) => ({
      ...trace,
      payload: sanitizeTracePayload(trace.payload),
    }));
  }

  getModelRequestCount(): number {
    return this.modelRequestCount;
  }

  getTraceArchiveStatus(): TraceArchiveStatus {
    return this.traceArchive.status();
  }

  patchTraceArchiveConfig(patch: { enabled?: boolean }): TraceArchiveStatus {
    return this.traceArchive.patchConfig(patch);
  }

  attachObservability(sink: ObservabilitySink): void {
    this.observability = sink;
  }

  allActions(): ActionRecord[] {
    return this.observability?.allActions() ?? [...this.actions];
  }

  clearRuntimeData(): void {
    this.actions.length = 0;
    this.contextLogs.length = 0;
    this.modelContextTraces.length = 0;
    this.modelRequestCount = 0;
    this.traceArchive.clearData();
  }

  deleteSessionRuntimeData(sessionId: string): void {
    removeWhere(this.contextLogs, (entry) => entry.sessionId === sessionId);
    removeWhere(this.modelContextTraces, (entry) => entry.sessionId === sessionId);
  }

  getModelApiConfig(): ModelApiConfig {
    const { apiKey: _apiKey, id: _id, name: _name, ...safe } = this.requireStoredModelProfile(
      this.modelApiDocument.defaultProfileId,
    );
    return { ...safe };
  }

  getRawModelApiConfig(): ModelApiConfig & { apiKey?: string } {
    const { id: _id, name: _name, ...config } = this.requireStoredModelProfile(
      this.modelApiDocument.defaultProfileId,
    );
    return { ...config };
  }

  patchModelApiConfig(patch: ModelApiConfigPatch): ModelApiConfig {
    const profile = this.requireStoredModelProfile(this.modelApiDocument.defaultProfileId);
    applyModelProfilePatch(profile, patch, this.clock.now().toISOString());
    this.persistModelApiConfig();
    return this.getModelApiConfig();
  }

  listModelApiProfiles(): ModelApiProfileCollection {
    return {
      defaultProfileId: this.modelApiDocument.defaultProfileId,
      profiles: this.modelApiDocument.profiles.map((profile) => safeModelProfile(
        profile,
        profile.id === this.modelApiDocument.defaultProfileId,
      )),
    };
  }

  getModelApiProfile(id: string): ModelApiProfile | undefined {
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === id);
    return profile ? safeModelProfile(profile, profile.id === this.modelApiDocument.defaultProfileId) : undefined;
  }

  getRawModelApiProfile(id?: string): StoredModelApiConfig | undefined {
    const profileId = id ?? this.modelApiDocument.defaultProfileId;
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === profileId);
    if (!profile) return undefined;
    const { id: _id, name: _name, ...config } = profile;
    return { ...config };
  }

  createModelApiProfile(input: ModelApiProfilePatch): ModelApiProfile {
    const name = requiredProfileName(input.name);
    const now = this.clock.now().toISOString();
    const profile: StoredModelApiProfile = {
      ...defaultModelApiConfig,
      id: this.idGenerator.next("model-profile"),
      name,
    };
    applyModelProfilePatch(profile, input, now);
    this.modelApiDocument.profiles.push(profile);
    this.persistModelApiConfig();
    return safeModelProfile(profile, false);
  }

  patchModelApiProfile(id: string, patch: ModelApiProfilePatch): ModelApiProfile {
    const profile = this.requireStoredModelProfile(id);
    applyModelProfilePatch(profile, patch, this.clock.now().toISOString());
    this.persistModelApiConfig();
    return safeModelProfile(profile, id === this.modelApiDocument.defaultProfileId);
  }

  setDefaultModelApiProfile(id: string): ModelApiProfileCollection {
    this.requireStoredModelProfile(id);
    this.modelApiDocument.defaultProfileId = id;
    this.persistModelApiConfig();
    return this.listModelApiProfiles();
  }

  deleteModelApiProfile(id: string): ModelApiProfileCollection {
    this.requireStoredModelProfile(id);
    if (this.modelApiDocument.profiles.length === 1) {
      throw new Error("at least one model profile is required");
    }
    this.modelApiDocument.profiles = this.modelApiDocument.profiles.filter((entry) => entry.id !== id);
    if (this.modelApiDocument.defaultProfileId === id) {
      this.modelApiDocument.defaultProfileId = this.modelApiDocument.profiles[0].id;
    }
    this.persistModelApiConfig();
    return this.listModelApiProfiles();
  }

  private requireStoredModelProfile(id: string): StoredModelApiProfile {
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error(`model profile not found: ${id}`);
    return profile;
  }

  private loadModelApiDocument(): StoredModelApiDocument {
    if (!this.modelApiConfigPath || !existsSync(this.modelApiConfigPath)) {
      return defaultModelApiDocument();
    }

    try {
      const parsed = JSON.parse(readFileSync(this.modelApiConfigPath, "utf8")) as unknown;
      return normalizeStoredModelApiDocument(parsed);
    } catch {
      return defaultModelApiDocument();
    }
  }

  private persistModelApiConfig(): void {
    if (!this.modelApiConfigPath) {
      return;
    }
    mkdirSync(dirname(this.modelApiConfigPath), { recursive: true });
    writeFileSync(this.modelApiConfigPath, JSON.stringify(this.modelApiDocument, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(this.modelApiConfigPath, 0o600);
  }
}

function assertActionScope(
  conversationSpace: ActionRecord["conversationSpace"],
  secretOwnerCharacterId?: string,
): void {
  if (conversationSpace === "secret" && !secretOwnerCharacterId) {
    throw new Error("secret action scope requires a characterId");
  }
  if (conversationSpace === "normal" && secretOwnerCharacterId) {
    throw new Error("normal action scope cannot include a secret characterId");
  }
}

function defaultModelApiDocument(): StoredModelApiDocument {
  return {
    version: 2,
    defaultProfileId: defaultModelProfileId,
    profiles: [{ ...defaultModelApiConfig, id: defaultModelProfileId, name: "默认模型" }],
  };
}

function removeWhere<T>(entries: T[], predicate: (entry: T) => boolean): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) entries.splice(index, 1);
  }
}

function trimModelContextTraceScope(
  traces: ModelContextTrace[],
  scope: ModelContextTraceScope,
  limit: number,
): void {
  let retained = 0;
  for (let index = 0; index < traces.length; index += 1) {
    if (traces[index].scope !== scope) continue;
    retained += 1;
    if (retained <= limit) continue;
    traces.splice(index, 1);
    index -= 1;
  }
}

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeStoredModelApiConfig(value: unknown): StoredModelApiConfig {
  const input = isRecord(value) ? value : {};
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : undefined;
  const config: StoredModelApiConfig = {
    ...defaultModelApiConfig,
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaultModelApiConfig.enabled,
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : defaultModelApiConfig.baseUrl,
    model: typeof input.model === "string" ? input.model : defaultModelApiConfig.model,
    visionInputEnabled: typeof input.visionInputEnabled === "boolean"
      ? input.visionInputEnabled
      : defaultModelApiConfig.visionInputEnabled,
    apiKey,
    apiKeySet: Boolean(apiKey),
    apiKeyMasked: apiKey ? maskSecret(apiKey) : "",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined,
  };
  if (typeof input.temperature === "number") {
    config.temperature = input.temperature;
  }
  if (typeof input.maxTokens === "number") {
    config.maxTokens = Math.max(1, Math.floor(input.maxTokens));
  }
  if (typeof input.contextWindowTokens === "number") {
    config.contextWindowTokens = boundedContextWindow(input.contextWindowTokens);
  }
  if (isModelReasoningEffort(input.reasoningEffort)) {
    config.reasoningEffort = input.reasoningEffort;
  }
  return config;
}

function normalizeStoredModelApiDocument(value: unknown): StoredModelApiDocument {
  const input = isRecord(value) ? value : {};
  if (input.version !== 2 || !Array.isArray(input.profiles)) {
    return {
      version: 2,
      defaultProfileId: defaultModelProfileId,
      profiles: [{
        ...normalizeStoredModelApiConfig(value),
        id: defaultModelProfileId,
        name: "默认模型",
      }],
    };
  }
  const seen = new Set<string>();
  const profiles = input.profiles.flatMap((entry): StoredModelApiProfile[] => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ ...normalizeStoredModelApiConfig(entry), id, name }];
  });
  if (!profiles.length) return defaultModelApiDocument();
  const requestedDefault = typeof input.defaultProfileId === "string" ? input.defaultProfileId : "";
  return {
    version: 2,
    defaultProfileId: profiles.some((entry) => entry.id === requestedDefault) ? requestedDefault : profiles[0].id,
    profiles,
  };
}

function safeModelProfile(profile: StoredModelApiProfile, isDefault: boolean): ModelApiProfile {
  const { apiKey: _apiKey, ...safe } = profile;
  return { ...safe, isDefault };
}

function requiredProfileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("model profile name is required");
  return value.trim();
}

function applyModelProfilePatch(
  profile: StoredModelApiProfile,
  patch: ModelApiProfilePatch,
  updatedAt: string,
): void {
  if (
    patch.reasoningEffort !== undefined &&
    patch.reasoningEffort !== null &&
    !isModelReasoningEffort(patch.reasoningEffort)
  ) {
    throw new ModelApiConfigValidationError(
      "reasoningEffort must be none, minimal, low, medium, high, xhigh, max, ultra, or null",
    );
  }
  if (patch.name !== undefined) profile.name = requiredProfileName(patch.name);
  if (typeof patch.enabled === "boolean") profile.enabled = patch.enabled;
  if (typeof patch.baseUrl === "string") profile.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === "string") profile.model = patch.model.trim();
  if (typeof patch.visionInputEnabled === "boolean") profile.visionInputEnabled = patch.visionInputEnabled;
  if (typeof patch.apiKey === "string") {
    const apiKey = patch.apiKey.trim();
    if (apiKey) {
      profile.apiKey = apiKey;
      profile.apiKeySet = true;
      profile.apiKeyMasked = maskSecret(apiKey);
    } else {
      delete profile.apiKey;
      profile.apiKeySet = false;
      profile.apiKeyMasked = "";
    }
  }
  if (patch.clearApiKey) {
    delete profile.apiKey;
    profile.apiKeySet = false;
    profile.apiKeyMasked = "";
  }
  if (patch.temperature === null) delete profile.temperature;
  else if (typeof patch.temperature === "number") profile.temperature = patch.temperature;
  if (patch.maxTokens === null) delete profile.maxTokens;
  else if (typeof patch.maxTokens === "number") profile.maxTokens = Math.max(1, Math.floor(patch.maxTokens));
  if (patch.contextWindowTokens === null) delete profile.contextWindowTokens;
  else if (typeof patch.contextWindowTokens === "number") {
    profile.contextWindowTokens = boundedContextWindow(patch.contextWindowTokens);
  }
  if (patch.reasoningEffort === null) delete profile.reasoningEffort;
  else if (isModelReasoningEffort(patch.reasoningEffort)) {
    profile.reasoningEffort = patch.reasoningEffort;
  }
  profile.updatedAt = updatedAt;
}

function boundedContextWindow(value: number): number {
  return Math.max(8_192, Math.min(2_000_000, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const sensitiveTraceField = /^(authorization|api[-_]?key|access[-_]?token|secret|password)$/i;

function sanitizeTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (sensitiveTraceField.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
      const dataUrl = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,/iu);
      if (dataUrl) {
        const encodedCharacters = Math.max(0, value.length - value.indexOf(",") - 1);
        return `[Binary data URL omitted: ${dataUrl[1]}, ${encodedCharacters} base64 chars]`;
      }
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
  if (!json) return {};
  const parsed = JSON.parse(json) as unknown;
  return isRecord(parsed) ? parsed : {};
}
