import type { AppDatabase } from "../storage/database.js";
import type {
  GroupChat,
  GroupChatDecision,
  GroupChatMessage,
  GroupChatTurn,
  GroupDecisionOutcome,
  GroupTurnStatus,
} from "./types.js";

type Row = Record<string, unknown>;

export class GroupChatRepository {
  constructor(private readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  create(chat: GroupChat): GroupChat {
    this.database.connection.prepare(`
      INSERT INTO group_chats(id, title, mode, status, max_speakers, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(chat.id, chat.title, chat.mode, chat.status, chat.maxSpeakers, chat.createdAt, chat.updatedAt);
    const insertMember = this.database.connection.prepare(`
      INSERT INTO group_chat_members(group_id, character_id, position, joined_at) VALUES (?, ?, ?, ?)
    `);
    chat.characterIds.forEach((characterId, position) => {
      insertMember.run(chat.id, characterId, position, chat.createdAt);
    });
    return chat;
  }

  get(id: string): GroupChat | undefined {
    const row = this.database.connection.prepare("SELECT * FROM group_chats WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapChat(row) : undefined;
  }

  list(includeArchived = false): GroupChat[] {
    const rows = this.database.connection.prepare(`
      SELECT * FROM group_chats
      WHERE status = 'active' OR ? = 1
      ORDER BY updated_at DESC, id
    `).all(includeArchived ? 1 : 0) as Row[];
    return rows.map((row) => this.mapChat(row));
  }

  setStatus(id: string, status: GroupChat["status"], updatedAt: string): GroupChat | undefined {
    const result = this.database.connection.prepare(`
      UPDATE group_chats SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, updatedAt, id);
    return Number(result.changes) > 0 ? this.get(id) : undefined;
  }

  delete(id: string): boolean {
    return Number(this.database.connection.prepare("DELETE FROM group_chats WHERE id = ?").run(id).changes) > 0;
  }

  touch(id: string, updatedAt: string): void {
    this.database.connection.prepare("UPDATE group_chats SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  createTurn(turn: GroupChatTurn): GroupChatTurn {
    this.database.connection.prepare(`
      INSERT INTO group_chat_turns(id, group_id, status, model_calls, speaker_count, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.groupId,
      turn.status,
      turn.modelCalls,
      turn.speakerCount,
      turn.startedAt,
      turn.completedAt ?? null,
    );
    return turn;
  }

  finishTurn(
    id: string,
    status: GroupTurnStatus,
    modelCalls: number,
    speakerCount: number,
    messageCount: number,
    completedAt: string,
  ): GroupChatTurn {
    this.database.connection.prepare(`
      UPDATE group_chat_turns
      SET status = ?, model_calls = ?, speaker_count = ?, message_count = ?, completed_at = ?
      WHERE id = ?
    `).run(status, modelCalls, speakerCount, messageCount, completedAt, id);
    const row = this.database.connection.prepare("SELECT * FROM group_chat_turns WHERE id = ?").get(id) as Row;
    return mapTurn(row);
  }

  appendMessage(input: Omit<GroupChatMessage, "sequence">): GroupChatMessage {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM group_chat_messages WHERE group_id = ?
    `).get(input.groupId) as Row;
    const message: GroupChatMessage = { ...input, sequence: Number(row.next_sequence) };
    this.database.connection.prepare(`
      INSERT INTO group_chat_messages(id, group_id, turn_id, sequence, sender_type, sender_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.groupId,
      message.turnId,
      message.sequence,
      message.senderType,
      message.senderId ?? null,
      message.content,
      message.createdAt,
    );
    return message;
  }

  listMessages(groupId: string, limit = 200): GroupChatMessage[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.database.connection.prepare(`
      SELECT * FROM (
        SELECT * FROM group_chat_messages WHERE group_id = ? ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence
    `).all(groupId, bounded) as Row[];
    return rows.map(mapMessage);
  }

  lastCharacterSender(groupId: string): string | undefined {
    const row = this.database.connection.prepare(`
      SELECT sender_id FROM group_chat_messages
      WHERE group_id = ? AND sender_type = 'character'
      ORDER BY sequence DESC LIMIT 1
    `).get(groupId) as Row | undefined;
    return row && typeof row.sender_id === "string" ? row.sender_id : undefined;
  }

  recordDecision(decision: GroupChatDecision): GroupChatDecision {
    this.database.connection.prepare(`
      INSERT INTO group_chat_decisions(
        id, turn_id, character_id, outcome, reason_code, model_profile_id, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.turnId,
      decision.characterId,
      decision.outcome,
      decision.reasonCode,
      decision.modelProfileId ?? null,
      decision.model ?? null,
      decision.createdAt,
    );
    return decision;
  }

  listDecisions(turnId: string): GroupChatDecision[] {
    return (this.database.connection.prepare(`
      SELECT * FROM group_chat_decisions WHERE turn_id = ? ORDER BY rowid
    `).all(turnId) as Row[]).map(mapDecision);
  }

  private mapChat(row: Row): GroupChat {
    const members = this.database.connection.prepare(`
      SELECT character_id FROM group_chat_members WHERE group_id = ? ORDER BY position
    `).all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      title: String(row.title),
      mode: row.mode === "rp" ? "rp" : "sms",
      status: row.status === "archived" ? "archived" : "active",
      maxSpeakers: Number(row.max_speakers),
      characterIds: members.map((entry) => String(entry.character_id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

function mapMessage(row: Row): GroupChatMessage {
  const senderType = row.sender_type === "character" || row.sender_type === "system" ? row.sender_type : "user";
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    turnId: String(row.turn_id),
    sequence: Number(row.sequence),
    senderType,
    senderId: typeof row.sender_id === "string" ? row.sender_id : undefined,
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function mapDecision(row: Row): GroupChatDecision {
  const outcome: GroupDecisionOutcome = row.outcome === "speak" || row.outcome === "failed" ? row.outcome : "silent";
  return {
    id: String(row.id),
    turnId: String(row.turn_id),
    characterId: String(row.character_id),
    outcome,
    reasonCode: String(row.reason_code),
    modelProfileId: typeof row.model_profile_id === "string" ? row.model_profile_id : undefined,
    model: typeof row.model === "string" ? row.model : undefined,
    createdAt: String(row.created_at),
  };
}

function mapTurn(row: Row): GroupChatTurn {
  const status = ["completed", "partial", "failed", "cancelled"].includes(String(row.status))
    ? String(row.status) as Exclude<GroupTurnStatus, "running">
    : "running";
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    status,
    modelCalls: Number(row.model_calls),
    speakerCount: Number(row.speaker_count),
    messageCount: Number(row.message_count ?? 0),
    startedAt: String(row.started_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  };
}
