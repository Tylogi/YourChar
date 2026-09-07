import type { DatabaseSync } from "node:sqlite";

export class HistoryQueryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export type HistoryQuery = { limit?: number; before?: string; after?: string; around?: string };
export type HistoryPage<T> = { messages: T[]; page: { first: string | null; last: string | null; hasEarlier: boolean; hasLater: boolean } };
export type HistoryHit = { id: string; role: string; snippet: string; timestamp: string | number; senderId?: string };
export type HistorySearch = { results: HistoryHit[]; next: string | null };

export function historyText(value: unknown): string {
  const message = value as { content?: unknown; errorMessage?: unknown };
  if (typeof message.errorMessage === "string") return message.errorMessage;
  return typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "text").map(block => String(block.text ?? "")).join("") : "";
}

export function historyMessagePayload(value: unknown): Record<string, unknown> {
  const message = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["role", "timestamp", "customType", "display", "errorMessage", "api", "provider", "model", "toolCallId", "toolName", "isError", "turnStatus", "canRetry"]) {
    if (message[key] !== undefined) output[key] = message[key];
  }
  output.content = historyText(message);
  if (Array.isArray(message.attachments)) output.attachments = message.attachments.slice(0, 8).map(attachment => ({
    kind: attachment.kind, path: attachment.path, name: attachment.name, contentType: attachment.contentType, size: attachment.size, previewKind: attachment.previewKind,
  }));
  if (message.details && typeof message.details === "object") {
    const details = message.details as Record<string, unknown>;
    output.details = { status: details.status, eventType: details.eventType, canRetry: details.canRetry };
  }
  return output;
}

export function historyQuery(input: HistoryQuery): Required<Pick<HistoryQuery, "limit">> & HistoryQuery {
  const limit = input.limit ?? 40;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HistoryQueryError("每次加载数量需为 1–100");
  if ([input.before, input.after, input.around].filter(value => value !== undefined).length > 1) throw new HistoryQueryError("只能指定一种历史定位方式");
  for (const value of [input.before, input.after, input.around]) {
    if (value !== undefined && (!value || value.length > 256)) throw new HistoryQueryError("无效的消息位置");
  }
  return { ...input, limit };
}

export function searchQuery(query: string): string {
  const value = query.trim();
  if (!value || [...value].length > 200) throw new HistoryQueryError("请输入 1–200 字的搜索内容");
  return value;
}

export function snippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const at = normalized.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - 45);
  return (start ? "…" : "") + normalized.slice(start, start + 180) + (normalized.length > start + 180 ? "…" : "");
}

export function pageEntries<T>(entries: readonly T[], identify: (entry: T) => string, input: HistoryQuery): HistoryPage<T> {
  const query = historyQuery(input);
  const anchor = query.before ?? query.after ?? query.around;
  const index = anchor === undefined ? -1 : entries.findIndex(entry => identify(entry) === anchor);
  if (anchor !== undefined && index < 0) throw new HistoryQueryError("这条消息已不存在，请返回最近记录", 404);
  let end = query.before ? index : entries.length;
  let start = query.after ? index + 1 : Math.max(0, end - query.limit);
  if (query.after) end = Math.min(entries.length, start + query.limit);
  if (query.around) {
    start = Math.max(0, Math.min(index - Math.floor(query.limit / 2), entries.length - query.limit));
    end = Math.min(entries.length, start + query.limit);
  }
  const messages = entries.slice(start, end);
  return { messages, page: { first: messages.length ? identify(messages[0]) : null,
    last: messages.length ? identify(messages[messages.length - 1]) : null, hasEarlier: start > 0, hasLater: end < entries.length } };
}

/** Existing scoped sequence indexes provide keyset pagination, never OFFSET or full transcripts. */
export function sqlHistory(db: DatabaseSync, kind: "world" | "group", scope: string, input: HistoryQuery, text?: string): HistoryPage<Record<string, unknown>> | HistorySearch {
  const query = historyQuery(input);
  const table = kind === "world" ? "world_conversation_messages" : "group_chat_messages";
  const column = kind === "world" ? "world_id" : "group_id";
  const anchor = query.before ?? query.after ?? query.around;
  const target = anchor === undefined ? undefined : db.prepare(`SELECT sequence FROM ${table} WHERE ${column}=? AND id=?`).get(scope, anchor);
  if (anchor !== undefined && !target) throw new HistoryQueryError("这条消息已不存在，请返回最近记录", 404);
  const sequence = Number(target?.sequence);
  if (text !== undefined) {
    const q = searchQuery(text);
    const rows = db.prepare(`SELECT id,sender_type,sender_id,content,created_at FROM ${table} WHERE ${column}=? ${query.before ? "AND sequence < ?" : ""}
      AND instr(lower(content),lower(?)) > 0 ORDER BY sequence DESC LIMIT ?`).all(...(query.before ? [scope, sequence, q, query.limit + 1] : [scope, q, query.limit + 1]));
    const results = rows.slice(0, query.limit).map(row => ({ id: String(row.id), role: String(row.sender_type),
      senderId: row.sender_id ? String(row.sender_id) : undefined, snippet: snippet(String(row.content), q), timestamp: String(row.created_at) }));
    return { results, next: rows.length > query.limit ? results.at(-1)!.id : null };
  }
  let rows: Record<string, unknown>[];
  if (query.around) {
    const earlier = db.prepare(`SELECT * FROM ${table} WHERE ${column}=? AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(scope, sequence, Math.floor(query.limit / 2)).reverse();
    const later = db.prepare(`SELECT * FROM ${table} WHERE ${column}=? AND sequence >= ? ORDER BY sequence LIMIT ?`).all(scope, sequence, query.limit - earlier.length);
    rows = [...earlier, ...later];
  } else {
    rows = db.prepare(`SELECT * FROM ${table} WHERE ${column}=? ${query.before ? "AND sequence < ?" : query.after ? "AND sequence > ?" : ""}
      ORDER BY sequence ${query.after ? "ASC" : "DESC"} LIMIT ?`).all(...(anchor === undefined ? [scope, query.limit] : [scope, sequence, query.limit]));
    if (!query.after) rows.reverse();
  }
  const first = rows[0]; const last = rows.at(-1);
  return { messages: rows.map(row => ({ id: row.id, turnId: row.turn_id, sequence: row.sequence,
    ...(kind === "world" ? { worldId: row.world_id, attachments: JSON.parse(String(row.attachments_json ?? "[]")) } : { groupId: row.group_id }),
    senderType: row.sender_type, senderId: row.sender_id, content: row.content, createdAt: row.created_at })), page: { first: first ? String(first.id) : null, last: last ? String(last.id) : null,
    hasEarlier: Boolean(first && db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? AND sequence < ? LIMIT 1`).get(scope, Number(first.sequence))),
    hasLater: Boolean(last && db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? AND sequence > ? LIMIT 1`).get(scope, Number(last.sequence))) } };
}
