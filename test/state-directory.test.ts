import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  migrateLegacyDefaultStateDirectory,
  resolveStateDirectorySelection,
  StateDirectoryMigrationError,
} from "../src/app/state-directory.js";
import { CompanionKernel } from "../src/domain/kernel.js";

test("state directory resolution honors option and environment priority and secures roots", () => {
  withTemporaryRoot((root) => {
    const option = resolveStateDirectorySelection({
      cwd: root,
      stateDir: "option-state",
      environment: {
        YOURCHAR_STATE_DIR: "yourchar-env",
        RP_AGENT_STATE_DIR: "legacy-env",
      },
    });
    assert.equal(option.stateDir, join(root, "option-state"));
    assert.equal(option.source, "option");
    assert.equal(option.migrationNeeded, false);
    assertMode700(option.stateDir!);

    const currentEnvironment = resolveStateDirectorySelection({
      cwd: root,
      environment: {
        YOURCHAR_STATE_DIR: "yourchar-env",
        RP_AGENT_STATE_DIR: "legacy-env",
      },
    });
    assert.equal(currentEnvironment.stateDir, join(root, "yourchar-env"));
    assert.equal(currentEnvironment.source, "yourchar-env");
    assertMode700(currentEnvironment.stateDir!);

    const legacyEnvironment = resolveStateDirectorySelection({
      cwd: root,
      environment: { RP_AGENT_STATE_DIR: "legacy-env" },
    });
    assert.equal(legacyEnvironment.stateDir, join(root, "legacy-env"));
    assert.equal(legacyEnvironment.source, "legacy-env");
    assert.equal(legacyEnvironment.migrationNeeded, false);
    assertMode700(legacyEnvironment.stateDir!);

    const disabled = resolveStateDirectorySelection({
      cwd: root,
      stateDir: false,
      environment: { YOURCHAR_STATE_DIR: "ignored" },
    });
    assert.deepEqual(disabled, { source: "disabled", migrationNeeded: false });
    assert.equal(existsSync(join(root, "ignored")), false);
  });
});

test("blank explicit paths are rejected before cwd permissions can be changed", () => {
  withTemporaryRoot((root) => {
    chmodSync(root, 0o755);
    assert.throws(
      () => resolveStateDirectorySelection({ cwd: root, stateDir: "   " }),
      (error) => error instanceof StateDirectoryMigrationError && /empty/u.test(error.message),
    );
    assert.equal(lstatSync(root).mode & 0o777, 0o755);

    assert.throws(
      () => resolveStateDirectorySelection({
        cwd: root,
        environment: { YOURCHAR_STATE_DIR: "\t" },
      }),
      (error) => error instanceof StateDirectoryMigrationError && /empty/u.test(error.message),
    );
    assert.equal(lstatSync(root).mode & 0o777, 0o755);
  });
});

test("fresh defaults create .yourchar with mode 0700", () => {
  withTemporaryRoot((root) => {
    const selection = resolveStateDirectorySelection({ cwd: root, environment: {} });
    assert.equal(selection.stateDir, join(root, ".yourchar"));
    assert.equal(selection.source, "yourchar-default");
    assert.equal(selection.migrationNeeded, false);
    assert.equal(existsSync(join(root, ".rp-agent")), false);
    assertMode700(selection.stateDir!);
  });
});

test("legacy-only defaults stay in place and report migrationNeeded", () => {
  withTemporaryRoot((root) => {
    const legacy = join(root, ".rp-agent");
    mkdirSync(legacy, { mode: 0o755 });
    writeFileSync(join(legacy, "sentinel.txt"), "legacy-state", "utf8");

    const selection = resolveStateDirectorySelection({ cwd: root, environment: {} });
    assert.equal(selection.stateDir, legacy);
    assert.equal(selection.source, "legacy-default");
    assert.equal(selection.migrationNeeded, true);
    assert.equal(existsSync(join(root, ".yourchar")), false);
    assert.equal(readFileSync(join(legacy, "sentinel.txt"), "utf8"), "legacy-state");
    assertMode700(legacy);
  });
});

test("ambiguous or symlinked default state fails closed", () => {
  withTemporaryRoot((root) => {
    mkdirSync(join(root, ".rp-agent"), { mode: 0o700 });
    mkdirSync(join(root, ".yourchar"), { mode: 0o700 });
    assert.throws(
      () => resolveStateDirectorySelection({ cwd: root, environment: {} }),
      (error) => error instanceof StateDirectoryMigrationError && /Both/u.test(error.message),
    );
  });

  withTemporaryRoot((root) => {
    const external = join(root, "external");
    mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, join(root, ".rp-agent"));
    assert.throws(
      () => resolveStateDirectorySelection({ cwd: root, environment: {} }),
      (error) => error instanceof StateDirectoryMigrationError && /not a real directory/u.test(error.message),
    );
    assert.equal(existsSync(join(root, ".yourchar")), false);
  });
});

test("stopped migrator rejects an active writer lease and atomically preserves directory identity", () => {
  withTemporaryRoot((root) => {
    const legacy = join(root, ".rp-agent");
    const current = join(root, ".yourchar");
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "sentinel.txt"), "durable", "utf8");
    const sourceIdentity = identity(legacy);
    const databasePath = join(legacy, "rp-agent.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE memory_vault_writer_lease (
        singleton INTEGER PRIMARY KEY,
        owner_id TEXT,
        expires_at TEXT
      );
      INSERT INTO memory_vault_writer_lease(singleton, owner_id, expires_at)
      VALUES (1, 'live-writer', '2030-01-01T00:00:00.000Z');
    `);
    database.close();

    assert.throws(
      () => migrateLegacyDefaultStateDirectory({
        cwd: root,
        now: new Date("2029-01-01T00:00:00.000Z"),
      }),
      (error) => error instanceof StateDirectoryMigrationError && /active writer lease/u.test(error.message),
    );
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(current), false);
    assert.equal(existsSync(join(root, ".yourchar-state-migration.lock")), false);

    const expired = new DatabaseSync(databasePath);
    expired.prepare(
      "UPDATE memory_vault_writer_lease SET expires_at = ? WHERE singleton = 1",
    ).run("2020-01-01T00:00:00.000Z");
    expired.close();

    assert.equal(migrateLegacyDefaultStateDirectory({
      cwd: root,
      now: new Date("2029-01-01T00:00:00.000Z"),
    }), true);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(join(current, "sentinel.txt"), "utf8"), "durable");
    assert.deepEqual(identity(current), sourceIdentity);
    assertMode700(current);
    assert.equal(migrateLegacyDefaultStateDirectory({ cwd: root }), false);
  });
});

test("stopped migrator lock rejects concurrent migration without changing either path", () => {
  withTemporaryRoot((root) => {
    const legacy = join(root, ".rp-agent");
    const lock = join(root, ".yourchar-state-migration.lock");
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "sentinel.txt"), "unchanged", "utf8");
    writeFileSync(lock, "already-owned", { mode: 0o600 });

    assert.throws(
      () => migrateLegacyDefaultStateDirectory({ cwd: root }),
      (error) => error instanceof StateDirectoryMigrationError && /exclusive/u.test(error.message),
    );
    assert.equal(readFileSync(join(legacy, "sentinel.txt"), "utf8"), "unchanged");
    assert.equal(existsSync(join(root, ".yourchar")), false);
    assert.equal(readFileSync(lock, "utf8"), "already-owned");
  });
});

test("Kernel derives database and Workspace paths from an explicit secured state root", () => {
  withTemporaryRoot((root) => {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o755 });
    const kernel = new CompanionKernel({
      stateDir,
      imGateway: false,
      startScheduler: false,
    });
    try {
      assert.equal(kernel.store.stateDir, stateDir);
      assert.equal(kernel.store.stateDirectorySource, "option");
      assert.equal(kernel.store.stateDirectoryMigrationNeeded, false);
      assertMode700(stateDir);
      assert.equal(existsSync(join(stateDir, "rp-agent.sqlite")), true);
      assert.equal(existsSync(join(stateDir, "workspace")), true);
    } finally {
      kernel.dispose();
    }
  });
});

function withTemporaryRoot(operation: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "yourchar-state-directory-"));
  try {
    operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertMode700(path: string): void {
  assert.equal(lstatSync(path).mode & 0o777, 0o700);
}

function identity(path: string): { device: string; inode: string } {
  const stat = lstatSync(path);
  return { device: String(stat.dev), inode: String(stat.ino) };
}
