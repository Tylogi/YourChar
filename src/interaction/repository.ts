import type { AppDatabase } from "../storage/database.js";
import type {
  InteractionEvent,
  InteractionEventStatus,
  InteractionState,
  InteractionStateSnapshot,
} from "./types.js";

type Row = Record<string, unknown>;

export class InteractionRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  getState(sessionId: string): InteractionState | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM conversation_interaction_states WHERE session_id = ?",
    ).get(sessionId) as Row | undefined;
    return row ? mapState(row) : undefined;
  }

  upsertState(state: InteractionState): InteractionState {
    this.database.connection.prepare(`
      INSERT INTO conversation_interaction_states(
        session_id, character_id, continuity, presence, narrative_lens,
        place_id, location_text, meeting_note, pending_event_id,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        character_id = excluded.character_id,
        continuity = excluded.continuity,
        presence = excluded.presence,
        narrative_lens = excluded.narrative_lens,
        place_id = excluded.place_id,
        location_text = excluded.location_text,
        meeting_note = excluded.meeting_note,
        pending_event_id = excluded.pending_event_id,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(
      state.sessionId,
      state.characterId,
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
    return state;
  }

  findCanonicalCoPresentSession(characterId: string, exceptSessionId?: string): InteractionState | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM conversation_interaction_states
      WHERE character_id = ? AND continuity = 'canonical' AND presence = 'co_present'
        AND session_id <> COALESCE(?, '')
      ORDER BY updated_at DESC LIMIT 1
    `).get(characterId, exceptSessionId ?? null) as Row | undefined;
    return row ? mapState(row) : undefined;
  }

  createEvent(event: InteractionEvent): InteractionEvent {
    this.database.connection.prepare(`
      INSERT INTO interaction_transition_events(
        id, session_id, character_id, event_type, source, status, evidence_kind,
        from_presence, to_presence, place_id, location_text, summary,
        before_state_json, after_state_json, idempotency_key,
        created_at, applied_at, reverted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.sessionId,
      event.characterId,
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

  getEvent(id: string): InteractionEvent | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM interaction_transition_events WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  findEventByIdempotencyKey(key: string): InteractionEvent | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM interaction_transition_events WHERE idempotency_key = ?",
    ).get(key) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  updateEventStatus(
    id: string,
    status: InteractionEventStatus,
    patch: { appliedAt?: string; revertedAt?: string } = {},
  ): void {
    this.database.connection.prepare(`
      UPDATE interaction_transition_events
      SET status = ?,
          applied_at = COALESCE(?, applied_at),
          reverted_at = COALESCE(?, reverted_at)
      WHERE id = ?
    `).run(status, patch.appliedAt ?? null, patch.revertedAt ?? null, id);
  }

  listEvents(sessionId: string, limit = 50): InteractionEvent[] {
    return (this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(200, Math.floor(limit)))) as Row[])
      .map(mapEvent)
      .reverse();
  }

  listAllEvents(sessionId: string): InteractionEvent[] {
    return (this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(sessionId) as Row[]).map(mapEvent);
  }

  latestAppliedReversibleEvent(sessionId: string): InteractionEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND status = 'applied'
        AND event_type <> 'undo_transition'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(sessionId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  latestAppliedBeginEvent(sessionId: string): InteractionEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM interaction_transition_events
      WHERE session_id = ? AND status = 'applied' AND event_type = 'begin_meeting'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(sessionId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }
}

function mapState(row: Row): InteractionState {
  return {
    sessionId: String(row.session_id),
    characterId: String(row.character_id),
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
