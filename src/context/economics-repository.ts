import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace } from "../domain/types.js";
import type { AppDatabase } from "../storage/database.js";
import type {
  ActualProviderUsage,
  ContextEconomics,
  MemoryRetrievalStat,
} from "./types.js";
import type { RpMemory } from "../rp/types.js";
import { memoryContextVersion } from "./memory-version.js";

type Row = Record<string, unknown>;

export class ContextEconomicsRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  record(input: Omit<ContextEconomics, "id" | "createdAt" | "actual">): ContextEconomics {
    const entry: ContextEconomics = {
      ...input,
      id: this.idGenerator.next("context-economics"),
      actual: unknownActualUsage(),
      createdAt: this.clock.now().toISOString(),
    };
    this.database.connection.prepare(`
      INSERT INTO context_economics(
        id, session_id, mode, conversation_space, secret_owner_character_id,
        turn_kind, system_hash, metrics_json, plan_json,
        message_digests_json, actual_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.sessionId,
      entry.mode,
      entry.conversationSpace,
      entry.secretOwnerCharacterId ?? null,
      entry.turnKind,
      entry.systemHash,
      JSON.stringify(metricsFor(entry)),
      JSON.stringify(entry.plan),
      JSON.stringify(entry.messageDigests),
      JSON.stringify(entry.actual),
      entry.createdAt,
    );
    this.trim();
    return entry;
  }

  updateActual(id: string, actual: ActualProviderUsage): void {
    this.database.connection.prepare(
      "UPDATE context_economics SET actual_json = ? WHERE id = ?",
    ).run(JSON.stringify(actual), id);
  }

  remove(id: string): void {
    this.database.connection.prepare("DELETE FROM context_economics WHERE id = ?").run(id);
  }

  latestForSession(
    sessionId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): ContextEconomics | undefined {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(
      `SELECT * FROM context_economics
       WHERE session_id = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
       ORDER BY sequence DESC LIMIT 1`,
    ).get(sessionId, conversationSpace, secretOwnerCharacterId ?? null) as Row | undefined;
    return row ? mapEconomics(row) : undefined;
  }

  recent(
    limit = 50,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): ContextEconomics[] {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const rows = this.database.connection.prepare(
      `SELECT * FROM context_economics
       WHERE conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
       ORDER BY sequence DESC LIMIT ?`,
    ).all(
      conversationSpace,
      secretOwnerCharacterId ?? null,
      Math.min(Math.max(limit, 1), 100),
    ) as Row[];
    return rows.map(mapEconomics);
  }

  bootstrapConsumed(
    sessionId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): boolean {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    return Boolean(this.database.connection.prepare(
      `SELECT 1 FROM memory_context_sessions
       WHERE session_id = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
    ).get(sessionId, conversationSpace, secretOwnerCharacterId ?? null));
  }

  residentMemoryVersions(
    sessionId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): Map<string, string> {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const rows = this.database.connection.prepare(
      `SELECT memory_id, memory_version FROM memory_context_items
       WHERE session_id = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
    ).all(sessionId, conversationSpace, secretOwnerCharacterId ?? null) as Row[];
    return new Map(rows.map((row) => [String(row.memory_id), String(row.memory_version)]));
  }

  reconcileAfterVaultRecovery(memories: RpMemory[]): number {
    const valid = new Map(
      memories
        .filter((memory) => memory.validity === "active" && memory.confirmed && memory.realm !== "legacy")
        .map((memory) => [memory.id, memoryContextVersion(memory)]),
    );
    const rows = this.database.connection.prepare(
      "SELECT session_id, memory_id, memory_version FROM memory_context_items",
    ).all() as Row[];
    let removed = 0;
    this.database.transaction(() => {
      const remove = this.database.connection.prepare(
        "DELETE FROM memory_context_items WHERE session_id = ? AND memory_id = ?",
      );
      for (const row of rows) {
        if (valid.get(String(row.memory_id)) === String(row.memory_version)) continue;
        removed += Number(remove.run(String(row.session_id), String(row.memory_id)).changes);
      }
    });
    return removed;
  }

  commitProviderMemoryUse(
    sessionId: string,
    conversationSpace: ConversationSpace,
    secretOwnerCharacterId: string | undefined,
    memoryVersions: Record<string, string>,
    consumeBootstrap: boolean,
  ): void {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      if (consumeBootstrap) {
        this.database.connection.prepare(`
          INSERT INTO memory_context_sessions(
            session_id, bootstrap_completed_at, conversation_space, secret_owner_character_id
          ) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING
        `).run(sessionId, now, conversationSpace, secretOwnerCharacterId ?? null);
      }
      const statement = this.database.connection.prepare(`
        INSERT INTO memory_retrieval_stats(memory_id, hit_count, last_hit_at)
        VALUES (?, 1, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          hit_count = memory_retrieval_stats.hit_count + 1,
          last_hit_at = excluded.last_hit_at
      `);
      const resident = this.database.connection.prepare(`
        INSERT INTO memory_context_items(
          session_id, memory_id, memory_version, injected_at,
          conversation_space, secret_owner_character_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, memory_id) DO UPDATE SET
          memory_version = excluded.memory_version,
          injected_at = excluded.injected_at
      `);
      for (const [id, version] of Object.entries(memoryVersions)) {
        statement.run(id, now);
        resident.run(
          sessionId,
          id,
          version,
          now,
          conversationSpace,
          secretOwnerCharacterId ?? null,
        );
      }
    });
  }

  resetResidentMemories(
    sessionId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): void {
    this.replaceResidentMemories(
      sessionId,
      new Map(),
      conversationSpace,
      secretOwnerCharacterId,
    );
  }

  replaceResidentMemories(
    sessionId: string,
    versions: Map<string, string>,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): void {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(
        `DELETE FROM memory_context_items
         WHERE session_id = ? AND conversation_space = ?
           AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
      ).run(sessionId, conversationSpace, secretOwnerCharacterId ?? null);
      const statement = this.database.connection.prepare(`
        INSERT INTO memory_context_items(
          session_id, memory_id, memory_version, injected_at,
          conversation_space, secret_owner_character_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [id, version] of versions) {
        statement.run(
          sessionId,
          id,
          version,
          now,
          conversationSpace,
          secretOwnerCharacterId ?? null,
        );
      }
    });
  }

  contextState(
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): {
    bootstrapSessions: Array<{ sessionId: string; completedAt: string }>;
    residentMemories: Array<{ sessionId: string; memoryId: string; memoryVersion: string; injectedAt: string }>;
  } {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    const bootstrap = this.database.connection.prepare(`
      SELECT * FROM memory_context_sessions
      WHERE conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY session_id
    `).all(conversationSpace, secretOwnerCharacterId ?? null) as Row[];
    const residents = this.database.connection.prepare(`
      SELECT * FROM memory_context_items
      WHERE conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY session_id, memory_id
    `).all(conversationSpace, secretOwnerCharacterId ?? null) as Row[];
    return {
      bootstrapSessions: bootstrap.map((row) => ({
        sessionId: String(row.session_id),
        completedAt: String(row.bootstrap_completed_at),
      })),
      residentMemories: residents.map((row) => ({
        sessionId: String(row.session_id),
        memoryId: String(row.memory_id),
        memoryVersion: String(row.memory_version),
        injectedAt: String(row.injected_at),
      })),
    };
  }

  memoryStats(
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): MemoryRetrievalStat[] {
    assertContextSpace(conversationSpace, secretOwnerCharacterId);
    return (this.database.connection.prepare(`
      SELECT stats.* FROM memory_retrieval_stats stats
      JOIN rp_memories memory ON memory.id = stats.memory_id
      WHERE memory.conversation_space = ?
        AND COALESCE(memory.secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY stats.hit_count DESC, stats.memory_id
    `).all(conversationSpace, secretOwnerCharacterId ?? null) as Row[]).map((row) => ({
      memoryId: String(row.memory_id),
      hitCount: Number(row.hit_count),
      ...(typeof row.last_hit_at === "string" ? { lastHitAt: row.last_hit_at } : {}),
    }));
  }

  private trim(): void {
    this.database.connection.exec(`
      DELETE FROM context_economics WHERE sequence NOT IN (
        SELECT sequence FROM context_economics ORDER BY sequence DESC LIMIT 100
      )
    `);
  }
}

function metricsFor(entry: ContextEconomics) {
  const { id: _id, sessionId: _sessionId, mode: _mode, turnKind: _turnKind,
    systemHash: _systemHash, actual: _actual, plan: _plan,
    messageDigests: _messageDigests, createdAt: _createdAt, ...metrics } = entry;
  return metrics;
}

function mapEconomics(row: Row): ContextEconomics {
  const metrics = parseJson<Record<string, unknown>>(row.metrics_json, {});
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    mode: row.mode as ContextEconomics["mode"],
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    ...(typeof row.secret_owner_character_id === "string" && row.secret_owner_character_id
      ? { secretOwnerCharacterId: row.secret_owner_character_id }
      : {}),
    turnKind: row.turn_kind as ContextEconomics["turnKind"],
    systemHash: String(row.system_hash),
    toolSchemaHash: typeof metrics.toolSchemaHash === "string" ? metrics.toolSchemaHash : "",
    messageCount: Number(metrics.messageCount ?? 0),
    estimatedInputTokens: Number(metrics.estimatedInputTokens ?? 0),
    stableEstimatedTokens: Number(metrics.stableEstimatedTokens ?? 0),
    dynamicEstimatedTokens: Number(metrics.dynamicEstimatedTokens ?? 0),
    memoryEstimatedTokens: Number(metrics.memoryEstimatedTokens ?? 0),
    toolEstimatedTokens: Number(metrics.toolEstimatedTokens ?? 0),
    memoryIds: stringArray(metrics.memoryIds),
    plannerBudgetTokens: Number(metrics.plannerBudgetTokens ?? 0),
    plannerTruncated: Boolean(metrics.plannerTruncated),
    lcpMessageCount: Number(metrics.lcpMessageCount ?? 0),
    lcpEstimatedTokens: Number(metrics.lcpEstimatedTokens ?? 0),
    prefixReuseRatio: Number(metrics.prefixReuseRatio ?? 0),
    cacheBreakReason: typeof metrics.cacheBreakReason === "string" ? metrics.cacheBreakReason : null,
    actual: parseJson<ActualProviderUsage>(row.actual_json, unknownActualUsage()),
    plan: parseJson<ContextEconomics["plan"]>(row.plan_json, {} as ContextEconomics["plan"]),
    messageDigests: parseJson<ContextEconomics["messageDigests"]>(row.message_digests_json, []),
    createdAt: String(row.created_at),
  };
}

function unknownActualUsage(): ActualProviderUsage {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function assertContextSpace(
  conversationSpace: ConversationSpace,
  secretOwnerCharacterId?: string,
): void {
  if (conversationSpace === "secret" && !secretOwnerCharacterId?.trim()) {
    throw new Error("secret context economics requires secretOwnerCharacterId");
  }
  if (conversationSpace === "normal" && secretOwnerCharacterId) {
    throw new Error("normal context economics cannot have secretOwnerCharacterId");
  }
}
