import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import {
  RuntimeEventStore,
  initializeRuntimeEventCapture,
  projectionStreamId,
  runtimeEventTypes,
} from "../src/runtime-events/index.js";
import { AppDatabase } from "../src/storage/database.js";

const schemaHash = "a".repeat(64);

test("runtime event streams migrate typed payloads and replay from bounded checkpoints", () => {
  const database = new AppDatabase(":memory:");
  const clock = new VirtualClock("2026-09-15T00:00:00.000Z");
  const events = new RuntimeEventStore(database, clock);
  try {
    const version = database.connection.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    assert.equal(Number(version.version), 69);

    events.append({
      streamId: "projection:example:one",
      aggregateType: "projection",
      aggregateId: ["example", "one"],
      eventType: runtimeEventTypes.projectionUpserted,
      eventVersion: 1,
      payload: { table: "example", key: ["one"], value: { id: "one", count: 0 } },
    });
    for (let count = 1; count <= 321; count += 1) {
      events.append({
        streamId: "projection:example:one",
        aggregateType: "projection",
        aggregateId: ["example", "one"],
        eventType: runtimeEventTypes.projectionUpserted,
        eventVersion: 2,
        payload: {
          projection: "example",
          key: ["one"],
          row: { id: "one", count },
          operation: "update",
          schemaHash,
        },
        projectionSchemaHash: schemaHash,
      });
    }

    const migrated = events.replay("projection:example:one", 1);
    assert.deepEqual(migrated && { ...migrated, schemaHash: undefined }, {
      kind: "projection",
      projection: "example",
      key: ["one"],
      row: { count: 0, id: "one" },
      schemaHash: undefined,
    });
    assert.match(migrated?.kind === "projection" ? migrated.schemaHash : "", /^[a-f0-9]{64}$/u);
    assert.deepEqual(events.replay("projection:example:one"), {
      kind: "projection",
      projection: "example",
      key: ["one"],
      row: { count: 321, id: "one" },
      schemaHash,
    });
    const checkpoints = database.connection.prepare(`
      SELECT stream_sequence FROM runtime_event_checkpoints
      WHERE stream_id = ? ORDER BY stream_sequence
    `).all("projection:example:one") as Array<{ stream_sequence: number }>;
    assert.deepEqual(checkpoints.map((entry) => Number(entry.stream_sequence)), [129, 193, 257, 321]);
    assert.equal(Number((database.connection.prepare(`
      SELECT count(*) AS count FROM runtime_events WHERE stream_id = ?
    `).get("projection:example:one") as { count: number }).count), 322);
    const integrity = events.verifyIntegrity();
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.errors, []);
  } finally {
    database.close();
  }
});

test("runtime event hash chains fail closed after durable payload tampering", () => {
  const database = new AppDatabase(":memory:");
  const events = new RuntimeEventStore(database);
  try {
    events.append({
      streamId: "projection:example:tamper",
      aggregateType: "projection",
      aggregateId: ["example", "tamper"],
      eventType: runtimeEventTypes.projectionUpserted,
      eventVersion: 2,
      payload: {
        projection: "example",
        key: ["tamper"],
        row: { id: "tamper", value: "before" },
        operation: "insert",
        schemaHash,
      },
      projectionSchemaHash: schemaHash,
    });
    database.connection.prepare(
      "UPDATE runtime_events SET payload_json = ? WHERE stream_id = ?",
    ).run(JSON.stringify({ projection: "example", key: ["tamper"], row: { value: "after" }, operation: "update", schemaHash }), "projection:example:tamper");

    const integrity = events.verifyIntegrity();
    assert.equal(integrity.ok, false);
    assert.match(integrity.errors.join("\n"), /event hash mismatch/u);
    assert.throws(
      () => events.replay("projection:example:tamper"),
      /checkpoint event mismatch/u,
    );
  } finally {
    database.close();
  }
});

test("projection capture inventories the schema and records insert, update, and delete", () => {
  const database = new AppDatabase(":memory:");
  const events = new RuntimeEventStore(database);
  try {
    const applicationTables = (database.connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as Array<{ name: string }>).map((entry) => entry.name);
    const catalog = database.connection.prepare(`
      SELECT table_name, classification FROM runtime_event_capture_catalog ORDER BY table_name
    `).all() as Array<{ table_name: string; classification: string }>;
    assert.deepEqual(catalog.map((entry) => entry.table_name), applicationTables);
    assert.equal(
      catalog.find((entry) => entry.table_name === "session_goal_transitions")?.classification,
      "native_event",
    );
    assert.equal(
      catalog.find((entry) => entry.table_name === "rp_memories_fts")?.classification,
      "excluded",
    );
    assert.equal(
      catalog.find((entry) => entry.table_name === "characters")?.classification,
      "projection",
    );

    database.connection.prepare(`
      INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run("character:event-capture", "Before", "2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z");
    const streamId = projectionStreamId("characters", ["character:event-capture"]);
    assert.equal(events.replay(streamId)?.kind, "projection");
    assert.equal(
      (events.replay(streamId) as { row: Record<string, unknown> }).row.name,
      "Before",
    );

    database.connection.prepare("UPDATE characters SET name = ? WHERE id = ?")
      .run("After", "character:event-capture");
    assert.equal(
      (events.replay(streamId) as { row: Record<string, unknown> }).row.name,
      "After",
    );

    database.connection.prepare("DELETE FROM characters WHERE id = ?")
      .run("character:event-capture");
    assert.deepEqual(events.replay(streamId), {
      kind: "projection",
      projection: "characters",
      key: ["character:event-capture"],
      row: null,
      schemaHash: (events.replay(streamId) as { schemaHash: string }).schemaHash,
    });
    assert.equal(events.verifyIntegrity().ok, true);
  } finally {
    database.close();
  }
});

test("projection capture bootstraps schema 68 data and reconciles writes made without hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-runtime-events-"));
  const path = join(root, "state.sqlite");
  try {
    const legacy = new AppDatabase(path, { maxMigrationVersion: 68 });
    legacy.connection.prepare(`
      INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run("character:legacy", "Legacy", "2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z");
    legacy.close();

    let current = new AppDatabase(path);
    const streamId = projectionStreamId("characters", ["character:legacy"]);
    let events = new RuntimeEventStore(current);
    assert.equal(
      (events.replay(streamId) as { row: Record<string, unknown> }).row.name,
      "Legacy",
    );
    const initialCount = Number((current.connection.prepare(
      "SELECT count(*) AS count FROM runtime_events",
    ).get() as { count: number }).count);
    current.close();

    current = new AppDatabase(path);
    assert.equal(Number((current.connection.prepare(
      "SELECT count(*) AS count FROM runtime_events",
    ).get() as { count: number }).count), initialCount);
    current.close();

    const uninstrumented = new DatabaseSync(path);
    uninstrumented.prepare("UPDATE characters SET name = ? WHERE id = ?")
      .run("Reconciled", "character:legacy");
    uninstrumented.close();

    current = new AppDatabase(path);
    events = new RuntimeEventStore(current);
    assert.equal(
      (events.replay(streamId) as { row: Record<string, unknown> }).row.name,
      "Reconciled",
    );
    assert.equal(Number((current.connection.prepare(
      "SELECT count(*) AS count FROM runtime_events",
    ).get() as { count: number }).count), initialCount + 1);
    current.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection capture encodes blobs and inherits secret scope through foreign keys", () => {
  const database = new AppDatabase(":memory:");
  try {
    database.connection.exec(`
      CREATE TABLE capture_parent (
        id TEXT PRIMARY KEY,
        conversation_space TEXT NOT NULL,
        secret_owner_character_id TEXT,
        character_id TEXT,
        session_id TEXT
      );
      CREATE TABLE capture_child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES capture_parent(id) ON DELETE CASCADE,
        content BLOB NOT NULL
      );
    `);
    database.connection.prepare(`
      INSERT INTO capture_parent VALUES (?, 'secret', ?, ?, ?)
    `).run("parent", "character:secret", "character:secret", "session:secret");
    database.connection.prepare("INSERT INTO capture_child VALUES (?, ?, ?)")
      .run("child", "parent", Buffer.from([0, 1, 254, 255]));

    initializeRuntimeEventCapture(database.connection);
    const events = new RuntimeEventStore(database);
    const childStream = projectionStreamId("capture_child", ["child"]);
    const state = events.replay(childStream);
    assert.equal(state?.kind, "projection");
    assert.deepEqual(state?.kind === "projection" ? state.row?.content : undefined, {
      $binaryHex: "0001feff",
    });
    const scope = database.connection.prepare(`
      SELECT conversation_space, secret_owner_character_id, character_id, session_id
      FROM runtime_event_streams WHERE stream_id = ?
    `).get(childStream);
    assert.deepEqual({ ...scope }, {
      conversation_space: "secret",
      secret_owner_character_id: "character:secret",
      character_id: "character:secret",
      session_id: "session:secret",
    });
    database.connection.prepare("DELETE FROM capture_parent WHERE id = ?").run("parent");
    const deleted = events.replay(childStream);
    assert.equal(deleted?.kind === "projection" ? deleted.row : undefined, null);
    assert.equal(events.verifyIntegrity().ok, true);
  } finally {
    database.close();
  }
});
