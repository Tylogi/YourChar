import {
  runtimeEventTypes,
  type RuntimeEventRecord,
  type RuntimeProjectionDeletedV1,
  type RuntimeProjectionUpsertV2,
  type RuntimeReplayState,
  type RuntimeSessionDeletedV1,
  type RuntimeSessionSnapshotV1,
  type RuntimeTurnSettledV1,
} from "./types.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export function applyRuntimeEvent(
  state: RuntimeReplayState | undefined,
  event: Pick<RuntimeEventRecord, "eventType" | "eventVersion" | "payload">,
): RuntimeReplayState {
  if (event.eventType === runtimeEventTypes.projectionUpserted) {
    const payload = migrateProjectionUpsert(event.eventVersion, event.payload);
    return {
      kind: "projection",
      projection: payload.projection,
      key: payload.key,
      row: payload.row,
      schemaHash: payload.schemaHash,
    };
  }
  if (event.eventType === runtimeEventTypes.projectionDeleted) {
    requireVersion(event, 1);
    const payload = projectionDeleted(event.payload);
    if (state?.kind === "projection" && (
      state.projection !== payload.projection ||
      JSON.stringify(state.key) !== JSON.stringify(payload.key)
    )) throw new Error("runtime projection delete does not match its stream state");
    return {
      kind: "projection",
      projection: payload.projection,
      key: payload.key,
      row: null,
      schemaHash: payload.schemaHash,
    };
  }
  if (event.eventType === runtimeEventTypes.sessionSnapshotted) {
    requireVersion(event, 1);
    const payload = sessionSnapshot(event.payload);
    return { kind: "session", session: payload.session };
  }
  if (event.eventType === runtimeEventTypes.sessionDeleted) {
    requireVersion(event, 1);
    sessionDeleted(event.payload);
    return { kind: "session", session: null };
  }
  if (event.eventType === runtimeEventTypes.turnSettled) {
    requireVersion(event, 1);
    return { kind: "turn", turn: turnSettled(event.payload).turn };
  }
  throw new Error(`unsupported runtime event type: ${String(event.eventType)}`);
}

export function validateRuntimeEvent(
  event: Pick<RuntimeEventRecord, "eventType" | "eventVersion" | "payload">,
): void {
  applyRuntimeEvent(undefined, event);
}

function migrateProjectionUpsert(
  version: number,
  value: Readonly<Record<string, unknown>>,
): RuntimeProjectionUpsertV2 {
  if (version === 1) {
    const table = requiredString(value.table, "projection upsert v1 table");
    return projectionUpsertV2({
      projection: table,
      key: requiredArray(value.key, "projection upsert v1 key"),
      row: requiredRecord(value.value, "projection upsert v1 value"),
      operation: "migration",
      schemaHash: legacySchemaHash(table),
    });
  }
  if (version === 2) return projectionUpsertV2(value);
  throw new Error(`unsupported runtime.projection.upserted version: ${version}`);
}

function projectionUpsertV2(value: Readonly<Record<string, unknown>>): RuntimeProjectionUpsertV2 {
  const operation = value.operation;
  if (
    operation !== "bootstrap" && operation !== "insert" &&
    operation !== "update" && operation !== "migration" && operation !== "reconcile"
  ) throw new Error("invalid projection upsert operation");
  const schemaHash = requiredString(value.schemaHash, "projection schemaHash");
  if (!sha256Pattern.test(schemaHash)) throw new Error("invalid projection schemaHash");
  return {
    projection: requiredString(value.projection, "projection name"),
    key: requiredArray(value.key, "projection key"),
    row: requiredRecord(value.row, "projection row"),
    operation,
    schemaHash,
  };
}

function projectionDeleted(value: Readonly<Record<string, unknown>>): RuntimeProjectionDeletedV1 {
  const schemaHash = requiredString(value.schemaHash, "projection delete schemaHash");
  if (!sha256Pattern.test(schemaHash)) throw new Error("invalid projection delete schemaHash");
  return {
    projection: requiredString(value.projection, "projection delete name"),
    key: requiredArray(value.key, "projection delete key"),
    schemaHash,
  };
}

function sessionSnapshot(value: Readonly<Record<string, unknown>>): RuntimeSessionSnapshotV1 {
  const transition = value.transition;
  if (
    transition !== "bootstrap" && transition !== "created" && transition !== "updated" &&
    transition !== "archived" && transition !== "restored"
  ) throw new Error("invalid session snapshot transition");
  const session = requiredRecord(value.session, "session snapshot");
  requiredString(session.id, "session id");
  return { session: session as RuntimeSessionSnapshotV1["session"], transition };
}

function sessionDeleted(value: Readonly<Record<string, unknown>>): RuntimeSessionDeletedV1 {
  return { sessionId: requiredString(value.sessionId, "deleted session id") };
}

function turnSettled(value: Readonly<Record<string, unknown>>): RuntimeTurnSettledV1 {
  const turn = requiredRecord(value.turn, "settled turn");
  requiredString(turn.id, "settled turn id");
  requiredString(turn.sessionId, "settled turn session id");
  return { turn: turn as RuntimeTurnSettledV1["turn"] };
}

function requireVersion(
  event: Pick<RuntimeEventRecord, "eventType" | "eventVersion">,
  expected: number,
): void {
  if (event.eventVersion !== expected) {
    throw new Error(`unsupported ${event.eventType} version: ${event.eventVersion}`);
  }
}

function requiredRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function requiredArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function legacySchemaHash(table: string): string {
  // Stable compatibility marker for version-1 events, not a live table digest.
  return table.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/gu, "0");
}
