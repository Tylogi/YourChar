import type { ConversationMetadata } from "../pi/session-runtime.js";
import type { ContextLogEntry, ConversationSpace } from "../domain/types.js";

export const runtimeEventTypes = {
  projectionUpserted: "runtime.projection.upserted",
  projectionDeleted: "runtime.projection.deleted",
  sessionSnapshotted: "runtime.session.snapshotted",
  sessionDeleted: "runtime.session.deleted",
  turnSettled: "runtime.turn.settled",
} as const;

export type RuntimeEventType = typeof runtimeEventTypes[keyof typeof runtimeEventTypes];

export type RuntimeEventScope = Readonly<{
  conversationSpace?: ConversationSpace;
  secretOwnerCharacterId?: string;
  characterId?: string;
  sessionId?: string;
}>;

export type RuntimeProjectionUpsertV1 = Readonly<{
  table: string;
  key: readonly unknown[];
  value: Readonly<Record<string, unknown>>;
}>;

export type RuntimeProjectionUpsertV2 = Readonly<{
  projection: string;
  key: readonly unknown[];
  row: Readonly<Record<string, unknown>>;
  operation: "bootstrap" | "insert" | "update" | "migration";
  schemaHash: string;
}>;

export type RuntimeProjectionDeletedV1 = Readonly<{
  projection: string;
  key: readonly unknown[];
  schemaHash: string;
}>;

export type RuntimeSessionSnapshotV1 = Readonly<{
  session: Readonly<Omit<ConversationMetadata, "piSessionFile">>;
  transition: "bootstrap" | "created" | "updated" | "archived" | "restored";
}>;

export type RuntimeSessionDeletedV1 = Readonly<{
  sessionId: string;
}>;

export type RuntimeTurnSettledV1 = Readonly<{
  turn: ContextLogEntry;
}>;

export type RuntimeVersionedEvent =
  | Readonly<{
      eventType: typeof runtimeEventTypes.projectionUpserted;
      eventVersion: 1;
      payload: RuntimeProjectionUpsertV1;
    }>
  | Readonly<{
      eventType: typeof runtimeEventTypes.projectionUpserted;
      eventVersion: 2;
      payload: RuntimeProjectionUpsertV2;
    }>
  | Readonly<{
      eventType: typeof runtimeEventTypes.projectionDeleted;
      eventVersion: 1;
      payload: RuntimeProjectionDeletedV1;
    }>
  | Readonly<{
      eventType: typeof runtimeEventTypes.sessionSnapshotted;
      eventVersion: 1;
      payload: RuntimeSessionSnapshotV1;
    }>
  | Readonly<{
      eventType: typeof runtimeEventTypes.sessionDeleted;
      eventVersion: 1;
      payload: RuntimeSessionDeletedV1;
    }>
  | Readonly<{
      eventType: typeof runtimeEventTypes.turnSettled;
      eventVersion: 1;
      payload: RuntimeTurnSettledV1;
    }>;

export type RuntimeEventAppend = RuntimeVersionedEvent & Readonly<{
  streamId: string;
  aggregateType: string;
  aggregateId: readonly unknown[];
  scope?: RuntimeEventScope;
  projectionSchemaHash?: string;
  occurredAt?: string;
}>;

export type RuntimeEventRecord = Readonly<{
  sequence: number;
  id: string;
  streamId: string;
  streamSequence: number;
  aggregateType: string;
  eventType: RuntimeEventType;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  scope: RuntimeEventScope;
  previousHash: string;
  eventHash: string;
  occurredAt: string;
}>;

export type RuntimeReplayState =
  | Readonly<{
      kind: "projection";
      projection: string;
      key: readonly unknown[];
      row: Readonly<Record<string, unknown>> | null;
      schemaHash: string;
    }>
  | Readonly<{
      kind: "session";
      session: Readonly<Omit<ConversationMetadata, "piSessionFile">> | null;
    }>
  | Readonly<{
      kind: "turn";
      turn: ContextLogEntry;
    }>;

export type RuntimeEventIntegrity = Readonly<{
  ok: boolean;
  streamCount: number;
  eventCount: number;
  checkpointCount: number;
  errors: readonly string[];
}>;
