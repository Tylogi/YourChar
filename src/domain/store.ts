import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentMessage } from "../harness/index.js";
import type {
  ActionRecord,
  ContextLogEntry,
  Memory,
  Mode,
  ModelApiConfig,
  ModelApiConfigPatch,
  Reminder,
  SessionRecord,
} from "./types.js";

type StoredModelApiConfig = ModelApiConfig & { apiKey?: string };

export type CompanionStoreOptions = {
  stateDir?: string | false;
};

const defaultModelApiConfig: StoredModelApiConfig = {
  enabled: false,
  provider: "openai_compatible",
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "",
  apiKeySet: false,
  apiKeyMasked: "",
};

export class CompanionStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly reminders = new Map<string, Reminder>();
  readonly memories: Memory[] = [];
  readonly actions: ActionRecord[] = [];
  readonly contextLogs: ContextLogEntry[] = [];
  private readonly modelApiConfigPath?: string;
  private modelApiConfig: StoredModelApiConfig;

  constructor(options: CompanionStoreOptions = {}) {
    const stateDir =
      options.stateDir === undefined ? process.env.RP_AGENT_STATE_DIR ?? ".rp-agent" : options.stateDir;
    this.modelApiConfigPath = stateDir === false ? undefined : join(resolve(stateDir), "model-api.json");
    this.modelApiConfig = this.loadModelApiConfig();
  }

  getSession(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created: SessionRecord = {
      id: sessionId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  appendMessages(sessionId: string, messages: AgentMessage[]): void {
    const session = this.getSession(sessionId);
    session.messages.push(...messages);
    session.updatedAt = new Date().toISOString();
  }

  createReminder(input: {
    title: string;
    remindAt: string;
    timezone: string;
    metadata?: Record<string, unknown>;
  }): Reminder {
    const now = new Date().toISOString();
    const reminder: Reminder = {
      id: randomUUID(),
      title: input.title,
      remindAt: input.remindAt,
      timezone: input.timezone,
      status: "scheduled",
      metadata: input.metadata ?? {},
      createdAt: now,
    };
    this.reminders.set(reminder.id, reminder);
    return reminder;
  }

  addMemory(input: {
    mode: Mode;
    sessionId: string;
    characterId?: string;
    content: string;
    tags?: string[];
  }): Memory {
    const memory: Memory = {
      id: randomUUID(),
      mode: input.mode,
      sessionId: input.sessionId,
      characterId: input.characterId,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    this.memories.push(memory);
    return memory;
  }

  addAction(actionType: string, status: ActionRecord["status"], payload: Record<string, unknown>): ActionRecord {
    const action: ActionRecord = {
      id: randomUUID(),
      actionType,
      status,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.actions.push(action);
    return action;
  }

  addContextLog(entry: Omit<ContextLogEntry, "id" | "createdAt">): ContextLogEntry {
    const log: ContextLogEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.contextLogs.unshift(log);
    if (this.contextLogs.length > 100) {
      this.contextLogs.length = 100;
    }
    return log;
  }

  recentContextLogs(limit = 20): ContextLogEntry[] {
    return this.contextLogs.slice(0, Math.max(1, Math.min(limit, 100)));
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
    this.modelApiConfig.updatedAt = new Date().toISOString();
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
    writeFileSync(this.modelApiConfigPath, JSON.stringify(this.modelApiConfig, null, 2), "utf8");
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
