import { randomUUID } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertWriterInactive, validateBackupDirectory } from "./backup-contract.mjs";
import { resolveStateDirectory } from "./state-directory.mjs";

const RESTORE_IM_QUARANTINE_REASON = "restored backup: pending IM delivery quarantined";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreState(process.argv.slice(2));
}

function restoreState(arguments_) {
  const positional = arguments_.filter((argument) => !argument.startsWith("--"));
  const backupDir = resolve(positional[0] ?? "");
  const stateDir = resolveStateDirectory({ explicit: positional[1] });
  const force = arguments_.includes("--force");
  const verifyOnly = arguments_.includes("--verify");
  const dryRun = arguments_.includes("--dry-run");
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
    return;
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

    publishRestoredState({ staging, stateDir, previous, parent });
    console.log(stateDir);
  } finally {
    removeBestEffort(staging, "restore staging directory");
  }
}

export function publishRestoredState(
  { staging, stateDir, previous, parent = dirname(stateDir) },
  overrides = {},
) {
  const operations = {
    exists: existsSync,
    rename: renameSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    fsyncDirectory,
    warn: (message) => console.error(message),
    ...overrides,
  };
  let movedPrevious = false;
  let published = false;

  try {
    if (operations.exists(stateDir)) {
      operations.rename(stateDir, previous);
      movedPrevious = true;
      operations.fsyncDirectory(parent);
    }
    operations.rename(staging, stateDir);
    published = true;
    operations.fsyncDirectory(parent);
  } catch (error) {
    const rollbackErrors = [];
    let rollbackChangedParent = false;

    if (published && operations.exists(stateDir)) {
      try {
        if (operations.exists(staging)) {
          throw new Error(`cannot quarantine failed restored state because path exists: ${staging}`);
        }
        operations.rename(stateDir, staging);
        rollbackChangedParent = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (movedPrevious && operations.exists(previous)) {
      if (operations.exists(stateDir)) {
        rollbackErrors.push(new Error(
          `cannot restore previous state while failed restored state remains at: ${stateDir}`,
        ));
      } else {
        try {
          operations.rename(previous, stateDir);
          rollbackChangedParent = true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }

    if (rollbackChangedParent) {
      try {
        operations.fsyncDirectory(parent);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (published && operations.exists(staging)) {
      try {
        operations.remove(staging);
      } catch (cleanupError) {
        operations.warn(
          `warning: failed restored state remains quarantined at ${staging}: ${errorMessage(cleanupError)}`,
        );
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `restore publication failed and rollback was incomplete: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }

  // Publication is committed after its parent directory has been synced. Removing the
  // previous tree is cleanup, not part of the transaction: a partial rm cannot be rolled back.
  if (movedPrevious) {
    try {
      operations.remove(previous);
    } catch (cleanupError) {
      operations.warn(
        `warning: restored state is active; previous state cleanup remains at ${previous}: ${errorMessage(cleanupError)}`,
      );
    }
  }
}

function removeBestEffort(path, label) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.error(`warning: failed to remove ${label} at ${path}: ${errorMessage(error)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
