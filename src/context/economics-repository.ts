import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
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
        id, session_id, mode, turn_kind, system_hash, metrics_json, plan_json,
        message_digests_json, actual_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.sessionId,
      entry.mode,
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

  latestForSession(sessionId: string): ContextEconomics | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM context_economics WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(sessionId) as Row | undefined;
    return row ? mapEconomics(row) : undefined;
  }

  recent(limit = 50): ContextEconomics[] {
    const rows = this.database.connection.prepare(
      "SELECT * FROM context_economics ORDER BY sequence DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 100)) as Row[];
    return rows.map(mapEconomics);
  }

  bootstrapConsumed(sessionId: string): boolean {
    return Boolean(this.database.connection.prepare(
      "SELECT 1 FROM memory_context_sessions WHERE session_id = ?",
    ).get(sessionId));
  }

  residentMemoryVersions(sessionId: string): Map<string, string> {
    const rows = this.database.connection.prepare(
      "SELECT memory_id, memory_version FROM memory_context_items WHERE session_id = ?",
    ).all(sessionId) as Row[];
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
    memoryVersions: Record<string, string>,
    consumeBootstrap: boolean,
  ): void {
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      if (consumeBootstrap) {
        this.database.connection.prepare(`
          INSERT INTO memory_context_sessions(session_id, bootstrap_completed_at)
          VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING
        `).run(sessionId, now);
      }
      const statement = this.database.connection.prepare(`
        INSERT INTO memory_retrieval_stats(memory_id, hit_count, last_hit_at)
        VALUES (?, 1, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          hit_count = memory_retrieval_stats.hit_count + 1,
          last_hit_at = excluded.last_hit_at
      `);
      const resident = this.database.connection.prepare(`
        INSERT INTO memory_context_items(session_id, memory_id, memory_version, injected_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, memory_id) DO UPDATE SET
          memory_version = excluded.memory_version,
          injected_at = excluded.injected_at
      `);
      for (const [id, version] of Object.entries(memoryVersions)) {
        statement.run(id, now);
        resident.run(sessionId, id, version, now);
      }
    });
  }

  resetResidentMemories(sessionId: string): void {
    this.replaceResidentMemories(sessionId, new Map());
  }

  replaceResidentMemories(sessionId: string, versions: Map<string, string>): void {
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(
        "DELETE FROM memory_context_items WHERE session_id = ?",
      ).run(sessionId);
      const statement = this.database.connection.prepare(`
        INSERT INTO memory_context_items(session_id, memory_id, memory_version, injected_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [id, version] of versions) statement.run(sessionId, id, version, now);
    });
  }

  contextState(): {
    bootstrapSessions: Array<{ sessionId: string; completedAt: string }>;
    residentMemories: Array<{ sessionId: string; memoryId: string; memoryVersion: string; injectedAt: string }>;
  } {
    const bootstrap = this.database.connection.prepare(
      "SELECT * FROM memory_context_sessions ORDER BY session_id",
    ).all() as Row[];
    const residents = this.database.connection.prepare(
      "SELECT * FROM memory_context_items ORDER BY session_id, memory_id",
    ).all() as Row[];
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

  memoryStats(): MemoryRetrievalStat[] {
    return (this.database.connection.prepare(
      "SELECT * FROM memory_retrieval_stats ORDER BY hit_count DESC, memory_id",
    ).all() as Row[]).map((row) => ({
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
