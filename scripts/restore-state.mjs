import { randomUUID } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertWriterInactive, validateBackupDirectory } from "./backup-contract.mjs";

const RESTORE_IM_QUARANTINE_REASON = "restored backup: pending IM delivery quarantined";

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const backupDir = resolve(positional[0] ?? "");
const stateDir = resolve(positional[1] ?? process.env.RP_AGENT_STATE_DIR ?? ".rp-agent");
const force = process.argv.includes("--force");
const verifyOnly = process.argv.includes("--verify");
const dryRun = process.argv.includes("--dry-run");
const manifestPath = join(backupDir, "backup-manifest.json");
if (!positional[0] || !existsSync(manifestPath)) throw new Error("a valid backup directory is required");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const validation = validateBackupDirectory(backupDir, manifest);
if (verifyOnly || dryRun) {
  console.log(JSON.stringify({
    valid: true,
    operation: verifyOnly ? "verify" : "dry-run",
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    databaseSchemaVersion: validation.database.schemaVersion,
    vaultDocumentCount: validation.vault.documentCount,
    projectionConsistent: validation.vault.projectionConsistent,
  }));
  process.exit(0);
}

if (existsSync(stateDir)) {
  assertWriterInactive(stateDir);
  if (!force) throw new Error(`state directory exists: ${stateDir}; stop YourChar and pass --force to replace it`);
}

const parent = dirname(stateDir);
const staging = join(parent, `.${randomUUID()}.restore-staging`);
const previous = join(parent, `.${randomUUID()}.restore-previous`);
mkdirSync(parent, { recursive: true, mode: 0o700 });
try {
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  for (const file of manifest.files) {
    const source = join(backupDir, file.path);
    const target = join(staging, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target);
  }
  cpSync(manifestPath, join(staging, "backup-manifest.json"));
  validateBackupDirectory(staging, manifest);
  quarantineRestoredImDelivery(staging);

  let movedPrevious = false;
  try {
    if (existsSync(stateDir)) {
      renameSync(stateDir, previous);
      movedPrevious = true;
      fsyncDirectory(parent);
    }
    renameSync(staging, stateDir);
    fsyncDirectory(parent);
    if (movedPrevious) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(stateDir) && movedPrevious && existsSync(previous)) {
      renameSync(previous, stateDir);
      fsyncDirectory(parent);
    }
    throw error;
  }
  console.log(stateDir);
} finally {
  rmSync(staging, { recursive: true, force: true });
  if (existsSync(previous) && existsSync(stateDir)) rmSync(previous, { recursive: true, force: true });
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function quarantineRestoredImDelivery(stagingDir) {
  const databasePath = join(stagingDir, "rp-agent.sqlite");
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath);
    try {
      const outboxTable = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'im_outbox'",
      ).get();
      if (outboxTable) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare(`
            UPDATE im_outbox
            SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
                last_error = ?, updated_at = ?
            WHERE status IN ('pending', 'failed')
          `).run(RESTORE_IM_QUARANTINE_REASON, new Date().toISOString());
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    } finally {
      database.close();
    }
  }
  rmSync(join(stagingDir, "im-runtime", "spool.json"), { force: true });
}
