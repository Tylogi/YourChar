import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import {
  defaultSubagentSettings,
  maximumSubagentSettings,
  minimumSubagentSettings,
  SubagentSettingsConflictError,
  SubagentSettingsService,
  SubagentSettingsValidationError,
} from "../src/modules/subagent-settings.js";
import { AppDatabase } from "../src/storage/database.js";

test("Subagent settings default to the wider bounded profile and persist across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-subagent-settings-"));
  const databasePath = join(root, "rp-agent.sqlite");
  const clock = new VirtualClock("2026-08-27T10:00:00.000Z");
  let database: AppDatabase | undefined;
  try {
    database = new AppDatabase(databasePath);
    let service = new SubagentSettingsService(database, clock);
    const initial = service.get();
    assert.deepEqual(settingsValues(initial), defaultSubagentSettings);
    assert.equal(initial.revision, 0);

    const maximum = service.patch({ ...maximumSubagentSettings }, initial.revision);
    assert.deepEqual(settingsValues(maximum), maximumSubagentSettings);
    assert.equal(maximum.revision, 1);
    assert.equal(maximum.updatedAt, "2026-08-27T10:00:00.000Z");
    assert.deepEqual(service.snapshot(), maximumSubagentSettings);
    assert.equal(Object.isFrozen(service.snapshot()), true);

    database.close();
    database = undefined;
    database = new AppDatabase(databasePath);
    service = new SubagentSettingsService(database, clock);
    const restarted = service.get();
    assert.deepEqual(settingsValues(restarted), maximumSubagentSettings);
    assert.equal(restarted.revision, 1);
    assert.equal(restarted.updatedAt, maximum.updatedAt);
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 48 adds default Subagent settings to an existing schema 47 database", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-subagent-settings-migration-"));
  const databasePath = join(root, "rp-agent.sqlite");
  let database: AppDatabase | undefined;
  try {
    database = new AppDatabase(databasePath, { maxMigrationVersion: 47 });
    const before = database.connection.prepare("PRAGMA user_version").get();
    assert.ok(before);
    assert.throws(
      () => database?.connection.prepare("SELECT * FROM subagent_runtime_settings").get(),
      /no such table/u,
    );
    database.close();
    database = undefined;

    database = new AppDatabase(databasePath);
    const service = new SubagentSettingsService(
      database,
      new VirtualClock("2026-08-27T10:30:00.000Z"),
    );
    assert.deepEqual(settingsValues(service.get()), defaultSubagentSettings);
    const schema = database.connection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version?: number } | undefined;
    assert.equal(Number(schema?.version), 69);
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Subagent settings use atomic CAS patches and reject invalid values without partial writes", () => {
  const database = new AppDatabase(":memory:");
  const clock = new VirtualClock("2026-08-27T11:00:00.000Z");
  const service = new SubagentSettingsService(database, clock);
  try {
    const first = service.patch({ maxWorkModelCalls: 48, timeoutSeconds: 2_400 }, 0);
    assert.equal(first.revision, 1);
    assert.equal(first.maxWorkModelCalls, 48);
    assert.equal(first.timeoutSeconds, 2_400);

    assert.throws(
      () => service.patch({ maxOutputTokens: 32_768 }, 0),
      (error: unknown) => {
        assert.ok(error instanceof SubagentSettingsConflictError);
        assert.equal(error.code, "SUBAGENT_SETTINGS_CONFLICT");
        assert.equal(error.expectedRevision, 0);
        assert.equal(error.actualRevision, 1);
        return true;
      },
    );
    assert.deepEqual(service.get(), first);

    assert.deepEqual(minimumSubagentSettings, {
      maxConcurrentTasks: 1,
      maxWorkModelCalls: 1,
      maxOutputTokens: 512,
      maxResultCharacters: 1_000,
      timeoutSeconds: 60,
    });

    for (const [field, value] of [
      ["maxConcurrentTasks", minimumSubagentSettings.maxConcurrentTasks - 1],
      ["maxConcurrentTasks", maximumSubagentSettings.maxConcurrentTasks + 1],
      ["maxWorkModelCalls", 1.5],
      ["maxWorkModelCalls", minimumSubagentSettings.maxWorkModelCalls - 1],
      ["maxWorkModelCalls", maximumSubagentSettings.maxWorkModelCalls + 1],
      ["maxOutputTokens", Number.NaN],
      ["maxOutputTokens", minimumSubagentSettings.maxOutputTokens - 1],
      ["maxOutputTokens", maximumSubagentSettings.maxOutputTokens + 1],
      ["maxResultCharacters", Number.POSITIVE_INFINITY],
      ["maxResultCharacters", minimumSubagentSettings.maxResultCharacters - 1],
      ["maxResultCharacters", maximumSubagentSettings.maxResultCharacters + 1],
      ["timeoutSeconds", -1],
      ["timeoutSeconds", minimumSubagentSettings.timeoutSeconds - 1],
      ["timeoutSeconds", maximumSubagentSettings.timeoutSeconds + 1],
    ] as const) {
      assert.throws(
        () => service.patch({ maxOutputTokens: 24_576, [field]: value }, 1),
        (error: unknown) => {
          assert.ok(error instanceof SubagentSettingsValidationError);
          assert.equal(error.code, "SUBAGENT_SETTINGS_INVALID");
          return true;
        },
        `${field}=${String(value)}`,
      );
      assert.deepEqual(service.get(), first, `${field} must not partially update valid sibling fields`);
    }

    assert.throws(
      () => service.patch({ unknownBudget: 1 } as never, 1),
      SubagentSettingsValidationError,
    );
    for (const expectedRevision of [-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => service.patch({}, expectedRevision),
        SubagentSettingsValidationError,
      );
    }

    const unchanged = service.patch({}, 1);
    assert.deepEqual(unchanged, first);
    assert.equal(unchanged.revision, 1);

    const runningTaskSnapshot = service.snapshot();
    const minimum = service.patch({ ...minimumSubagentSettings }, 1);
    assert.deepEqual(settingsValues(minimum), minimumSubagentSettings);
    assert.equal(minimum.revision, 2);
    assert.equal(runningTaskSnapshot.maxWorkModelCalls, 48);
    assert.equal(runningTaskSnapshot.timeoutSeconds, 2_400);
    assert.equal(Object.isFrozen(runningTaskSnapshot), true);
  } finally {
    database.close();
  }
});

function settingsValues(input: {
  maxConcurrentTasks: number;
  maxWorkModelCalls: number;
  maxOutputTokens: number;
  maxResultCharacters: number;
  timeoutSeconds: number;
}) {
  return {
    maxConcurrentTasks: input.maxConcurrentTasks,
    maxWorkModelCalls: input.maxWorkModelCalls,
    maxOutputTokens: input.maxOutputTokens,
    maxResultCharacters: input.maxResultCharacters,
    timeoutSeconds: input.timeoutSeconds,
  };
}
