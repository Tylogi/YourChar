import type { AppDatabase } from "../storage/database.js";
import type { MessageAttachment, Mode } from "../domain/types.js";
import type { PrivateInboxMessage, PrivateInboxMessageStatus, PrivateMessageBurst } from "./types.js";

type Row = Record<string, unknown>;

export class PrivateInboxRepository {
  constructor(readonly database: AppDatabase) {}

  create(input: {
    id: string;
    clientMessageId: string;
    sessionId: string;
    characterId: string;
    mode: Mode;
    text: string;
    timezone: string;
    attachments: MessageAttachment[];
    now: string;
  }): PrivateInboxMessage {
    const existing = this.getByClientMessageId(input.sessionId, input.clientMessageId);
    if (existing) return existing;
    this.database.connection.prepare(`
      INSERT INTO private_message_inbox(
        id, client_message_id, session_id, character_id, mode, text, timezone,
        attachments_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      input.id,
      input.clientMessageId,
      input.sessionId,
      input.characterId,
      input.mode,
      input.text,
      input.timezone,
      JSON.stringify(input.attachments),
      input.now,
      input.now,
    );
    return this.get(input.id)!;
  }

  get(id: string): PrivateInboxMessage | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM private_message_inbox WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  getByClientMessageId(sessionId: string, clientMessageId: string): PrivateInboxMessage | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM private_message_inbox WHERE session_id = ? AND client_message_id = ?
    `).get(sessionId, clientMessageId) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  listQueued(sessionId: string): PrivateInboxMessage[] {
    return (this.database.connection.prepare(`
      SELECT * FROM private_message_inbox
      WHERE session_id = ? AND status = 'queued'
      ORDER BY created_at, id
    `).all(sessionId) as Row[]).map(mapMessage);
  }

  listActive(sessionId: string): PrivateInboxMessage[] {
    return (this.database.connection.prepare(`
      SELECT * FROM private_message_inbox
      WHERE session_id = ? AND status IN ('queued', 'processing')
      ORDER BY created_at, id
    `).all(sessionId) as Row[]).map(mapMessage);
  }

  listAll(limit = 1_000): PrivateInboxMessage[] {
    return (this.database.connection.prepare(`
      SELECT * FROM private_message_inbox ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(10_000, Math.floor(limit)))) as Row[]).map(mapMessage);
  }

  queuedSessionIds(): string[] {
    return (this.database.connection.prepare(`
      SELECT DISTINCT session_id FROM private_message_inbox WHERE status = 'queued' ORDER BY session_id
    `).all() as Row[]).map((row) => String(row.session_id));
  }

  reassignActiveSession(fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0;
    return Number(this.database.connection.prepare(`
      UPDATE private_message_inbox
      SET session_id = ?
      WHERE session_id = ? AND status IN ('queued', 'processing')
    `).run(toSessionId, fromSessionId).changes);
  }

  updateQueued(
    sessionId: string,
    id: string,
    patch: { text: string; attachments: MessageAttachment[] },
    now: string,
  ): PrivateInboxMessage | undefined {
    const result = this.database.connection.prepare(`
      UPDATE private_message_inbox
      SET text = ?, attachments_json = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND status = 'queued'
    `).run(patch.text, JSON.stringify(patch.attachments), now, id, sessionId);
    return Number(result.changes) ? this.get(id) : undefined;
  }

  retractQueued(sessionId: string, id: string): PrivateInboxMessage | undefined {
    const message = this.get(id);
    if (!message || message.sessionId !== sessionId || message.status !== "queued") return undefined;
    this.database.connection.prepare(
      "DELETE FROM private_message_inbox WHERE id = ? AND session_id = ? AND status = 'queued'",
    ).run(id, sessionId);
    return message;
  }

  claimBurst(input: {
    sessionId: string;
    burstId: string;
    now: string;
    maximumMessages: number;
    maximumCharacters: number;
  }): PrivateMessageBurst | undefined {
    return this.database.transaction(() => {
      const queued = this.listQueued(input.sessionId);
      const selected: PrivateInboxMessage[] = [];
      let characters = 0;
      for (const message of queued) {
        const nextCharacters = [...message.text].length;
        if (selected.length >= input.maximumMessages) break;
        if (selected.length && characters + nextCharacters > input.maximumCharacters) break;
        selected.push(message);
        characters += nextCharacters;
      }
      if (!selected.length) return undefined;
      const placeholders = selected.map(() => "?").join(", ");
      this.database.connection.prepare(`
        UPDATE private_message_inbox
        SET status = 'processing', burst_id = ?, updated_at = ?, last_error = NULL
        WHERE status = 'queued' AND id IN (${placeholders})
      `).run(input.burstId, input.now, ...selected.map((message) => message.id));
      const messages = selected.map((message) => ({
        ...message,
        status: "processing" as const,
        burstId: input.burstId,
        updatedAt: input.now,
      }));
      const first = messages[0];
      return {
        id: input.burstId,
        sessionId: first.sessionId,
        characterId: first.characterId,
        mode: first.mode,
        messages,
      };
    });
  }

  finishBurst(burstId: string, status: Exclude<PrivateInboxMessageStatus, "queued" | "processing">, now: string, error?: string): void {
    this.database.connection.prepare(`
      UPDATE private_message_inbox
      SET status = ?, updated_at = ?, completed_at = ?, last_error = ?
      WHERE burst_id = ? AND status = 'processing'
    `).run(status, now, now, error ?? null, burstId);
  }

  recoverInterrupted(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE private_message_inbox
      SET status = 'failed', updated_at = ?, completed_at = ?,
          last_error = 'service restarted while this message burst was processing'
      WHERE status = 'processing'
    `).run(now, now).changes);
  }
}

function mapMessage(row: Row): PrivateInboxMessage {
  return {
    id: String(row.id),
    clientMessageId: String(row.client_message_id),
    sessionId: String(row.session_id),
    characterId: String(row.character_id),
    mode: row.mode === "rp" ? "rp" : "sms",
    text: String(row.text),
    timezone: String(row.timezone),
    attachments: parseAttachments(row.attachments_json),
    status: privateInboxStatus(row.status),
    ...(row.burst_id ? { burstId: String(row.burst_id) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function parseAttachments(value: unknown): MessageAttachment[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string") return [];
      return [{
        path: record.path,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.contentType === "string" ? { contentType: record.contentType } : {}),
        ...(typeof record.size === "number" ? { size: record.size } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function privateInboxStatus(value: unknown): PrivateInboxMessageStatus {
  return ["queued", "processing", "completed", "failed", "cancelled"].includes(String(value))
    ? String(value) as PrivateInboxMessageStatus
    : "failed";
}
