import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { isModelProviderId } from "../model/provider-adapter.js";
import {
  ModelCredentialConflictError,
  ModelCredentialStore,
  ModelCredentialValidationError,
  type ModelCredentialMetadata,
  type ModelCredentialResolver,
} from "../model/credential-store.js";
import { durableAtomicWrite } from "../memory-vault/durability.js";
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

type StoredModelApiConfig = Omit<
  ModelApiConfig,
  | "apiKeySet"
  | "apiKeyMasked"
  | "credentialStatus"
  | "credentialRevision"
  | "credentialCanRollback"
>;
type StoredModelApiProfile = StoredModelApiConfig & { id: string; name: string };
type StoredModelApiDocument = {
  version: 3;
  defaultProfileId: string;
  profiles: StoredModelApiProfile[];
};

export type RawModelApiConfig = ModelApiConfig & { apiKey?: string };

export type CompanionStoreOptions = {
  stateDir?: string | false;
  clock?: Clock;
  idGenerator?: IdGenerator;
  /** Trusted resolver used by disposable runtimes; secrets are never copied into their state. */
  modelCredentialResolver?: ModelCredentialResolver;
};

const defaultModelApiConfig: StoredModelApiConfig = {
  enabled: false,
  provider: "openai_compatible",
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "",
  visionInputEnabled: false,
};

const defaultModelProfileId = "default";
const thinkingTokenBudgetFields = new Set([
  "thinking_token_budget",
  "thinking_budget",
  "thinking_budget_tokens",
]);
const maximumThinkingBudgetTokens = 1_000_000;

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
  private readonly modelCredentials: ModelCredentialStore;
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
    this.modelCredentials = new ModelCredentialStore({
      stateDir: this.stateDir,
      clock: this.clock,
      externalResolver: options.modelCredentialResolver,
    });
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
    return this.materializeModelProfile(
      this.requireStoredModelProfile(this.modelApiDocument.defaultProfileId),
    );
  }

  getRawModelApiConfig(): RawModelApiConfig {
    return this.materializeRawModelProfile(
      this.requireStoredModelProfile(this.modelApiDocument.defaultProfileId),
    );
  }

  patchModelApiConfig(patch: ModelApiConfigPatch): ModelApiConfig {
    const source = this.requireStoredModelProfile(this.modelApiDocument.defaultProfileId);
    const profile = { ...source };
    applyModelProfilePatch(profile, patch, this.clock.now().toISOString());
    this.applyModelCredentialPatch(profile, patch);
    this.replaceStoredModelProfile(profile);
    this.persistModelApiConfig();
    return this.getModelApiConfig();
  }

  listModelApiProfiles(): ModelApiProfileCollection {
    return {
      defaultProfileId: this.modelApiDocument.defaultProfileId,
      profiles: this.modelApiDocument.profiles.map((profile) => this.safeModelProfile(
        profile,
        profile.id === this.modelApiDocument.defaultProfileId,
      )),
    };
  }

  getModelApiProfile(id: string): ModelApiProfile | undefined {
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === id);
    return profile
      ? this.safeModelProfile(profile, profile.id === this.modelApiDocument.defaultProfileId)
      : undefined;
  }

  getRawModelApiProfile(id?: string): RawModelApiConfig | undefined {
    const profileId = id ?? this.modelApiDocument.defaultProfileId;
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === profileId);
    if (!profile) return undefined;
    return this.materializeRawModelProfile(profile);
  }

  previewModelApiProfilePatch(
    patch: ModelApiProfilePatch,
    id?: string,
  ): RawModelApiConfig {
    const source = this.requireStoredModelProfile(id ?? this.modelApiDocument.defaultProfileId);
    const candidate = { ...source };
    applyModelProfilePatch(candidate, patch, this.clock.now().toISOString());
    return this.previewCredentialPatch(candidate, patch);
  }

  previewNewModelApiProfile(
    patch: ModelApiProfilePatch,
  ): RawModelApiConfig {
    const candidate: StoredModelApiProfile = {
      ...defaultModelApiConfig,
      id: "preview",
      name: "preview",
    };
    applyModelProfilePatch(candidate, patch, this.clock.now().toISOString());
    return this.previewCredentialPatch(candidate, patch);
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
    this.applyModelCredentialPatch(profile, input);
    this.modelApiDocument.profiles.push(profile);
    this.persistModelApiConfig();
    return this.safeModelProfile(profile, false);
  }

  patchModelApiProfile(id: string, patch: ModelApiProfilePatch): ModelApiProfile {
    const profile = { ...this.requireStoredModelProfile(id) };
    applyModelProfilePatch(profile, patch, this.clock.now().toISOString());
    this.applyModelCredentialPatch(profile, patch);
    this.replaceStoredModelProfile(profile);
    this.persistModelApiConfig();
    return this.safeModelProfile(profile, id === this.modelApiDocument.defaultProfileId);
  }

  previewModelApiCredential(
    id: string,
    apiKey: string,
    profilePatch: ModelApiProfilePatch = {},
  ): RawModelApiConfig {
    assertStructuralCredentialDraft(profilePatch);
    const profile = { ...this.requireStoredModelProfile(id) };
    applyModelProfilePatch(profile, profilePatch, this.clock.now().toISOString());
    return this.previewCredentialPatch(profile, { apiKey });
  }

  assertModelApiCredentialRevision(id: string, expectedRevision: number): void {
    const profile = this.requireStoredModelProfile(id);
    const actualRevision = this.currentCredentialRevision(profile);
    if (expectedRevision !== actualRevision) {
      throw new ModelCredentialConflictError(
        "model credential revision changed",
        expectedRevision,
        actualRevision,
      );
    }
  }

  setModelApiCredential(
    id: string,
    apiKey: string,
    expectedRevision?: number,
    profilePatch: ModelApiProfilePatch = {},
  ): ModelApiProfile {
    assertStructuralCredentialDraft(profilePatch);
    const profile = { ...this.requireStoredModelProfile(id) };
    applyModelProfilePatch(profile, profilePatch, this.clock.now().toISOString());
    this.applyModelCredentialPatch(profile, { apiKey, expectedCredentialRevision: expectedRevision });
    profile.updatedAt = this.clock.now().toISOString();
    this.replaceStoredModelProfile(profile);
    this.persistModelApiConfig();
    return this.safeModelProfile(profile, id === this.modelApiDocument.defaultProfileId);
  }

  revokeModelApiCredential(id: string, expectedRevision?: number): ModelApiProfile {
    const profile = this.requireStoredModelProfile(id);
    if (!profile.credentialRef) {
      throw new ModelCredentialConflictError(
        "model profile has no credential to revoke",
        expectedRevision,
      );
    }
    this.modelCredentials.revoke(profile.credentialRef, id, expectedRevision);
    profile.updatedAt = this.clock.now().toISOString();
    this.persistModelApiConfig();
    return this.safeModelProfile(profile, id === this.modelApiDocument.defaultProfileId);
  }

  rollbackModelApiCredential(id: string, expectedRevision?: number): ModelApiProfile {
    const profile = this.requireStoredModelProfile(id);
    if (!profile.credentialRef) {
      throw new ModelCredentialConflictError(
        "model profile has no credential to roll back",
        expectedRevision,
      );
    }
    this.modelCredentials.rollback(profile.credentialRef, id, expectedRevision);
    profile.updatedAt = this.clock.now().toISOString();
    this.persistModelApiConfig();
    return this.safeModelProfile(profile, id === this.modelApiDocument.defaultProfileId);
  }

  scopedModelCredentialResolver(profileIds?: readonly string[]): ModelCredentialResolver {
    const selected = profileIds ? new Set(profileIds) : undefined;
    return this.modelCredentials.scopedResolver(
      this.modelApiDocument.profiles.flatMap((profile) =>
        (!selected || selected.has(profile.id)) && profile.credentialRef
        ? [{ credentialRef: profile.credentialRef, ownerProfileId: profile.id }]
        : []),
    );
  }

  /** @internal Installs one safe profile into a disposable isolated runtime. */
  installIsolatedModelApiProfile(profile: ModelApiProfile): ModelApiProfile {
    const id = profile.id.trim();
    const name = requiredProfileName(profile.name);
    if (!id) throw new ModelApiConfigValidationError("model profile id is required");
    const stored: StoredModelApiProfile = {
      ...normalizeStoredModelApiConfig(profile),
      id,
      name,
    };
    this.modelApiDocument = {
      version: 3,
      defaultProfileId: id,
      profiles: [stored],
    };
    this.persistModelApiConfig();
    return this.safeModelProfile(stored, true);
  }

  setDefaultModelApiProfile(id: string): ModelApiProfileCollection {
    this.requireStoredModelProfile(id);
    this.modelApiDocument.defaultProfileId = id;
    this.persistModelApiConfig();
    return this.listModelApiProfiles();
  }

  deleteModelApiProfile(id: string): ModelApiProfileCollection {
    const removed = this.requireStoredModelProfile(id);
    if (this.modelApiDocument.profiles.length === 1) {
      throw new Error("at least one model profile is required");
    }
    this.modelApiDocument.profiles = this.modelApiDocument.profiles.filter((entry) => entry.id !== id);
    if (this.modelApiDocument.defaultProfileId === id) {
      this.modelApiDocument.defaultProfileId = this.modelApiDocument.profiles[0].id;
    }
    this.persistModelApiConfig();
    if (removed.credentialRef) {
      this.modelCredentials.remove(removed.credentialRef, removed.id);
    }
    return this.listModelApiProfiles();
  }

  private materializeModelProfile(profile: StoredModelApiProfile): ModelApiConfig {
    const { id: _id, name: _name, ...config } = profile;
    if (!profile.credentialRef) {
      return {
        ...config,
        apiKeySet: false,
        apiKeyMasked: "",
        credentialStatus: "not_set",
        credentialCanRollback: false,
      };
    }
    const credential = this.modelCredentials.metadata(profile.credentialRef, profile.id);
    return modelConfigWithCredential(config, credential);
  }

  private materializeRawModelProfile(profile: StoredModelApiProfile): RawModelApiConfig {
    const safe = this.materializeModelProfile(profile);
    if (!profile.credentialRef) return safe;
    const credential = this.modelCredentials.resolve(profile.credentialRef, profile.id);
    return {
      ...safe,
      ...(credential.status === "active" && credential.apiKey
        ? { apiKey: credential.apiKey }
        : {}),
    };
  }

  private safeModelProfile(
    profile: StoredModelApiProfile,
    isDefault: boolean,
  ): ModelApiProfile {
    return { ...this.materializeModelProfile(profile), id: profile.id, name: profile.name, isDefault };
  }

  private previewCredentialPatch(
    profile: StoredModelApiProfile,
    patch: ModelApiConfigPatch,
  ): RawModelApiConfig {
    assertCredentialPatchShape(patch);
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
      const current = this.materializeModelProfile(profile);
      const { id: _id, name: _name, ...config } = profile;
      return {
        ...config,
        apiKeySet: true,
        apiKeyMasked: maskPreviewSecret(patch.apiKey.trim()),
        credentialRef: profile.credentialRef ?? "model-credential-preview0000000000000000000000000",
        credentialStatus: "active",
        credentialRevision: this.currentCredentialRevision(profile) + 1,
        credentialCanRollback: current.credentialStatus === "active" ||
          current.credentialStatus === "revoked",
        apiKey: patch.apiKey.trim(),
      };
    }
    if ((typeof patch.apiKey === "string" && !patch.apiKey.trim()) || patch.clearApiKey) {
      const current = this.materializeModelProfile(profile);
      return {
        ...current,
        apiKeySet: false,
        credentialStatus: profile.credentialRef ? "revoked" : "not_set",
        credentialCanRollback: Boolean(profile.credentialRef && current.apiKeySet),
      };
    }
    return this.materializeRawModelProfile(profile);
  }

  private applyModelCredentialPatch(
    profile: StoredModelApiProfile,
    patch: ModelApiConfigPatch,
  ): void {
    assertCredentialPatchShape(patch);
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
      const secret = patch.apiKey.trim();
      if (profile.credentialRef) {
        const credential = this.modelCredentials.metadata(profile.credentialRef, profile.id);
        if (credential.status === "missing") {
          assertNewCredentialRevision(patch.expectedCredentialRevision);
          profile.credentialRef = this.modelCredentials.replaceMissingReference(
            profile.id,
            secret,
          ).credentialRef;
        } else {
          this.modelCredentials.rotate(
            profile.credentialRef,
            profile.id,
            secret,
            patch.expectedCredentialRevision,
          );
        }
      } else {
        assertNewCredentialRevision(patch.expectedCredentialRevision);
        const created = this.modelCredentials.create(profile.id, secret);
        profile.credentialRef = created.credentialRef;
      }
      return;
    }
    if ((typeof patch.apiKey === "string" && !patch.apiKey.trim()) || patch.clearApiKey) {
      if (!profile.credentialRef) {
        assertNewCredentialRevision(patch.expectedCredentialRevision);
        return;
      }
      this.modelCredentials.revoke(
        profile.credentialRef,
        profile.id,
        patch.expectedCredentialRevision,
      );
    }
  }

  private currentCredentialRevision(profile: StoredModelApiProfile): number {
    if (!profile.credentialRef) return 0;
    return this.modelCredentials.metadata(profile.credentialRef, profile.id).revision ?? 0;
  }

  private requireStoredModelProfile(id: string): StoredModelApiProfile {
    const profile = this.modelApiDocument.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error(`model profile not found: ${id}`);
    return profile;
  }

  private replaceStoredModelProfile(profile: StoredModelApiProfile): void {
    const index = this.modelApiDocument.profiles.findIndex((entry) => entry.id === profile.id);
    if (index < 0) throw new Error(`model profile not found: ${profile.id}`);
    this.modelApiDocument.profiles[index] = profile;
  }

  private loadModelApiDocument(): StoredModelApiDocument {
    if (!this.modelApiConfigPath || !existsSync(this.modelApiConfigPath)) {
      return defaultModelApiDocument();
    }

    try {
      const parsed = JSON.parse(readFileSync(this.modelApiConfigPath, "utf8")) as unknown;
      const loaded = normalizeStoredModelApiDocument(parsed);
      for (const profile of loaded.document.profiles) {
        const recoveredRef = this.modelCredentials.findReferenceForOwner(profile.id);
        if (!profile.credentialRef && recoveredRef) profile.credentialRef = recoveredRef;
        const legacyApiKey = loaded.legacyApiKeys.get(profile.id);
        if (!legacyApiKey || profile.credentialRef) continue;
        profile.credentialRef = this.modelCredentials.create(profile.id, legacyApiKey).credentialRef;
      }
      return loaded.document;
    } catch (error) {
      if (
        error instanceof ModelCredentialValidationError ||
        error instanceof ModelCredentialConflictError
      ) throw error;
      return defaultModelApiDocument();
    }
  }

  private persistModelApiConfig(): void {
    if (!this.modelApiConfigPath) {
      return;
    }
    durableAtomicWrite(
      this.modelApiConfigPath,
      `${JSON.stringify(this.modelApiDocument, null, 2)}\n`,
      {
        mode: 0o600,
        failpointPrefix: "model_api",
      },
    );
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
    version: 3,
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

function maskPreviewSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeStoredModelApiConfig(value: unknown): StoredModelApiConfig {
  const input = isRecord(value) ? value : {};
  const config: StoredModelApiConfig = {
    ...defaultModelApiConfig,
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaultModelApiConfig.enabled,
    provider: isModelProviderId(input.provider) ? input.provider : defaultModelApiConfig.provider,
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : defaultModelApiConfig.baseUrl,
    model: typeof input.model === "string" ? input.model : defaultModelApiConfig.model,
    visionInputEnabled: typeof input.visionInputEnabled === "boolean"
      ? input.visionInputEnabled
      : defaultModelApiConfig.visionInputEnabled,
    ...normalizedStoredCredentialReference(input),
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
  if (isThinkingTokenBudgetField(input.thinkingTokenBudgetField)) {
    config.thinkingTokenBudgetField = input.thinkingTokenBudgetField;
  }
  if (isValidThinkingBudgetTokens(input.thinkingBudgetTokens)) {
    config.thinkingBudgetTokens = Math.floor(input.thinkingBudgetTokens);
  }
  return config;
}

function normalizedStoredCredentialReference(
  input: Record<string, unknown>,
): Pick<StoredModelApiConfig, "credentialRef"> {
  if (!Object.hasOwn(input, "credentialRef")) return {};
  if (typeof input.credentialRef === "string" && input.credentialRef.trim()) {
    return { credentialRef: input.credentialRef.trim().slice(0, 256) };
  }
  // Preserve the fact that a persisted reference was present so corrupted or
  // tampered state cannot silently regain access to provider environment keys.
  return { credentialRef: "invalid-model-credential-reference" };
}

function normalizeStoredModelApiDocument(value: unknown): {
  document: StoredModelApiDocument;
  legacyApiKeys: Map<string, string>;
} {
  const input = isRecord(value) ? value : {};
  const legacyApiKeys = new Map<string, string>();
  if ((input.version !== 2 && input.version !== 3) || !Array.isArray(input.profiles)) {
    const legacyApiKey = normalizedLegacyApiKey(input.apiKey);
    if (legacyApiKey) legacyApiKeys.set(defaultModelProfileId, legacyApiKey);
    return {
      document: {
        version: 3,
        defaultProfileId: defaultModelProfileId,
        profiles: [{
          ...normalizeStoredModelApiConfig(value),
          id: defaultModelProfileId,
          name: "默认模型",
        }],
      },
      legacyApiKeys,
    };
  }
  const seen = new Set<string>();
  const profiles = input.profiles.flatMap((entry): StoredModelApiProfile[] => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    const legacyApiKey = normalizedLegacyApiKey(entry.apiKey);
    if (legacyApiKey) legacyApiKeys.set(id, legacyApiKey);
    return [{ ...normalizeStoredModelApiConfig(entry), id, name }];
  });
  if (!profiles.length) return { document: defaultModelApiDocument(), legacyApiKeys };
  const requestedDefault = typeof input.defaultProfileId === "string" ? input.defaultProfileId : "";
  return {
    document: {
      version: 3,
      defaultProfileId: profiles.some((entry) => entry.id === requestedDefault)
        ? requestedDefault
        : profiles[0].id,
      profiles,
    },
    legacyApiKeys,
  };
}

function normalizedLegacyApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function modelConfigWithCredential(
  config: StoredModelApiConfig,
  credential: ModelCredentialMetadata,
): ModelApiConfig {
  const active = credential.status === "active";
  return {
    ...config,
    credentialRef: credential.credentialRef,
    credentialStatus: credential.status,
    credentialCanRollback: credential.canRollback,
    ...(credential.revision !== undefined
      ? { credentialRevision: credential.revision }
      : {}),
    apiKeySet: active,
    apiKeyMasked: active ? credential.masked : "",
  };
}

function assertCredentialPatchShape(patch: ModelApiConfigPatch): void {
  if (patch.apiKey !== undefined && typeof patch.apiKey !== "string") {
    throw new ModelApiConfigValidationError("apiKey must be a string");
  }
  if (patch.clearApiKey !== undefined && typeof patch.clearApiKey !== "boolean") {
    throw new ModelApiConfigValidationError("clearApiKey must be a boolean");
  }
  if (patch.apiKey !== undefined && patch.clearApiKey === true) {
    throw new ModelApiConfigValidationError("apiKey and clearApiKey cannot be set together");
  }
  if (
    patch.expectedCredentialRevision !== undefined &&
    (!Number.isInteger(patch.expectedCredentialRevision) ||
      patch.expectedCredentialRevision < 0)
  ) {
    throw new ModelApiConfigValidationError(
      "expectedCredentialRevision must be a non-negative integer",
    );
  }
}

function assertStructuralCredentialDraft(patch: ModelApiProfilePatch): void {
  if (
    patch.apiKey !== undefined ||
    patch.clearApiKey !== undefined ||
    patch.expectedCredentialRevision !== undefined
  ) {
    throw new ModelApiConfigValidationError(
      "profilePatch cannot contain credential fields",
    );
  }
}

function assertNewCredentialRevision(expectedRevision: number | undefined): void {
  if (expectedRevision === undefined || expectedRevision === 0) return;
  throw new ModelCredentialConflictError(
    "model credential revision changed",
    expectedRevision,
    0,
  );
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
  if (patch.provider !== undefined && !isModelProviderId(patch.provider)) {
    throw new ModelApiConfigValidationError(
      "provider must match ^[a-z][a-z0-9_-]{0,63}$",
    );
  }
  if (
    patch.reasoningEffort !== undefined &&
    patch.reasoningEffort !== null &&
    !isModelReasoningEffort(patch.reasoningEffort)
  ) {
    throw new ModelApiConfigValidationError(
      "reasoningEffort must be none, minimal, low, medium, high, xhigh, max, ultra, or null",
    );
  }
  if (
    patch.thinkingTokenBudgetField !== undefined &&
    patch.thinkingTokenBudgetField !== null &&
    !isThinkingTokenBudgetField(patch.thinkingTokenBudgetField)
  ) {
    throw new ModelApiConfigValidationError(
      "thinkingTokenBudgetField must be thinking_token_budget, thinking_budget, thinking_budget_tokens, or null",
    );
  }
  if (
    patch.thinkingBudgetTokens !== undefined &&
    patch.thinkingBudgetTokens !== null &&
    !isValidThinkingBudgetTokens(patch.thinkingBudgetTokens)
  ) {
    throw new ModelApiConfigValidationError(
      `thinkingBudgetTokens must be an integer from 1 to ${maximumThinkingBudgetTokens}, or null`,
    );
  }
  if (patch.name !== undefined) profile.name = requiredProfileName(patch.name);
  if (typeof patch.enabled === "boolean") profile.enabled = patch.enabled;
  if (isModelProviderId(patch.provider)) profile.provider = patch.provider;
  if (typeof patch.baseUrl === "string") profile.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === "string") profile.model = patch.model.trim();
  if (typeof patch.visionInputEnabled === "boolean") profile.visionInputEnabled = patch.visionInputEnabled;
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
  if (patch.thinkingTokenBudgetField === null) delete profile.thinkingTokenBudgetField;
  else if (isThinkingTokenBudgetField(patch.thinkingTokenBudgetField)) {
    profile.thinkingTokenBudgetField = patch.thinkingTokenBudgetField;
  }
  if (patch.thinkingBudgetTokens === null) delete profile.thinkingBudgetTokens;
  else if (isValidThinkingBudgetTokens(patch.thinkingBudgetTokens)) {
    profile.thinkingBudgetTokens = Math.floor(patch.thinkingBudgetTokens);
  }
  profile.updatedAt = updatedAt;
}

function boundedContextWindow(value: number): number {
  return Math.max(8_192, Math.min(2_000_000, Math.floor(value)));
}

function isThinkingTokenBudgetField(value: unknown): value is NonNullable<ModelApiConfig["thinkingTokenBudgetField"]> {
  return typeof value === "string" && thinkingTokenBudgetFields.has(value);
}

function isValidThinkingBudgetTokens(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximumThinkingBudgetTokens;
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
