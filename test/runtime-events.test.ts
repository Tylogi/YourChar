import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { RuntimeEventStore, runtimeEventTypes } from "../src/runtime-events/index.js";
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
    assert.deepEqual(events.verifyIntegrity(), {
      ok: true,
      streamCount: 1,
      eventCount: 322,
      checkpointCount: 4,
      errors: [],
    });
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
