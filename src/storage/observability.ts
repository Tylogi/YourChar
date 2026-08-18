import { modelContextTraceScope } from "../domain/types.js";
import type {
  ActionRecord,
  ConversationSpace,
  ContextLogEntry,
  Mode,
  ModelContextTrace,
  ModelContextTraceScope,
} from "../domain/types.js";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export interface ObservabilitySink {
  recordAction(action: ActionRecord): void;
  recordContextLog(log: ContextLogEntry): void;
  recordModelContextTrace(trace: ModelContextTrace): void;
  recentContextLogs(
    limit: number,
    conversationSpace?: ConversationSpace,
    secretOwnerCharacterId?: string,
  ): ContextLogEntry[];
  recentContextLogsAcrossSpaces(limit: number): ContextLogEntry[];
  recentModelContextTraces(
    limit: number,
    scope?: ModelContextTraceScope,
    conversationSpace?: ConversationSpace,
    secretOwnerCharacterId?: string,
  ): ModelContextTrace[];
  allActions(): ActionRecord[];
}

export class ObservabilityRepository implements ObservabilitySink {
  constructor(private readonly database: AppDatabase) {}

  recordAction(action: ActionRecord): void {
    this.database.connection.prepare(`
      INSERT OR REPLACE INTO audit_actions(id, action_type, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      action.id,
      action.actionType,
      action.status,
      encodeActionPayload(action),
      action.createdAt,
    );
    this.trim();
  }

  recordContextLog(log: ContextLogEntry): void {
    this.database.connection.prepare(`
      INSERT OR REPLACE INTO context_log_summaries(
        id, session_id, mode, conversation_space, secret_owner_character_id,
        request_text, system_prompt_excerpt, message_count_before,
        tool_names_json, reply, actions_json, event_types_json, turn_status, can_retry, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.id,
      log.sessionId,
      log.mode,
      log.conversationSpace,
      log.secretOwnerCharacterId ?? null,
      truncate(log.requestText, 8_000),
      truncate(log.systemPrompt, 12_000),
      log.messageCountBefore,
      boundedStringArrayJson(log.toolNames, 8_000),
      truncate(log.reply, 12_000),
      boundedActionsJson(log.actions, 32_000),
      boundedStringArrayJson(log.events.map((event) => event.type), 8_000),
      log.status,
      log.canRetry ? 1 : 0,
      log.createdAt,
    );
    this.trim();
  }

  recentContextLogs(
    limit: number,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): ContextLogEntry[] {
    const rows = this.database.connection.prepare(
      `SELECT * FROM context_log_summaries
       WHERE conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      conversationSpace,
      secretOwnerCharacterId ?? null,
      Math.min(Math.max(limit, 1), 100),
    ) as Row[];
    return rows.map((row) => this.mapContextLog(row));
  }

  recentContextLogsAcrossSpaces(limit: number): ContextLogEntry[] {
    const rows = this.database.connection.prepare(
      "SELECT * FROM context_log_summaries ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 100)) as Row[];
    return rows.map((row) => this.mapContextLog(row));
  }

  private mapContextLog(row: Row): ContextLogEntry {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      mode: row.mode as Mode,
      conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
      ...(typeof row.secret_owner_character_id === "string" && row.secret_owner_character_id
        ? { secretOwnerCharacterId: row.secret_owner_character_id }
        : {}),
      requestText: String(row.request_text),
      systemPrompt: String(row.system_prompt_excerpt),
      messageCountBefore: Number(row.message_count_before),
      toolNames: parseJsonArray<string>(row.tool_names_json),
      reply: String(row.reply),
      status: normalizeTurnStatus(row.turn_status),
      canRetry: Boolean(row.can_retry),
      actions: parseJsonArray<ActionRecord>(row.actions_json),
      events: parseJsonArray<unknown>(row.event_types_json)
        .filter((type): type is string => typeof type === "string")
        .map((type) => ({ type }) as ContextLogEntry["events"][number]),
      createdAt: String(row.created_at),
    };
  }

  recordModelContextTrace(trace: ModelContextTrace): void {
    this.database.connection.prepare(`
      INSERT INTO model_context_traces(
        id, session_id, mode, conversation_space, secret_owner_character_id,
        turn_kind, request_text, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.id,
      trace.sessionId,
      trace.mode,
      trace.conversationSpace,
      trace.secretOwnerCharacterId ?? null,
      trace.turnKind,
      trace.requestText,
      JSON.stringify(trace.payload),
      trace.createdAt,
    );
    this.trim();
  }

  recentModelContextTraces(
    limit: number,
    scope?: ModelContextTraceScope,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): ModelContextTrace[] {
    const rows = this.database.connection.prepare(
      `SELECT * FROM model_context_traces
       WHERE conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
       ORDER BY sequence DESC LIMIT ?`,
    ).all(conversationSpace, secretOwnerCharacterId ?? null, 20) as Row[];
    const bounded = Math.min(Math.max(limit, 1), scope ? 10 : 20);
    return rows
      .map((row) => {
        const turnKind = row.turn_kind as ModelContextTrace["turnKind"];
        return {
          id: String(row.id),
          sessionId: String(row.session_id),
          mode: row.mode as Mode,
          conversationSpace: row.conversation_space === "secret" ? "secret" as const : "normal" as const,
          ...(typeof row.secret_owner_character_id === "string" && row.secret_owner_character_id
            ? { secretOwnerCharacterId: row.secret_owner_character_id }
            : {}),
          turnKind,
          scope: modelContextTraceScope(turnKind),
          requestText: String(row.request_text),
          payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
          createdAt: String(row.created_at),
        };
      })
      .filter((trace) => !scope || trace.scope === scope)
      .slice(0, bounded);
  }

  allActions(): ActionRecord[] {
    return (this.database.connection.prepare(
      "SELECT * FROM audit_actions ORDER BY created_at, id",
    ).all() as Row[]).map((row) => decodeAction(row));
  }

  private trim(): void {
    this.database.connection.exec(`
      DELETE FROM audit_actions WHERE id NOT IN (
        SELECT id FROM audit_actions ORDER BY created_at DESC, id DESC LIMIT 1000
      );
      DELETE FROM context_log_summaries WHERE id NOT IN (
        SELECT id FROM context_log_summaries ORDER BY created_at DESC, id DESC LIMIT 200
      );
      DELETE FROM model_context_traces WHERE sequence IN (
        SELECT sequence FROM (
          SELECT
            sequence,
            ROW_NUMBER() OVER (
              PARTITION BY CASE
                WHEN turn_kind IN ('user', 'group_gate', 'group_reply', 'subagent', 'world_director')
                  THEN 'conversation'
                ELSE 'background'
              END
              ORDER BY sequence DESC
            ) AS scope_rank
          FROM model_context_traces
        )
        WHERE scope_rank > 10
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

const actionScopeEnvelopeKey = "__rp_agent_action_scope_v1";

function encodeActionPayload(action: ActionRecord): string {
  const boundedPayload = parseJson<Record<string, unknown>>(
    boundedJson(action.payload, 30_000),
    { truncated: true },
  );
  return JSON.stringify({
    [actionScopeEnvelopeKey]: {
      conversationSpace: action.conversationSpace,
      secretOwnerCharacterId: action.secretOwnerCharacterId ?? null,
    },
    payload: boundedPayload,
  });
}

function decodeAction(row: Row): ActionRecord {
  const stored = parseJson<Record<string, unknown>>(row.payload_json, {});
  const storedScope = recordValue(stored[actionScopeEnvelopeKey]);
  const encodedPayload = recordValue(stored.payload);
  const conversationSpace = storedScope?.conversationSpace === "secret" ? "secret" : "normal";
  const secretOwnerCharacterId = conversationSpace === "secret" &&
    typeof storedScope?.secretOwnerCharacterId === "string" &&
    storedScope.secretOwnerCharacterId
    ? storedScope.secretOwnerCharacterId
    : undefined;
  return {
    id: String(row.id),
    actionType: String(row.action_type),
    status: row.status as ActionRecord["status"],
    conversationSpace,
    ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
    payload: storedScope && encodedPayload ? encodedPayload : stored,
    createdAt: String(row.created_at),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedStringArrayJson(values: string[], limit: number): string {
  const bounded: string[] = [];
  for (const value of new Set(values)) {
    const candidate = JSON.stringify([...bounded, value]);
    if (candidate.length > limit) break;
    bounded.push(value);
  }
  return JSON.stringify(bounded);
}

function boundedActionsJson(actions: ActionRecord[], limit: number): string {
  const json = JSON.stringify(actions);
  if (json.length <= limit) return json;
  return JSON.stringify(actions.map((action) => ({
    ...action,
    payload: { truncated: true },
  })));
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

function parseJsonArray<T>(value: unknown): T[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed as T[] : [];
}
