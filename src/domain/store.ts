import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import { SystemIdGenerator } from "../app/id-generator.js";
import type { ObservabilitySink } from "../storage/observability.js";
import type {
  ActionRecord,
  ContextLogEntry,
  ModelApiConfig,
  ModelApiConfigPatch,
  ModelContextTrace,
} from "./types.js";

type StoredModelApiConfig = ModelApiConfig & { apiKey?: string };

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

export class CompanionStore {
  readonly stateDir?: string;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly actions: ActionRecord[] = [];
  readonly contextLogs: ContextLogEntry[] = [];
  readonly modelContextTraces: ModelContextTrace[] = [];
  private readonly modelApiConfigPath?: string;
  private modelApiConfig: StoredModelApiConfig;
  private observability?: ObservabilitySink;
  private modelRequestCount = 0;

  constructor(options: CompanionStoreOptions = {}) {
    const stateDir =
      options.stateDir === undefined ? process.env.RP_AGENT_STATE_DIR ?? ".rp-agent" : options.stateDir;
    this.stateDir = stateDir === false ? undefined : resolve(stateDir);
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new SystemIdGenerator();
    this.modelApiConfigPath = this.stateDir ? join(this.stateDir, "model-api.json") : undefined;
    this.modelApiConfig = this.loadModelApiConfig();
    if (this.modelApiConfigPath && existsSync(this.modelApiConfigPath)) {
      chmodSync(this.modelApiConfigPath, 0o600);
    }
  }

  addAction(actionType: string, status: ActionRecord["status"], payload: Record<string, unknown>): ActionRecord {
    const action: ActionRecord = {
      id: this.idGenerator.next("action"),
      actionType,
      status,
      payload,
      createdAt: this.clock.now().toISOString(),
    };
    this.actions.push(action);
    this.observability?.recordAction(action);
    return action;
  }

  addContextLog(entry: Omit<ContextLogEntry, "id" | "createdAt">): ContextLogEntry {
    const log: ContextLogEntry = {
      ...entry,
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

  recentContextLogs(limit = 20): ContextLogEntry[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    return this.contextLogs.length ? this.contextLogs.slice(0, bounded) : this.observability?.recentContextLogs(bounded) ?? [];
  }

  latestContextLog(sessionId: string): ContextLogEntry | undefined {
    return this.contextLogs.find((entry) => entry.sessionId === sessionId) ??
      this.observability?.recentContextLogs(100).find((entry) => entry.sessionId === sessionId);
  }

  addModelContextTrace(
    entry: Omit<ModelContextTrace, "id" | "createdAt" | "payload"> & {
      payload: Record<string, unknown>;
    },
  ): ModelContextTrace {
    this.modelRequestCount += 1;
    const trace: ModelContextTrace = {
      ...entry,
      payload: sanitizeTracePayload(entry.payload),
      id: this.idGenerator.next("model-trace"),
      createdAt: this.clock.now().toISOString(),
    };
    this.modelContextTraces.unshift(trace);
    if (this.modelContextTraces.length > 10) {
      this.modelContextTraces.length = 10;
    }
    this.observability?.recordModelContextTrace(trace);
    return trace;
  }

  recentModelContextTraces(limit = 10): ModelContextTrace[] {
    const requested = Number.isFinite(limit) ? limit : 10;
    const bounded = Math.max(1, Math.min(requested, 10));
    return this.observability?.recentModelContextTraces(bounded) ??
      this.modelContextTraces.slice(0, bounded);
  }

  getModelRequestCount(): number {
    return this.modelRequestCount;
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
  }

  deleteSessionRuntimeData(sessionId: string): void {
    removeWhere(this.contextLogs, (entry) => entry.sessionId === sessionId);
    removeWhere(this.modelContextTraces, (entry) => entry.sessionId === sessionId);
  }

  getModelApiConfig(): ModelApiConfig {
    const { apiKey: _apiKey, ...safe } = this.modelApiConfig;
    return { ...safe };
  }

  getRawModelApiConfig(): ModelApiConfig & { apiKey?: string } {
    return { ...this.modelApiConfig };
  }

  patchModelApiConfig(patch: ModelApiConfigPatch): ModelApiConfig {
    if (typeof patch.enabled === "boolean") {
      this.modelApiConfig.enabled = patch.enabled;
    }
    if (typeof patch.baseUrl === "string") {
      this.modelApiConfig.baseUrl = patch.baseUrl.trim();
    }
    if (typeof patch.model === "string") {
      this.modelApiConfig.model = patch.model.trim();
    }
    if (typeof patch.visionInputEnabled === "boolean") {
      this.modelApiConfig.visionInputEnabled = patch.visionInputEnabled;
    }
    if (typeof patch.apiKey === "string") {
      const apiKey = patch.apiKey.trim();
      if (apiKey) {
        this.modelApiConfig.apiKey = apiKey;
        this.modelApiConfig.apiKeySet = true;
        this.modelApiConfig.apiKeyMasked = maskSecret(apiKey);
      } else {
        delete this.modelApiConfig.apiKey;
        this.modelApiConfig.apiKeySet = false;
        this.modelApiConfig.apiKeyMasked = "";
      }
    }
    if (patch.clearApiKey) {
      delete this.modelApiConfig.apiKey;
      this.modelApiConfig.apiKeySet = false;
      this.modelApiConfig.apiKeyMasked = "";
    }
    if (patch.temperature === null) {
      delete this.modelApiConfig.temperature;
    } else if (typeof patch.temperature === "number") {
      this.modelApiConfig.temperature = patch.temperature;
    }
    if (patch.maxTokens === null) {
      delete this.modelApiConfig.maxTokens;
    } else if (typeof patch.maxTokens === "number") {
      this.modelApiConfig.maxTokens = Math.max(1, Math.floor(patch.maxTokens));
    }
    this.modelApiConfig.updatedAt = this.clock.now().toISOString();
    this.persistModelApiConfig();
    return this.getModelApiConfig();
  }

  private loadModelApiConfig(): StoredModelApiConfig {
    if (!this.modelApiConfigPath || !existsSync(this.modelApiConfigPath)) {
      return { ...defaultModelApiConfig };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.modelApiConfigPath, "utf8")) as unknown;
      return normalizeStoredModelApiConfig(parsed);
    } catch {
      return { ...defaultModelApiConfig };
    }
  }

  private persistModelApiConfig(): void {
    if (!this.modelApiConfigPath) {
      return;
    }
    mkdirSync(dirname(this.modelApiConfigPath), { recursive: true });
    writeFileSync(this.modelApiConfigPath, JSON.stringify(this.modelApiConfig, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(this.modelApiConfigPath, 0o600);
  }
}

function removeWhere<T>(entries: T[], predicate: (entry: T) => boolean): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) entries.splice(index, 1);
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
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const sensitiveTraceField = /^(authorization|api[-_]?key|access[-_]?token|secret|password)$/i;

function sanitizeTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (sensitiveTraceField.test(key)) return "[REDACTED]";
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
