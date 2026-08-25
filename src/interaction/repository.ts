import type { AppDatabase } from "../storage/database.js";
import type {
  InteractionEvent,
  InteractionEventStatus,
  InteractionScope,
  InteractionState,
  InteractionStateSnapshot,
} from "./types.js";

type Row = Record<string, unknown>;

export class InteractionRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  getState(sessionId: string, scope: InteractionScope): InteractionState | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(
      `SELECT * FROM conversation_interaction_states
       WHERE session_id = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
    ).get(sessionId, conversationSpace, secretOwnerCharacterId) as Row | undefined;
    return row ? mapState(row) : undefined;
  }

  upsertState(state: InteractionState): InteractionState {
    assertStoredScope(state);
    const result = this.database.connection.prepare(`
      INSERT INTO conversation_interaction_states(
        session_id, character_id, conversation_space, secret_owner_character_id,
        continuity, presence, narrative_lens,
        place_id, location_text, meeting_note, pending_event_id,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        continuity = excluded.continuity,
        presence = excluded.presence,
        narrative_lens = excluded.narrative_lens,
        place_id = excluded.place_id,
        location_text = excluded.location_text,
        meeting_note = excluded.meeting_note,
        pending_event_id = excluded.pending_event_id,
        revision = excluded.revision,
        updated_at = excluded.updated_at
      WHERE conversation_interaction_states.character_id = excluded.character_id
        AND conversation_interaction_states.conversation_space = excluded.conversation_space
        AND COALESCE(conversation_interaction_states.secret_owner_character_id, '') =
          COALESCE(excluded.secret_owner_character_id, '')
    `).run(
      state.sessionId,
      state.characterId,
      state.conversationSpace,
      state.secretOwnerCharacterId ?? null,
      state.continuity,
      state.presence,
      state.lens,
      state.placeId ?? null,
      state.location ?? null,
      state.meetingNote ?? null,
      state.pendingEventId ?? null,
      state.revision,
      state.createdAt,
      state.updatedAt,
    );
    if (Number(result.changes) !== 1) {
      throw new Error("interaction state session belongs to another scope or character");
    }
    return state;
  }

  findCanonicalCoPresentSession(
    characterId: string,
    scope: InteractionScope,
    exceptSessionId?: string,
  ): InteractionState | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(`
      SELECT * FROM conversation_interaction_states
      WHERE character_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
        AND continuity = 'canonical' AND presence = 'co_present'
        AND session_id <> COALESCE(?, '')
      ORDER BY updated_at DESC LIMIT 1
    `).get(
      characterId,
      conversationSpace,
      secretOwnerCharacterId,
      exceptSessionId ?? null,
    ) as Row | undefined;
    return row ? mapState(row) : undefined;
  }

  createEvent(event: InteractionEvent): InteractionEvent {
    assertStoredScope(event);
    this.database.connection.prepare(`
      INSERT INTO interaction_transition_events(
        id, session_id, character_id, conversation_space, secret_owner_character_id,
        event_type, source, status, evidence_kind,
        from_presence, to_presence, place_id, location_text, summary,
        before_state_json, after_state_json, idempotency_key,
        created_at, applied_at, reverted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.sessionId,
      event.characterId,
      event.conversationSpace,
      event.secretOwnerCharacterId ?? null,
      event.type,
      event.source,
      event.status,
      event.evidenceKind,
      event.fromPresence,
      event.toPresence,
      event.placeId ?? null,
      event.location ?? null,
      event.summary,
      JSON.stringify(event.beforeState),
      JSON.stringify(event.afterState),
      event.idempotencyKey ?? null,
      event.createdAt,
      event.appliedAt ?? null,
      event.revertedAt ?? null,
    );
    return event;
  }

  getEvent(id: string, scope: InteractionScope): InteractionEvent | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(
      `SELECT * FROM interaction_transition_events
       WHERE id = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
    ).get(id, conversationSpace, secretOwnerCharacterId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  findEventByIdempotencyKey(key: string, scope: InteractionScope): InteractionEvent | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(
      `SELECT * FROM interaction_transition_events
       WHERE idempotency_key = ? AND conversation_space = ?
         AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')`,
    ).get(key, conversationSpace, secretOwnerCharacterId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  updateEventStatus(
    id: string,
    scope: InteractionScope,
    status: InteractionEventStatus,
    patch: { appliedAt?: string; revertedAt?: string } = {},
  ): void {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    this.database.connection.prepare(`
      UPDATE interaction_transition_events
      SET status = ?,
          applied_at = COALESCE(?, applied_at),
          reverted_at = COALESCE(?, reverted_at)
      WHERE id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).run(
      status,
      patch.appliedAt ?? null,
      patch.revertedAt ?? null,
      id,
      conversationSpace,
      secretOwnerCharacterId,
    );
  }

  listEvents(sessionId: string, scope: InteractionScope, limit = 50): InteractionEvent[] {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    return (this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(
      sessionId,
      conversationSpace,
      secretOwnerCharacterId,
      Math.max(1, Math.min(200, Math.floor(limit))),
    ) as Row[])
      .map(mapEvent)
      .reverse();
  }

  listAllEvents(sessionId: string, scope: InteractionScope): InteractionEvent[] {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    return (this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY created_at ASC, rowid ASC
    `).all(sessionId, conversationSpace, secretOwnerCharacterId) as Row[]).map(mapEvent);
  }

  latestAppliedReversibleEvent(
    sessionId: string,
    scope: InteractionScope,
  ): InteractionEvent | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
        AND status = 'applied'
        AND event_type <> 'undo_transition'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(sessionId, conversationSpace, secretOwnerCharacterId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  latestAppliedBeginEvent(sessionId: string, scope: InteractionScope): InteractionEvent | undefined {
    const [conversationSpace, secretOwnerCharacterId] = scopeParameters(scope);
    const row = this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
        AND status = 'applied' AND event_type = 'begin_meeting'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(sessionId, conversationSpace, secretOwnerCharacterId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }
}

function mapState(row: Row): InteractionState {
  return {
    sessionId: String(row.session_id),
    characterId: String(row.character_id),
    ...storedScope(row),
    continuity: row.continuity === "sandbox" ? "sandbox" : "canonical",
    presence: row.presence === "meeting_pending"
      ? "meeting_pending"
      : row.presence === "co_present" ? "co_present" : "remote",
    lens: row.narrative_lens === "observable_scene"
      ? "observable_scene"
      : row.narrative_lens === "close_third" ? "close_third" : "message",
    ...(optionalString(row.place_id) ? { placeId: optionalString(row.place_id) } : {}),
    ...(optionalString(row.location_text) ? { location: optionalString(row.location_text) } : {}),
    ...(optionalString(row.meeting_note) ? { meetingNote: optionalString(row.meeting_note) } : {}),
    ...(optionalString(row.pending_event_id) ? { pendingEventId: optionalString(row.pending_event_id) } : {}),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Row): InteractionEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    characterId: String(row.character_id),
    ...storedScope(row),
    type: String(row.event_type) as InteractionEvent["type"],
    source: String(row.source) as InteractionEvent["source"],
    status: String(row.status) as InteractionEvent["status"],
    evidenceKind: String(row.evidence_kind) as InteractionEvent["evidenceKind"],
    fromPresence: String(row.from_presence) as InteractionEvent["fromPresence"],
    toPresence: String(row.to_presence) as InteractionEvent["toPresence"],
    ...(optionalString(row.place_id) ? { placeId: optionalString(row.place_id) } : {}),
    ...(optionalString(row.location_text) ? { location: optionalString(row.location_text) } : {}),
    summary: String(row.summary),
    beforeState: parseSnapshot(row.before_state_json),
    afterState: parseSnapshot(row.after_state_json),
    ...(optionalString(row.idempotency_key) ? { idempotencyKey: optionalString(row.idempotency_key) } : {}),
    createdAt: String(row.created_at),
    ...(optionalString(row.applied_at) ? { appliedAt: optionalString(row.applied_at) } : {}),
    ...(optionalString(row.reverted_at) ? { revertedAt: optionalString(row.reverted_at) } : {}),
  };
}

function parseSnapshot(value: unknown): InteractionStateSnapshot {
  const parsed = JSON.parse(String(value)) as InteractionStateSnapshot;
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function scopeParameters(scope: InteractionScope): ["normal" | "secret", string | null] {
  if (scope.conversationSpace === "normal") {
    if ("secretOwnerCharacterId" in scope && scope.secretOwnerCharacterId !== undefined) {
      throw new Error("normal interaction scope cannot have secretOwnerCharacterId");
    }
    return ["normal", null];
  }
  const owner = scope.secretOwnerCharacterId?.trim();
  if (!owner) throw new Error("secret interaction scope requires secretOwnerCharacterId");
  return ["secret", owner];
}

function assertStoredScope(value: {
  conversationSpace: "normal" | "secret";
  secretOwnerCharacterId?: string;
  characterId: string;
}): void {
  if (value.conversationSpace === "normal") {
    if (value.secretOwnerCharacterId !== undefined) {
      throw new Error("normal interaction scope cannot have secretOwnerCharacterId");
    }
    return;
  }
  const owner = value.secretOwnerCharacterId?.trim();
  if (!owner) throw new Error("secret interaction scope requires secretOwnerCharacterId");
  if (owner !== value.characterId) throw new Error("secret interaction owner must match characterId");
}

function storedScope(row: Row): InteractionScope {
  const conversationSpace = row.conversation_space;
  const owner = optionalString(row.secret_owner_character_id);
  const characterId = String(row.character_id);
  if (conversationSpace === "normal" && !owner) return { conversationSpace: "normal" };
  if (conversationSpace === "secret" && owner && owner === characterId) {
    return { conversationSpace: "secret", secretOwnerCharacterId: owner };
  }
  throw new Error("interaction scope data is corrupt");
}
