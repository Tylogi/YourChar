import type { ActionRecord, ContextLogEntry, Mode, ModelContextTrace } from "../domain/types.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export interface ObservabilitySink {
  recordAction(action: ActionRecord): void;
  recordContextLog(log: ContextLogEntry): void;
  recordModelContextTrace(trace: ModelContextTrace): void;
  recentContextLogs(limit: number): ContextLogEntry[];
  recentModelContextTraces(limit: number): ModelContextTrace[];
  allActions(): ActionRecord[];
}

export class ObservabilityRepository implements ObservabilitySink {
  constructor(private readonly database: AppDatabase) {}

  recordAction(action: ActionRecord): void {
    this.database.connection.prepare(`
      INSERT OR REPLACE INTO audit_actions(id, action_type, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(action.id, action.actionType, action.status, boundedJson(action.payload, 32_000), action.createdAt);
    this.trim();
  }

  recordContextLog(log: ContextLogEntry): void {
    this.database.connection.prepare(`
      INSERT OR REPLACE INTO context_log_summaries(
        id, session_id, mode, request_text, system_prompt_excerpt, message_count_before,
        tool_names_json, reply, actions_json, event_types_json, turn_status, can_retry, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.id,
      log.sessionId,
      log.mode,
      truncate(log.requestText, 8_000),
      truncate(log.systemPrompt, 12_000),
      log.messageCountBefore,
      boundedJson(log.toolNames, 8_000),
      truncate(log.reply, 12_000),
      boundedJson(log.actions, 32_000),
      boundedJson(log.events.map((event) => event.type), 8_000),
      log.status,
      log.canRetry ? 1 : 0,
      log.createdAt,
    );
    this.trim();
  }

  recentContextLogs(limit: number): ContextLogEntry[] {
    const rows = this.database.connection.prepare(
      "SELECT * FROM context_log_summaries ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 100)) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      mode: row.mode as Mode,
      requestText: String(row.request_text),
      systemPrompt: String(row.system_prompt_excerpt),
      messageCountBefore: Number(row.message_count_before),
      toolNames: parseJson<string[]>(row.tool_names_json, []),
      reply: String(row.reply),
      status: normalizeTurnStatus(row.turn_status),
      canRetry: Boolean(row.can_retry),
      actions: parseJson<ActionRecord[]>(row.actions_json, []),
      events: parseJson<string[]>(row.event_types_json, []).map((type) => ({ type }) as ContextLogEntry["events"][number]),
      createdAt: String(row.created_at),
    }));
  }

  recordModelContextTrace(trace: ModelContextTrace): void {
    this.database.connection.prepare(`
      INSERT INTO model_context_traces(
        id, session_id, mode, turn_kind, request_text, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.id,
      trace.sessionId,
      trace.mode,
      trace.turnKind,
      trace.requestText,
      JSON.stringify(trace.payload),
      trace.createdAt,
    );
    this.trim();
  }

  recentModelContextTraces(limit: number): ModelContextTrace[] {
    const rows = this.database.connection.prepare(
      "SELECT * FROM model_context_traces ORDER BY sequence DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 10)) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      mode: row.mode as Mode,
      turnKind: row.turn_kind as ModelContextTrace["turnKind"],
      requestText: String(row.request_text),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  allActions(): ActionRecord[] {
    return (this.database.connection.prepare(
      "SELECT * FROM audit_actions ORDER BY created_at, id",
    ).all() as Row[]).map((row) => ({
      id: String(row.id),
      actionType: String(row.action_type),
      status: row.status as ActionRecord["status"],
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  private trim(): void {
    this.database.connection.exec(`
      DELETE FROM audit_actions WHERE id NOT IN (
        SELECT id FROM audit_actions ORDER BY created_at DESC, id DESC LIMIT 1000
      );
      DELETE FROM context_log_summaries WHERE id NOT IN (
        SELECT id FROM context_log_summaries ORDER BY created_at DESC, id DESC LIMIT 200
      );
      DELETE FROM model_context_traces WHERE sequence NOT IN (
        SELECT sequence FROM model_context_traces ORDER BY sequence DESC LIMIT 10
      );
    `);
  }
}

function normalizeTurnStatus(value: unknown): ContextLogEntry["status"] {
  return value === "failed" || value === "cancelled" || value === "blocked" ? value : "completed";
}

function boundedJson(value: unknown, limit: number): string {
  const json = JSON.stringify(value);
  return json.length <= limit
    ? json
    : JSON.stringify({ truncated: true, preview: json.slice(0, Math.max(0, limit - 64)) });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}
