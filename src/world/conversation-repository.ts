import type { AppDatabase } from "../storage/database.js";
import type {
  WorldCharacterObservation,
  WorldCharacterRelationship,
  WorldConversation,
  WorldConversationAttachment,
  WorldConversationMessage,
  WorldConversationTurn,
  WorldStoryEvent,
  WorldStoryTransition,
} from "./types.js";

type Row = Record<string, unknown>;

export class WorldConversationRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  ensureConversation(worldId: string, now: string): WorldConversation {
    this.database.connection.prepare(`
      INSERT INTO world_conversations(world_id, unread_count, created_at, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(world_id) DO NOTHING
    `).run(worldId, now, now);
    return this.getConversation(worldId)!;
  }

  getConversation(worldId: string): WorldConversation | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_conversations WHERE world_id = ?
    `).get(worldId) as Row | undefined;
    return row ? mapConversation(row) : undefined;
  }

  listConversations(): WorldConversation[] {
    return (this.database.connection.prepare(`
      SELECT c.* FROM world_conversations c
      JOIN role_worlds w ON w.id = c.world_id
      WHERE w.status = 'active'
      ORDER BY c.updated_at DESC, c.world_id
    `).all() as Row[]).map(mapConversation);
  }

  touch(worldId: string, now: string): WorldConversation {
    this.database.connection.prepare(`
      UPDATE world_conversations SET updated_at = ? WHERE world_id = ?
    `).run(now, worldId);
    return this.getConversation(worldId)!;
  }

  recordUnread(worldId: string, now: string): WorldConversation {
    this.database.connection.prepare(`
      UPDATE world_conversations
      SET unread_count = MIN(9999, unread_count + 1), last_unread_at = ?, updated_at = ?
      WHERE world_id = ?
    `).run(now, now, worldId);
    return this.getConversation(worldId)!;
  }

  markRead(worldId: string, now: string): WorldConversation {
    this.database.connection.prepare(`
      UPDATE world_conversations
      SET unread_count = 0, last_read_at = ?, updated_at = MAX(updated_at, ?)
      WHERE world_id = ?
    `).run(now, now, worldId);
    return this.getConversation(worldId)!;
  }

  createTurn(turn: WorldConversationTurn): WorldConversationTurn {
    this.database.connection.prepare(`
      INSERT INTO world_conversation_turns(
        id, world_id, status, model_calls, actor_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.worldId,
      turn.status,
      turn.modelCalls,
      turn.actorCount,
      turn.startedAt,
      turn.completedAt ?? null,
    );
    return turn;
  }

  getTurn(id: string): WorldConversationTurn | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_conversation_turns WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapTurn(row) : undefined;
  }

  finishTurn(
    id: string,
    status: WorldConversationTurn["status"],
    modelCalls: number,
    actorCount: number,
    completedAt: string,
  ): WorldConversationTurn {
    this.database.connection.prepare(`
      UPDATE world_conversation_turns
      SET status = ?, model_calls = ?, actor_count = ?, completed_at = ?
      WHERE id = ?
    `).run(status, modelCalls, actorCount, completedAt, id);
    return this.getTurn(id)!;
  }

  appendMessage(input: Omit<WorldConversationMessage, "sequence">): WorldConversationMessage {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM world_conversation_messages WHERE world_id = ?
    `).get(input.worldId) as Row;
    const sequence = Number(row.sequence);
    this.database.connection.prepare(`
      INSERT INTO world_conversation_messages(
        id, world_id, turn_id, sequence, sender_type, sender_id,
        content, attachments_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.worldId,
      input.turnId,
      sequence,
      input.senderType,
      input.senderId ?? null,
      input.content,
      JSON.stringify(input.attachments),
      input.createdAt,
    );
    return { ...input, sequence };
  }

  listMessages(worldId: string, limit = 200): WorldConversationMessage[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.database.connection.prepare(`
      SELECT * FROM (
        SELECT * FROM world_conversation_messages
        WHERE world_id = ? ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence
    `).all(worldId, bounded) as Row[];
    return rows.map(mapMessage);
  }

  messageCount(worldId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM world_conversation_messages WHERE world_id = ?
    `).get(worldId) as Row;
    return Number(row.count);
  }

  getStoryEvent(id: string): WorldStoryEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_story_events WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? this.mapStoryEvent(row) : undefined;
  }

  getOpenStoryEvent(worldId: string): WorldStoryEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_story_events
      WHERE world_id = ? AND status IN ('planned', 'active')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
    `).get(worldId) as Row | undefined;
    return row ? this.mapStoryEvent(row) : undefined;
  }

  listStoryEvents(worldId: string, limit = 30): WorldStoryEvent[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    return (this.database.connection.prepare(`
      SELECT * FROM world_story_events
      WHERE world_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(worldId, bounded) as Row[]).map((row) => this.mapStoryEvent(row));
  }

  saveStoryEvent(event: WorldStoryEvent): WorldStoryEvent {
    this.database.connection.prepare(`
      INSERT INTO world_story_events(
        id, world_id, place_id, title, summary, objective, status, revision,
        created_at, updated_at, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        place_id = excluded.place_id,
        title = excluded.title,
        summary = excluded.summary,
        objective = excluded.objective,
        status = excluded.status,
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at
    `).run(
      event.id,
      event.worldId,
      event.placeId ?? null,
      event.title,
      event.summary,
      event.objective,
      event.status,
      event.revision,
      event.createdAt,
      event.updatedAt,
      event.startedAt ?? null,
      event.endedAt ?? null,
    );
    this.database.connection.prepare(`
      DELETE FROM world_story_event_participants WHERE event_id = ?
    `).run(event.id);
    const insert = this.database.connection.prepare(`
      INSERT INTO world_story_event_participants(event_id, character_id, role)
      VALUES (?, ?, 'participant')
    `);
    for (const characterId of [...new Set(event.participantIds)]) insert.run(event.id, characterId);
    return this.getStoryEvent(event.id)!;
  }

  deleteStoryEvent(id: string): boolean {
    return Number(this.database.connection.prepare(`
      DELETE FROM world_story_events WHERE id = ?
    `).run(id).changes) > 0;
  }

  recordStoryTransition(transition: WorldStoryTransition): WorldStoryTransition {
    this.database.connection.prepare(`
      INSERT INTO world_story_event_transitions(
        id, world_id, event_id, turn_id, event_type, source, status, summary,
        before_state_json, after_state_json, created_at, reverted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transition.id,
      transition.worldId,
      transition.eventId ?? null,
      transition.turnId ?? null,
      transition.eventType,
      transition.source,
      transition.status,
      transition.summary,
      JSON.stringify(transition.beforeState ?? null),
      JSON.stringify(transition.afterState ?? null),
      transition.createdAt,
      transition.revertedAt ?? null,
    );
    return transition;
  }

  latestAppliedStoryTransition(worldId: string): WorldStoryTransition | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_story_event_transitions
      WHERE world_id = ? AND status = 'applied' AND event_type <> 'undo'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(worldId) as Row | undefined;
    return row ? mapStoryTransition(row) : undefined;
  }

  revertStoryTransition(id: string, revertedAt: string): void {
    this.database.connection.prepare(`
      UPDATE world_story_event_transitions
      SET status = 'reverted', reverted_at = ? WHERE id = ?
    `).run(revertedAt, id);
  }

  createObservation(observation: WorldCharacterObservation): WorldCharacterObservation {
    this.database.connection.prepare(`
      INSERT INTO world_character_observations(
        id, world_id, event_id, turn_id, character_id, knowledge, summary, salience, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.id,
      observation.worldId,
      observation.eventId ?? null,
      observation.turnId ?? null,
      observation.characterId,
      observation.knowledge,
      observation.summary,
      observation.salience,
      observation.createdAt,
    );
    return observation;
  }

  listObservations(characterId: string, worldId: string, limit = 12): WorldCharacterObservation[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    return (this.database.connection.prepare(`
      SELECT * FROM world_character_observations
      WHERE character_id = ? AND world_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(characterId, worldId, bounded) as Row[]).map(mapObservation);
  }

  getCharacterRelationship(
    worldId: string,
    subjectCharacterId: string,
    objectCharacterId: string,
  ): WorldCharacterRelationship | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_character_relationships
      WHERE world_id = ? AND subject_character_id = ? AND object_character_id = ?
    `).get(worldId, subjectCharacterId, objectCharacterId) as Row | undefined;
    return row ? mapCharacterRelationship(row) : undefined;
  }

  upsertCharacterRelationship(relationship: WorldCharacterRelationship): WorldCharacterRelationship {
    this.database.connection.prepare(`
      INSERT INTO world_character_relationships(
        world_id, subject_character_id, object_character_id,
        affinity, trust, tension, intimacy, summary, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id, subject_character_id, object_character_id) DO UPDATE SET
        affinity = excluded.affinity,
        trust = excluded.trust,
        tension = excluded.tension,
        intimacy = excluded.intimacy,
        summary = excluded.summary,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(
      relationship.worldId,
      relationship.subjectCharacterId,
      relationship.objectCharacterId,
      relationship.affinity,
      relationship.trust,
      relationship.tension,
      relationship.intimacy,
      relationship.summary,
      relationship.revision,
      relationship.updatedAt,
    );
    return this.getCharacterRelationship(
      relationship.worldId,
      relationship.subjectCharacterId,
      relationship.objectCharacterId,
    )!;
  }

  listCharacterRelationships(worldId: string, characterId?: string): WorldCharacterRelationship[] {
    const rows = characterId
      ? this.database.connection.prepare(`
          SELECT * FROM world_character_relationships
          WHERE world_id = ? AND (subject_character_id = ? OR object_character_id = ?)
          ORDER BY updated_at DESC
        `).all(worldId, characterId, characterId) as Row[]
      : this.database.connection.prepare(`
          SELECT * FROM world_character_relationships
          WHERE world_id = ? ORDER BY updated_at DESC
        `).all(worldId) as Row[];
    return rows.map(mapCharacterRelationship);
  }

  private mapStoryEvent(row: Row): WorldStoryEvent {
    const participants = this.database.connection.prepare(`
      SELECT character_id FROM world_story_event_participants
      WHERE event_id = ? ORDER BY character_id
    `).all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      worldId: String(row.world_id),
      ...(optionalString(row.place_id) ? { placeId: optionalString(row.place_id) } : {}),
      title: String(row.title),
      summary: String(row.summary),
      objective: String(row.objective),
      status: String(row.status) as WorldStoryEvent["status"],
      revision: Number(row.revision),
      participantIds: participants.map((entry) => String(entry.character_id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(optionalString(row.started_at) ? { startedAt: optionalString(row.started_at) } : {}),
      ...(optionalString(row.ended_at) ? { endedAt: optionalString(row.ended_at) } : {}),
    };
  }
}

function mapConversation(row: Row): WorldConversation {
  return {
    worldId: String(row.world_id),
    unreadCount: Number(row.unread_count),
    ...(optionalString(row.last_unread_at) ? { lastUnreadAt: optionalString(row.last_unread_at) } : {}),
    ...(optionalString(row.last_read_at) ? { lastReadAt: optionalString(row.last_read_at) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTurn(row: Row): WorldConversationTurn {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    status: String(row.status) as WorldConversationTurn["status"],
    modelCalls: Number(row.model_calls),
    actorCount: Number(row.actor_count),
    startedAt: String(row.started_at),
    ...(optionalString(row.completed_at) ? { completedAt: optionalString(row.completed_at) } : {}),
  };
}

function mapMessage(row: Row): WorldConversationMessage {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    turnId: String(row.turn_id),
    sequence: Number(row.sequence),
    senderType: String(row.sender_type) as WorldConversationMessage["senderType"],
    ...(optionalString(row.sender_id) ? { senderId: optionalString(row.sender_id) } : {}),
    content: String(row.content),
    attachments: parseAttachments(row.attachments_json),
    createdAt: String(row.created_at),
  };
}

function mapStoryTransition(row: Row): WorldStoryTransition {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    ...(optionalString(row.event_id) ? { eventId: optionalString(row.event_id) } : {}),
    ...(optionalString(row.turn_id) ? { turnId: optionalString(row.turn_id) } : {}),
    eventType: String(row.event_type) as WorldStoryTransition["eventType"],
    source: String(row.source) as WorldStoryTransition["source"],
    status: String(row.status) as WorldStoryTransition["status"],
    summary: String(row.summary),
    ...(parseStoryEvent(row.before_state_json) ? { beforeState: parseStoryEvent(row.before_state_json) } : {}),
    ...(parseStoryEvent(row.after_state_json) ? { afterState: parseStoryEvent(row.after_state_json) } : {}),
    createdAt: String(row.created_at),
    ...(optionalString(row.reverted_at) ? { revertedAt: optionalString(row.reverted_at) } : {}),
  };
}

function mapObservation(row: Row): WorldCharacterObservation {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    ...(optionalString(row.event_id) ? { eventId: optionalString(row.event_id) } : {}),
    ...(optionalString(row.turn_id) ? { turnId: optionalString(row.turn_id) } : {}),
    characterId: String(row.character_id),
    knowledge: String(row.knowledge) as WorldCharacterObservation["knowledge"],
    summary: String(row.summary),
    salience: Number(row.salience),
    createdAt: String(row.created_at),
  };
}

function mapCharacterRelationship(row: Row): WorldCharacterRelationship {
  return {
    worldId: String(row.world_id),
    subjectCharacterId: String(row.subject_character_id),
    objectCharacterId: String(row.object_character_id),
    affinity: Number(row.affinity),
    trust: Number(row.trust),
    tension: Number(row.tension),
    intimacy: Number(row.intimacy),
    summary: String(row.summary),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
  };
}

function parseStoryEvent(value: unknown): WorldStoryEvent | undefined {
  try {
    const parsed = JSON.parse(String(value ?? "null")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as WorldStoryEvent
      : undefined;
  } catch {
    return undefined;
  }
}

function parseAttachments(value: unknown): WorldConversationAttachment[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      const path = typeof item.path === "string" ? item.path : "";
      if (!path) return [];
      return [{
        path,
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.contentType === "string" ? { contentType: item.contentType } : {}),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
