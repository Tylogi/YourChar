import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type { ContextLogEntry } from "../domain/types.js";
import type { ConversationMetadata } from "../pi/session-runtime.js";
import type { AppDatabase } from "../storage/database.js";
import { applyRuntimeEvent, validateRuntimeEvent } from "./schema.js";
import {
  runtimeEventTypes,
  type RuntimeEventAppend,
  type RuntimeEventIntegrity,
  type RuntimeEventRecord,
  type RuntimeEventScope,
  type RuntimeReplayState,
} from "./types.js";

const zeroHash = "0".repeat(64);
const checkpointEveryEvents = 64;
const checkpointEveryBytes = 256 * 1024;
const retainedCheckpoints = 4;
const maximumPayloadBytes = 16 * 1024 * 1024;
type Row = Record<string, unknown>;

export class RuntimeEventStore {
  private readonly clock: Clock;

  constructor(private readonly database: AppDatabase, clock?: Clock) {
    this.clock = clock ?? new SystemClock();
  }

  get available(): boolean {
    return Boolean(this.database.connection.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_events'
    `).get());
  }

  append(input: RuntimeEventAppend): RuntimeEventRecord {
    if (!this.available) throw new Error("runtime event store is unavailable before schema 69");
    validateAppend(input);
    const payloadJson = stableJson(input.payload);
    if (Buffer.byteLength(payloadJson) > maximumPayloadBytes) {
      throw new Error("runtime event payload exceeds 16 MiB");
    }
    const occurredAt = input.occurredAt ?? this.clock.now().toISOString();
    const scope = normalizedScope(input.scope);
    return this.inTransaction(() => {
      const existing = this.database.connection.prepare(
        "SELECT * FROM runtime_event_streams WHERE stream_id = ?",
      ).get(input.streamId) as Row | undefined;
      if (existing) assertStreamIdentity(existing, input, scope);
      else this.insertStream(input, scope, occurredAt);
      const head = this.database.connection.prepare(
        "SELECT * FROM runtime_event_streams WHERE stream_id = ?",
      ).get(input.streamId) as Row;
      const streamSequence = Number(head.last_stream_sequence) + 1;
      const previousHash = String(head.last_event_hash);
      const eventHash = runtimeEventHash(
        previousHash,
        streamSequence,
        input.eventType,
        input.eventVersion,
        payloadJson,
      );
      const id = `runtime-event:${randomUUID()}`;
      const inserted = this.database.connection.prepare(`
        INSERT INTO runtime_events(
          id, stream_id, stream_sequence, aggregate_type, event_type, event_version,
          payload_json, conversation_space, secret_owner_character_id, character_id,
          session_id, previous_hash, event_hash, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING sequence
      `).get(
        id,
        input.streamId,
        streamSequence,
        input.aggregateType,
        input.eventType,
        input.eventVersion,
        payloadJson,
        scope.conversationSpace ?? null,
        scope.secretOwnerCharacterId ?? null,
        scope.characterId ?? null,
        scope.sessionId ?? null,
        previousHash,
        eventHash,
        occurredAt,
      ) as { sequence: number };
      const payloadBytes = Buffer.byteLength(payloadJson);
      this.database.connection.prepare(`
        UPDATE runtime_event_streams
        SET last_stream_sequence = ?, last_event_hash = ?, event_count = event_count + 1,
            events_since_checkpoint = events_since_checkpoint + 1,
            bytes_since_checkpoint = bytes_since_checkpoint + ?,
            projection_schema_hash = COALESCE(?, projection_schema_hash), updated_at = ?
        WHERE stream_id = ?
      `).run(
        streamSequence,
        eventHash,
        payloadBytes,
        input.projectionSchemaHash ?? null,
        occurredAt,
        input.streamId,
      );
      this.maybeCheckpoint({
        streamId: input.streamId,
        streamSequence,
        eventSequence: Number(inserted.sequence),
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        payloadJson,
        eventHash,
        occurredAt,
      });
      return {
        sequence: Number(inserted.sequence),
        id,
        streamId: input.streamId,
        streamSequence,
        aggregateType: input.aggregateType,
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        payload: JSON.parse(payloadJson) as Readonly<Record<string, unknown>>,
        scope,
        previousHash,
        eventHash,
        occurredAt,
      };
    });
  }

  recordSessionSnapshot(
    metadata: ConversationMetadata,
    transition: "bootstrap" | "created" | "updated" | "archived" | "restored",
  ): RuntimeEventRecord {
    const { piSessionFile: _piSessionFile, ...session } = metadata;
    return this.append({
      streamId: sessionStreamId(metadata.id),
      aggregateType: "session",
      aggregateId: [metadata.id],
      eventType: runtimeEventTypes.sessionSnapshotted,
      eventVersion: 1,
      payload: { session, transition },
      scope: {
        conversationSpace: metadata.conversationSpace,
        ...(metadata.conversationSpace === "secret" && metadata.characterId
          ? { secretOwnerCharacterId: metadata.characterId }
          : {}),
        ...(metadata.characterId ? { characterId: metadata.characterId } : {}),
        sessionId: metadata.id,
      },
      occurredAt: metadata.updatedAt,
    });
  }

  recordSessionDeleted(metadata: ConversationMetadata): RuntimeEventRecord {
    return this.append({
      streamId: sessionStreamId(metadata.id),
      aggregateType: "session",
      aggregateId: [metadata.id],
      eventType: runtimeEventTypes.sessionDeleted,
      eventVersion: 1,
      payload: { sessionId: metadata.id },
      scope: {
        conversationSpace: metadata.conversationSpace,
        ...(metadata.conversationSpace === "secret" && metadata.characterId
          ? { secretOwnerCharacterId: metadata.characterId }
          : {}),
        ...(metadata.characterId ? { characterId: metadata.characterId } : {}),
        sessionId: metadata.id,
      },
      occurredAt: metadata.updatedAt,
    });
  }

  recordTurnSettled(turn: ContextLogEntry): RuntimeEventRecord {
    return this.append({
      streamId: `turn:${digest([turn.sessionId, turn.id])}`,
      aggregateType: "turn",
      aggregateId: [turn.sessionId, turn.id],
      eventType: runtimeEventTypes.turnSettled,
      eventVersion: 1,
      payload: { turn },
      scope: {
        conversationSpace: turn.conversationSpace,
        ...(turn.secretOwnerCharacterId
          ? { secretOwnerCharacterId: turn.secretOwnerCharacterId }
          : {}),
        sessionId: turn.sessionId,
      },
      occurredAt: turn.createdAt,
    });
  }

  replay(streamId: string, throughStreamSequence = Number.POSITIVE_INFINITY): RuntimeReplayState | undefined {
    if (!this.available) return undefined;
    if (!Number.isFinite(throughStreamSequence)) throughStreamSequence = Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(throughStreamSequence) || throughStreamSequence < 0) {
      throw new Error("throughStreamSequence must be a non-negative safe integer");
    }
    const checkpoint = this.database.connection.prepare(`
      SELECT * FROM runtime_event_checkpoints
      WHERE stream_id = ? AND stream_sequence <= ?
      ORDER BY stream_sequence DESC LIMIT 1
    `).get(streamId, throughStreamSequence) as Row | undefined;
    let state: RuntimeReplayState | undefined;
    let after = 0;
    let previousHash: string | undefined;
    if (checkpoint) {
      const stateJson = String(checkpoint.state_json);
      if (digestText(stateJson) !== String(checkpoint.state_hash)) {
        throw new Error(`runtime checkpoint hash mismatch for ${streamId}`);
      }
      const checkpointEvent = this.database.connection.prepare(`
        SELECT payload_json, event_hash FROM runtime_events
        WHERE sequence = ? AND stream_id = ? AND stream_sequence = ?
      `).get(
        Number(checkpoint.event_sequence),
        streamId,
        Number(checkpoint.stream_sequence),
      ) as Row | undefined;
      if (
        !checkpointEvent ||
        String(checkpointEvent.payload_json) !== stateJson ||
        String(checkpointEvent.event_hash) !== String(checkpoint.event_hash)
      ) throw new Error(`runtime checkpoint event mismatch for ${streamId}`);
      state = applyRuntimeEvent(undefined, {
        eventType: runtimeEventType(checkpoint.event_type),
        eventVersion: Number(checkpoint.event_version),
        payload: parseRecord(stateJson),
      });
      after = Number(checkpoint.stream_sequence);
      previousHash = String(checkpoint.event_hash);
    }
    const events = this.database.connection.prepare(`
      SELECT * FROM runtime_events
      WHERE stream_id = ? AND stream_sequence > ? AND stream_sequence <= ?
      ORDER BY stream_sequence
    `).all(streamId, after, throughStreamSequence) as Row[];
    for (const row of events) {
      if (previousHash !== undefined && String(row.previous_hash) !== previousHash) {
        throw new Error(`runtime event chain mismatch for ${streamId}`);
      }
      const event = decodeEvent(row);
      state = applyRuntimeEvent(state, event);
      previousHash = event.eventHash;
    }
    return state;
  }

  verifyIntegrity(): RuntimeEventIntegrity {
    if (!this.available) {
      return { ok: false, streamCount: 0, eventCount: 0, checkpointCount: 0, errors: ["schema unavailable"] };
    }
    const errors: string[] = [];
    const streams = this.database.connection.prepare(
      "SELECT * FROM runtime_event_streams ORDER BY stream_id",
    ).all() as Row[];
    let eventCount = 0;
    for (const stream of streams) {
      const streamId = String(stream.stream_id);
      const events = this.database.connection.prepare(
        "SELECT * FROM runtime_events WHERE stream_id = ? ORDER BY stream_sequence",
      ).all(streamId) as Row[];
      let previousHash = zeroHash;
      let expectedSequence = 1;
      for (const row of events) {
        eventCount += 1;
        try {
          const event = decodeEvent(row);
          if (event.streamSequence !== expectedSequence) throw new Error("non-contiguous stream sequence");
          if (event.previousHash !== previousHash) throw new Error("previous hash mismatch");
          const payloadJson = String(row.payload_json);
          if (event.eventHash !== runtimeEventHash(
            previousHash,
            expectedSequence,
            event.eventType,
            event.eventVersion,
            payloadJson,
          )) throw new Error("event hash mismatch");
          validateRuntimeEvent(event);
          previousHash = event.eventHash;
          expectedSequence += 1;
        } catch (error) {
          pushError(errors, `${streamId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (Number(stream.last_stream_sequence) !== events.length) {
        pushError(errors, `${streamId}: stream head sequence mismatch`);
      }
      if (String(stream.last_event_hash) !== previousHash) {
        pushError(errors, `${streamId}: stream head hash mismatch`);
      }
    }
    const checkpoints = this.database.connection.prepare(
      "SELECT * FROM runtime_event_checkpoints ORDER BY stream_id, stream_sequence",
    ).all() as Row[];
    for (const checkpoint of checkpoints) {
      const stateJson = String(checkpoint.state_json);
      if (digestText(stateJson) !== String(checkpoint.state_hash)) {
        pushError(errors, `${checkpoint.stream_id}: checkpoint state hash mismatch`);
      }
      const event = this.database.connection.prepare(
        "SELECT event_hash FROM runtime_events WHERE sequence = ? AND stream_id = ? AND stream_sequence = ?",
      ).get(
        Number(checkpoint.event_sequence),
        String(checkpoint.stream_id),
        Number(checkpoint.stream_sequence),
      ) as Row | undefined;
      if (!event || String(event.event_hash) !== String(checkpoint.event_hash)) {
        pushError(errors, `${checkpoint.stream_id}: checkpoint event mismatch`);
      }
    }
    return {
      ok: errors.length === 0,
      streamCount: streams.length,
      eventCount,
      checkpointCount: checkpoints.length,
      errors,
    };
  }

  private insertStream(input: RuntimeEventAppend, scope: RuntimeEventScope, occurredAt: string): void {
    this.database.connection.prepare(`
      INSERT INTO runtime_event_streams(
        stream_id, aggregate_type, aggregate_id_json, conversation_space,
        secret_owner_character_id, character_id, session_id, projection_schema_hash,
        last_event_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.streamId,
      input.aggregateType,
      stableJson(input.aggregateId),
      scope.conversationSpace ?? null,
      scope.secretOwnerCharacterId ?? null,
      scope.characterId ?? null,
      scope.sessionId ?? null,
      input.projectionSchemaHash ?? null,
      zeroHash,
      occurredAt,
      occurredAt,
    );
  }

  private maybeCheckpoint(input: {
    streamId: string;
    streamSequence: number;
    eventSequence: number;
    eventType: string;
    eventVersion: number;
    payloadJson: string;
    eventHash: string;
    occurredAt: string;
  }): void {
    const head = this.database.connection.prepare(
      "SELECT events_since_checkpoint, bytes_since_checkpoint FROM runtime_event_streams WHERE stream_id = ?",
    ).get(input.streamId) as Row;
    if (
      input.streamSequence !== 1 &&
      Number(head.events_since_checkpoint) < checkpointEveryEvents &&
      Number(head.bytes_since_checkpoint) < checkpointEveryBytes
    ) return;
    this.database.connection.prepare(`
      INSERT INTO runtime_event_checkpoints(
        stream_id, stream_sequence, event_sequence, event_type, event_version,
        state_schema_version, state_json, state_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      input.streamId,
      input.streamSequence,
      input.eventSequence,
      input.eventType,
      input.eventVersion,
      input.payloadJson,
      digestText(input.payloadJson),
      input.eventHash,
      input.occurredAt,
    );
    this.database.connection.prepare(`
      UPDATE runtime_event_streams
      SET checkpoint_stream_sequence = ?, events_since_checkpoint = 0,
          bytes_since_checkpoint = 0
      WHERE stream_id = ?
    `).run(input.streamSequence, input.streamId);
    this.database.connection.prepare(`
      DELETE FROM runtime_event_checkpoints
      WHERE stream_id = ? AND stream_sequence NOT IN (
        SELECT stream_sequence FROM runtime_event_checkpoints
        WHERE stream_id = ? ORDER BY stream_sequence DESC LIMIT ?
      )
    `).run(input.streamId, input.streamId, retainedCheckpoints);
  }

  private inTransaction<T>(operation: () => T): T {
    return this.database.connection.isTransaction ? operation() : this.database.transaction(operation);
  }
}

export function runtimeEventHash(
  previousHash: string,
  streamSequence: number,
  eventType: string,
  eventVersion: number,
  payloadJson: string,
): string {
  return digestText(`${previousHash}\n${streamSequence}\n${eventType}\n${eventVersion}\n${payloadJson}`);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function digest(value: unknown): string {
  return digestText(stableJson(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("runtime event JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value && typeof value === "object") {
    if (Buffer.isBuffer(value)) return { $binaryHex: value.toString("hex") };
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = canonicalValue(entry);
    }
    return output;
  }
  throw new Error(`runtime event JSON cannot contain ${typeof value}`);
}

function validateAppend(input: RuntimeEventAppend): void {
  if (!input.streamId.trim() || input.streamId.length > 512) throw new Error("invalid runtime stream id");
  if (!input.aggregateType.trim() || input.aggregateType.length > 128) throw new Error("invalid aggregate type");
  if (!Array.isArray(input.aggregateId)) throw new Error("runtime aggregate id must be an array");
  if (input.projectionSchemaHash && !/^[a-f0-9]{64}$/u.test(input.projectionSchemaHash)) {
    throw new Error("invalid projection schema hash");
  }
  validateRuntimeEvent({
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    payload: input.payload as Readonly<Record<string, unknown>>,
  });
}

function normalizedScope(scope: RuntimeEventScope = {}): RuntimeEventScope {
  if (scope.conversationSpace === "secret" && !scope.secretOwnerCharacterId?.trim()) {
    throw new Error("secret runtime event scope requires a character owner");
  }
  if (scope.conversationSpace !== "secret" && scope.secretOwnerCharacterId !== undefined) {
    throw new Error("non-secret runtime event scope cannot have a secret owner");
  }
  return {
    ...(scope.conversationSpace ? { conversationSpace: scope.conversationSpace } : {}),
    ...(scope.secretOwnerCharacterId?.trim()
      ? { secretOwnerCharacterId: scope.secretOwnerCharacterId.trim() }
      : {}),
    ...(scope.characterId?.trim() ? { characterId: scope.characterId.trim() } : {}),
    ...(scope.sessionId?.trim() ? { sessionId: scope.sessionId.trim() } : {}),
  };
}

function assertStreamIdentity(row: Row, input: RuntimeEventAppend, scope: RuntimeEventScope): void {
  if (
    String(row.aggregate_type) !== input.aggregateType ||
    String(row.aggregate_id_json) !== stableJson(input.aggregateId) ||
    nullableString(row.conversation_space) !== scope.conversationSpace ||
    nullableString(row.secret_owner_character_id) !== scope.secretOwnerCharacterId ||
    nullableString(row.character_id) !== scope.characterId ||
    nullableString(row.session_id) !== scope.sessionId
  ) throw new Error("runtime event stream identity or scope changed");
}

function decodeEvent(row: Row): RuntimeEventRecord {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    streamId: String(row.stream_id),
    streamSequence: Number(row.stream_sequence),
    aggregateType: String(row.aggregate_type),
    eventType: runtimeEventType(row.event_type),
    eventVersion: Number(row.event_version),
    payload: parseRecord(String(row.payload_json)),
    scope: {
      ...(nullableString(row.conversation_space)
        ? { conversationSpace: nullableString(row.conversation_space) as "normal" | "secret" }
        : {}),
      ...(nullableString(row.secret_owner_character_id)
        ? { secretOwnerCharacterId: nullableString(row.secret_owner_character_id)! }
        : {}),
      ...(nullableString(row.character_id) ? { characterId: nullableString(row.character_id)! } : {}),
      ...(nullableString(row.session_id) ? { sessionId: nullableString(row.session_id)! } : {}),
    },
    previousHash: String(row.previous_hash),
    eventHash: String(row.event_hash),
    occurredAt: String(row.occurred_at),
  };
}

function runtimeEventType(value: unknown): RuntimeEventRecord["eventType"] {
  if (!Object.values(runtimeEventTypes).includes(value as never)) {
    throw new Error(`unsupported runtime event type: ${String(value)}`);
  }
  return value as RuntimeEventRecord["eventType"];
}

function parseRecord(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime event payload must be an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sessionStreamId(sessionId: string): string {
  return `session:${digest([sessionId])}`;
}

function pushError(errors: string[], error: string): void {
  if (errors.length < 100) errors.push(error.slice(0, 1_000));
}
