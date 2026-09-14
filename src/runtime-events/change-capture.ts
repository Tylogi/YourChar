import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { RuntimeEventStore, digest, runtimeEventHash, stableJson } from "./store.js";
import { runtimeEventTypes, type RuntimeEventScope } from "./types.js";

type Row = Record<string, SQLOutputValue>;

type ColumnDescriptor = Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  defaultValue: unknown;
  primaryKeyOrder: number;
}>;

type ForeignKeyDescriptor = Readonly<{
  id: number;
  sequence: number;
  parentTable: string;
  childColumn: string;
  parentColumn: string;
}>;

type TableDescriptor = Readonly<{
  name: string;
  sql: string;
  columns: readonly ColumnDescriptor[];
  primaryKey: readonly ColumnDescriptor[];
  foreignKeys: readonly ForeignKeyDescriptor[];
  classification: "projection" | "native_event" | "excluded";
  schemaHash: string;
  detail: string;
}>;

type ScopeKind = "conversationSpace" | "secretOwnerCharacterId" | "characterId" | "sessionId";

const zeroHash = "0".repeat(64);
const maximumTraversalDepth = 5;
const capturePolicyVersion = 2;
const nativeEventTables = new Set([
  "execution_job_output_chunks",
  "session_goal_transitions",
  "session_workflow_events",
]);
const excludedTables = new Set([
  "agent_module_provider_settings",
  "memory_vault_writer_lease",
  "schema_migrations",
  "task_bench_report_migrations",
]);

export function initializeRuntimeEventCapture(database: DatabaseSync): void {
  if (!tableExists(database, "runtime_event_capture_catalog")) return;
  registerFunctions(database);
  const descriptors = inspectTables(database);
  writeCatalog(database, descriptors);
  reconcileProjectionSnapshots(database, descriptors);
  installProjectionTriggers(database, descriptors);
}

export function projectionStreamId(table: string, key: readonly unknown[]): string {
  return `projection:${digest([table, ...key])}`;
}

function registerFunctions(database: DatabaseSync): void {
  database.function("__runtime_sha256", { deterministic: true }, (value) => sha256(String(value)));
  database.function(
    "__runtime_event_hash",
    { deterministic: true },
    (previousHash, streamSequence, eventType, eventVersion, payloadJson) => runtimeEventHash(
      String(previousHash),
      Number(streamSequence),
      String(eventType),
      Number(eventVersion),
      String(payloadJson),
    ),
  );
  database.function("__runtime_event_id", () => `runtime-event:${randomUUID()}`);
  database.function("__runtime_now", () => new Date().toISOString());
}

function inspectTables(database: DatabaseSync): Map<string, TableDescriptor> {
  const definitions = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string; sql: string | null }>;
  const partial = new Map<string, Omit<TableDescriptor, "schemaHash" | "detail">>();
  for (const definition of definitions) {
    const name = String(definition.name);
    const sql = String(definition.sql ?? "");
    const columns = (database.prepare(`PRAGMA table_info(${identifier(name)})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>).map((column) => ({
      cid: Number(column.cid),
      name: String(column.name),
      type: String(column.type),
      notnull: Number(column.notnull),
      defaultValue: column.dflt_value,
      primaryKeyOrder: Number(column.pk),
    }));
    const foreignKeys = (database.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>).map((foreignKey) => ({
      id: Number(foreignKey.id),
      sequence: Number(foreignKey.seq),
      parentTable: String(foreignKey.table),
      childColumn: String(foreignKey.from),
      parentColumn: String(foreignKey.to),
    }));
    partial.set(name, {
      name,
      sql,
      columns,
      primaryKey: columns
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder),
      foreignKeys,
      classification: classifyTable(name, sql),
    });
  }
  const descriptors = new Map<string, TableDescriptor>();
  for (const table of partial.values()) {
    const schema = {
      capturePolicyVersion,
      name: table.name,
      columns: table.columns,
      foreignKeys: table.foreignKeys,
    };
    descriptors.set(table.name, {
      ...table,
      schemaHash: digest(schema),
      detail: table.classification === "projection"
        ? "mutable durable row mirrored as a typed runtime projection stream"
        : table.classification === "native_event"
          ? "append-only typed domain ledger also mirrored for unified runtime replay"
          : excludedDetail(table.name, table.sql),
    });
  }
  return descriptors;
}

function classifyTable(name: string, sql: string): TableDescriptor["classification"] {
  if (
    name.startsWith("runtime_") || name.startsWith("rp_memories_fts") ||
    excludedTables.has(name) || /^CREATE\s+VIRTUAL\s+TABLE/iu.test(sql)
  ) return "excluded";
  if (nativeEventTables.has(name)) return "native_event";
  return "projection";
}

function excludedDetail(name: string, sql: string): string {
  if (name.startsWith("runtime_")) return "runtime event infrastructure; recursion excluded";
  if (name.startsWith("rp_memories_fts") || /^CREATE\s+VIRTUAL\s+TABLE/iu.test(sql)) {
    return "derived search index rebuilt from its authoritative projection";
  }
  if (name === "memory_vault_writer_lease") return "ephemeral process lease, not durable domain state";
  if (name === "agent_module_provider_settings") {
    return "may contain write-only provider secrets; intentionally never copied into the event ledger";
  }
  return "schema or one-shot migration bookkeeping";
}

function writeCatalog(database: DatabaseSync, descriptors: ReadonlyMap<string, TableDescriptor>): void {
  const updatedAt = new Date().toISOString();
  const upsert = database.prepare(`
    INSERT INTO runtime_event_capture_catalog(
      table_name, schema_hash, classification, detail, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(table_name) DO UPDATE SET
      schema_hash = excluded.schema_hash,
      classification = excluded.classification,
      detail = excluded.detail,
      updated_at = excluded.updated_at
  `);
  transaction(database, () => {
    for (const table of descriptors.values()) {
      upsert.run(table.name, table.schemaHash, table.classification, table.detail, updatedAt);
    }
    const names = [...descriptors.keys()];
    if (!names.length) {
      database.prepare("DELETE FROM runtime_event_capture_catalog").run();
      return;
    }
    database.prepare(`
      DELETE FROM runtime_event_capture_catalog
      WHERE table_name NOT IN (${names.map(() => "?").join(", ")})
    `).run(...names);
  });
}

function reconcileProjectionSnapshots(
  database: DatabaseSync,
  descriptors: ReadonlyMap<string, TableDescriptor>,
): void {
  const eventDatabase = {
    connection: database,
    transaction: <T>(operation: () => T): T => transaction(database, operation),
  };
  const events = new RuntimeEventStore(eventDatabase);
  for (const table of descriptors.values()) {
    if (table.classification === "excluded" || !table.primaryKey.length) continue;
    transaction(database, () => reconcileTable(database, events, descriptors, table));
  }
}

function reconcileTable(
  database: DatabaseSync,
  events: RuntimeEventStore,
  descriptors: ReadonlyMap<string, TableDescriptor>,
  table: TableDescriptor,
): void {
  const rows = database.prepare(`SELECT * FROM main.${identifier(table.name)}`).all() as Row[];
  const liveStreams = new Set<string>();
  const scopeSql = scopeSelectSql(descriptors, table);
  for (const rawRow of rows) {
    const key = table.primaryKey.map((column) => projectionValue(rawRow[column.name]));
    const streamId = projectionStreamId(table.name, key);
    liveStreams.add(streamId);
    const row = projectionRow(rawRow);
    const scope = readScope(database, table, rawRow, scopeSql);
    const head = database.prepare(`
      SELECT * FROM runtime_event_streams WHERE stream_id = ?
    `).get(streamId) as Row | undefined;
    if (head) reconcileStreamScope(database, streamId, head, scope);
    const previous = head ? events.replay(streamId) : undefined;
    const unchanged = previous?.kind === "projection" && previous.row !== null &&
      head?.projection_schema_hash === table.schemaHash && stableJson(previous.row) === stableJson(row);
    if (unchanged) continue;
    events.append({
      streamId,
      aggregateType: `projection:${table.name}`,
      aggregateId: [table.name, ...key],
      eventType: runtimeEventTypes.projectionUpserted,
      eventVersion: 2,
      payload: {
        projection: table.name,
        key,
        row,
        operation: !head ? "bootstrap" : head.projection_schema_hash !== table.schemaHash
          ? "migration" : "reconcile",
        schemaHash: table.schemaHash,
      },
      projectionSchemaHash: table.schemaHash,
      scope,
    });
  }
  const historical = database.prepare(`
    SELECT * FROM runtime_event_streams WHERE aggregate_type = ?
  `).all(`projection:${table.name}`) as Row[];
  for (const stream of historical) {
    const streamId = String(stream.stream_id);
    if (liveStreams.has(streamId)) continue;
    const state = events.replay(streamId);
    if (state?.kind !== "projection" || state.row === null) continue;
    const aggregateId = parseArray(String(stream.aggregate_id_json));
    const key = aggregateId.slice(1);
    events.append({
      streamId,
      aggregateType: `projection:${table.name}`,
      aggregateId,
      eventType: runtimeEventTypes.projectionDeleted,
      eventVersion: 1,
      payload: { projection: table.name, key, schemaHash: table.schemaHash },
      projectionSchemaHash: table.schemaHash,
      scope: scopeFromStream(stream),
    });
  }
}

function installProjectionTriggers(
  database: DatabaseSync,
  descriptors: ReadonlyMap<string, TableDescriptor>,
): void {
  for (const table of descriptors.values()) {
    if (table.classification === "excluded" || !table.primaryKey.length) continue;
    const base = `runtime_capture_${sha256(table.name).slice(0, 16)}`;
    for (const suffix of ["insert", "update", "delete"] as const) {
      database.exec(`DROP TRIGGER IF EXISTS temp.${identifier(`${base}_${suffix}`)}`);
    }
    database.exec(createTriggerSql(descriptors, table, base, "insert"));
    database.exec(createTriggerSql(descriptors, table, base, "update"));
    database.exec(createTriggerSql(descriptors, table, base, "delete"));
  }
}

function createTriggerSql(
  descriptors: ReadonlyMap<string, TableDescriptor>,
  table: TableDescriptor,
  triggerBase: string,
  operation: "insert" | "update" | "delete",
): string {
  const alias = operation === "delete" ? "OLD" : "NEW";
  const keyJson = jsonArray(table.primaryKey.map((column) => columnValue(alias, column.name)));
  const aggregateJson = jsonArray([literal(table.name), ...table.primaryKey.map((column) => columnValue(alias, column.name))]);
  const streamId = `${literal("projection:")} || __runtime_sha256(${aggregateJson})`;
  const rowJson = rowJsonExpression(table, alias);
  const scope = scopeExpressions(descriptors, table, alias);
  const payload = operation === "delete"
    ? `json_object('key', json(${keyJson}), 'projection', ${literal(table.name)}, 'schemaHash', ${literal(table.schemaHash)})`
    : `json_object('key', json(${keyJson}), 'operation', ${literal(operation)}, 'projection', ${literal(table.name)}, 'row', json(${rowJson}), 'schemaHash', ${literal(table.schemaHash)})`;
  const eventType = operation === "delete"
    ? runtimeEventTypes.projectionDeleted
    : runtimeEventTypes.projectionUpserted;
  const eventVersion = operation === "delete" ? 1 : 2;
  const body = captureTriggerBody({
    aggregateJson,
    eventType,
    eventVersion,
    payload,
    projection: table.name,
    schemaHash: table.schemaHash,
    scope,
    streamId,
  });
  return `
    CREATE TEMP TRIGGER ${identifier(`${triggerBase}_${operation}`)}
    AFTER ${operation.toUpperCase()} ON main.${identifier(table.name)}
    BEGIN
      ${body}
    END
  `;
}

function captureTriggerBody(input: {
  aggregateJson: string;
  eventType: string;
  eventVersion: number;
  payload: string;
  projection: string;
  schemaHash: string;
  scope: Readonly<Record<ScopeKind, string>>;
  streamId: string;
}): string {
  const conversationSpace = input.scope.conversationSpace;
  const secretOwner = `CASE WHEN (${conversationSpace}) = 'secret' THEN (${input.scope.secretOwnerCharacterId}) ELSE NULL END`;
  return `
    INSERT INTO runtime_event_streams(
      stream_id, aggregate_type, aggregate_id_json, conversation_space,
      secret_owner_character_id, character_id, session_id, projection_schema_hash,
      last_event_hash, created_at, updated_at
    ) VALUES (
      ${input.streamId}, ${literal(`projection:${input.projection}`)}, ${input.aggregateJson},
      ${conversationSpace}, ${secretOwner}, ${input.scope.characterId}, ${input.scope.sessionId},
      ${literal(input.schemaHash)}, ${literal(zeroHash)}, __runtime_now(), __runtime_now()
    ) ON CONFLICT(stream_id) DO NOTHING;

    INSERT INTO runtime_events(
      id, stream_id, stream_sequence, aggregate_type, event_type, event_version,
      payload_json, conversation_space, secret_owner_character_id, character_id,
      session_id, previous_hash, event_hash, occurred_at
    )
    SELECT
      __runtime_event_id(), stream_id, last_stream_sequence + 1, aggregate_type,
      ${literal(input.eventType)}, ${input.eventVersion}, ${input.payload},
      conversation_space, secret_owner_character_id, character_id, session_id,
      last_event_hash,
      __runtime_event_hash(
        last_event_hash, last_stream_sequence + 1, ${literal(input.eventType)},
        ${input.eventVersion}, ${input.payload}
      ),
      __runtime_now()
    FROM runtime_event_streams WHERE stream_id = ${input.streamId};

    UPDATE runtime_event_streams SET
      last_stream_sequence = last_stream_sequence + 1,
      last_event_hash = (
        SELECT event_hash FROM runtime_events
        WHERE stream_id = ${input.streamId} ORDER BY stream_sequence DESC LIMIT 1
      ),
      event_count = event_count + 1,
      events_since_checkpoint = events_since_checkpoint + 1,
      bytes_since_checkpoint = bytes_since_checkpoint + length(CAST(${input.payload} AS BLOB)),
      projection_schema_hash = ${literal(input.schemaHash)},
      updated_at = __runtime_now()
    WHERE stream_id = ${input.streamId};

    INSERT INTO runtime_event_checkpoints(
      stream_id, stream_sequence, event_sequence, event_type, event_version,
      state_schema_version, state_json, state_hash, event_hash, created_at
    )
    SELECT
      events.stream_id, events.stream_sequence, events.sequence, events.event_type,
      events.event_version, 1, events.payload_json, __runtime_sha256(events.payload_json),
      events.event_hash, events.occurred_at
    FROM runtime_events AS events
    JOIN runtime_event_streams AS streams ON streams.stream_id = events.stream_id
    WHERE events.stream_id = ${input.streamId}
      AND events.stream_sequence = streams.last_stream_sequence
      AND (
        streams.last_stream_sequence = 1 OR streams.events_since_checkpoint >= 64
        OR streams.bytes_since_checkpoint >= ${256 * 1024}
      );

    UPDATE runtime_event_streams SET
      checkpoint_stream_sequence = last_stream_sequence,
      events_since_checkpoint = 0,
      bytes_since_checkpoint = 0
    WHERE stream_id = ${input.streamId}
      AND EXISTS (
        SELECT 1 FROM runtime_event_checkpoints
        WHERE stream_id = ${input.streamId}
          AND stream_sequence = runtime_event_streams.last_stream_sequence
      );

    DELETE FROM runtime_event_checkpoints
    WHERE stream_id = ${input.streamId} AND stream_sequence NOT IN (
      SELECT stream_sequence FROM runtime_event_checkpoints
      WHERE stream_id = ${input.streamId} ORDER BY stream_sequence DESC LIMIT 4
    );
  `;
}

function scopeSelectSql(
  descriptors: ReadonlyMap<string, TableDescriptor>,
  table: TableDescriptor,
): string {
  const scope = scopeExpressions(descriptors, table, "root");
  return `
    SELECT
      ${scope.conversationSpace} AS conversation_space,
      ${scope.secretOwnerCharacterId} AS secret_owner_character_id,
      ${scope.characterId} AS character_id,
      ${scope.sessionId} AS session_id
    FROM main.${identifier(table.name)} AS root
    WHERE ${table.primaryKey.map((column) => `root.${identifier(column.name)} IS ?`).join(" AND ")}
    LIMIT 1
  `;
}

function readScope(
  database: DatabaseSync,
  table: TableDescriptor,
  row: Row,
  sql: string,
): RuntimeEventScope {
  const result = database.prepare(sql).get(
    ...table.primaryKey.map((column) => row[column.name]),
  ) as Row | undefined;
  if (!result) return {};
  const conversationSpace = stringValue(result.conversation_space);
  const secretOwnerCharacterId = conversationSpace === "secret"
    ? stringValue(result.secret_owner_character_id)
    : undefined;
  return {
    ...(conversationSpace === "normal" || conversationSpace === "secret" ? { conversationSpace } : {}),
    ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
    ...(stringValue(result.character_id) ? { characterId: stringValue(result.character_id) } : {}),
    ...(stringValue(result.session_id) ? { sessionId: stringValue(result.session_id) } : {}),
  };
}

function reconcileStreamScope(
  database: DatabaseSync,
  streamId: string,
  stored: Row,
  scope: RuntimeEventScope,
): void {
  const conversationSpace = scope.conversationSpace ?? null;
  const secretOwnerCharacterId = scope.secretOwnerCharacterId ?? null;
  const characterId = scope.characterId ?? null;
  const sessionId = scope.sessionId ?? null;
  if (
    (stored.conversation_space ?? null) === conversationSpace &&
    (stored.secret_owner_character_id ?? null) === secretOwnerCharacterId &&
    (stored.character_id ?? null) === characterId &&
    (stored.session_id ?? null) === sessionId
  ) return;
  database.prepare(`
    UPDATE runtime_event_streams SET
      conversation_space = ?, secret_owner_character_id = ?, character_id = ?, session_id = ?
    WHERE stream_id = ?
  `).run(conversationSpace, secretOwnerCharacterId, characterId, sessionId, streamId);
  database.prepare(`
    UPDATE runtime_events SET
      conversation_space = ?, secret_owner_character_id = ?, character_id = ?, session_id = ?
    WHERE stream_id = ?
  `).run(conversationSpace, secretOwnerCharacterId, characterId, sessionId, streamId);
}

function scopeExpressions(
  descriptors: ReadonlyMap<string, TableDescriptor>,
  table: TableDescriptor,
  alias: string,
): Readonly<Record<ScopeKind, string>> {
  const characterId = scopeExpression(descriptors, table, "characterId", alias, new Set(), 0);
  const explicitSecretOwner = scopeExpression(
    descriptors,
    table,
    "secretOwnerCharacterId",
    alias,
    new Set(),
    0,
  );
  return {
    conversationSpace: scopeExpression(descriptors, table, "conversationSpace", alias, new Set(), 0),
    secretOwnerCharacterId: explicitSecretOwner === "NULL" ? characterId : explicitSecretOwner,
    characterId,
    sessionId: scopeExpression(descriptors, table, "sessionId", alias, new Set(), 0),
  };
}

function scopeExpression(
  descriptors: ReadonlyMap<string, TableDescriptor>,
  table: TableDescriptor,
  kind: ScopeKind,
  alias: string,
  visited: ReadonlySet<string>,
  depth: number,
): string {
  const special = specialScopeExpression(table, kind, alias);
  if (special) return special;
  const direct = directScopeColumn(table, kind);
  if (direct) return `${alias}.${identifier(direct)}`;
  if (depth >= maximumTraversalDepth || visited.has(table.name)) return "NULL";
  const nextVisited = new Set(visited);
  nextVisited.add(table.name);
  const grouped = groupForeignKeys(table.foreignKeys);
  for (const [foreignKeyId, links] of grouped) {
    const parent = descriptors.get(links[0].parentTable);
    if (!parent || parent.classification === "excluded") continue;
    const parentAlias = `scope_${depth}_${foreignKeyId}`;
    const parentExpression = scopeExpression(
      descriptors,
      parent,
      kind,
      parentAlias,
      nextVisited,
      depth + 1,
    );
    if (parentExpression === "NULL") continue;
    const join = links.map((link) => (
      `${parentAlias}.${identifier(link.parentColumn)} IS ${alias}.${identifier(link.childColumn)}`
    )).join(" AND ");
    return `(SELECT ${parentExpression} FROM main.${identifier(parent.name)} AS ${parentAlias} WHERE ${join} LIMIT 1)`;
  }
  return "NULL";
}

function specialScopeExpression(
  table: TableDescriptor,
  kind: ScopeKind,
  alias: string,
): string | undefined {
  if (table.name !== "audit_actions") return undefined;
  if (kind === "conversationSpace") {
    return `json_extract(${alias}.${identifier("payload_json")}, '$.__rp_agent_action_scope_v1.conversationSpace')`;
  }
  if (kind === "secretOwnerCharacterId") {
    return `json_extract(${alias}.${identifier("payload_json")}, '$.__rp_agent_action_scope_v1.secretOwnerCharacterId')`;
  }
  if (kind === "sessionId") {
    return `json_extract(${alias}.${identifier("payload_json")}, '$.payload.sessionId')`;
  }
  return undefined;
}

function directScopeColumn(table: TableDescriptor, kind: ScopeKind): string | undefined {
  const names = new Set(table.columns.map((column) => column.name));
  const candidates: Record<ScopeKind, readonly string[]> = {
    conversationSpace: ["conversation_space"],
    secretOwnerCharacterId: ["secret_owner_character_id"],
    characterId: ["character_id", "owner_character_id"],
    sessionId: ["parent_session_id", "session_id", "app_session_id", "role_session_id", "source_session_id"],
  };
  if (kind === "characterId" && table.name === "characters") return "id";
  return candidates[kind].find((candidate) => names.has(candidate));
}

function groupForeignKeys(
  foreignKeys: readonly ForeignKeyDescriptor[],
): ReadonlyMap<number, readonly ForeignKeyDescriptor[]> {
  const grouped = new Map<number, ForeignKeyDescriptor[]>();
  for (const foreignKey of foreignKeys) {
    const list = grouped.get(foreignKey.id) ?? [];
    list.push(foreignKey);
    grouped.set(foreignKey.id, list);
  }
  for (const list of grouped.values()) list.sort((left, right) => left.sequence - right.sequence);
  return grouped;
}

function rowJsonExpression(table: TableDescriptor, alias: string): string {
  const entries: string[] = [];
  for (const column of [...table.columns].sort((left, right) => left.name.localeCompare(right.name))) {
    entries.push(literal(column.name), columnValue(alias, column.name));
  }
  return `json_object(${entries.join(", ")})`;
}

function columnValue(alias: string, column: string): string {
  const reference = `${alias}.${identifier(column)}`;
  return `CASE WHEN typeof(${reference}) = 'blob' THEN json_object('$binaryHex', lower(hex(${reference}))) ELSE ${reference} END`;
}

function jsonArray(values: readonly string[]): string {
  return `json_array(${values.join(", ")})`;
}

function projectionRow(row: Row): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.keys(row).sort().map((key) => [key, projectionValue(row[key])]),
  );
}

function projectionValue(value: SQLOutputValue | undefined): unknown {
  if (value instanceof Uint8Array) return { $binaryHex: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return { $integer: value.toString() };
  return value ?? null;
}

function scopeFromStream(stream: Row): RuntimeEventScope {
  const conversationSpace = stringValue(stream.conversation_space);
  return {
    ...(conversationSpace === "normal" || conversationSpace === "secret" ? { conversationSpace } : {}),
    ...(stringValue(stream.secret_owner_character_id)
      ? { secretOwnerCharacterId: stringValue(stream.secret_owner_character_id) }
      : {}),
    ...(stringValue(stream.character_id) ? { characterId: stringValue(stream.character_id) } : {}),
    ...(stringValue(stream.session_id) ? { sessionId: stringValue(stream.session_id) } : {}),
  };
}

function parseArray(value: string): readonly unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("runtime projection aggregate id must be an array");
  return parsed;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) return operation();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
