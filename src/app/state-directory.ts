import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_STATE_DIRECTORY_NAME = ".yourchar";
export const LEGACY_STATE_DIRECTORY_NAME = ".rp-agent";
export const EPHEMERAL_STATE_DIRECTORY_NAME = ".yourchar-ephemeral";
export const STATE_DIRECTORY_MIGRATION_LOCK_NAME = ".yourchar-state-migration.lock";

export type StateDirectoryEnvironment = Record<string, string | undefined>;

export type ResolveStateDirectoryOptions = {
  stateDir?: string | false;
  environment?: StateDirectoryEnvironment;
  cwd?: string;
};

export type ResolvedStateDirectory = {
  stateDir?: string;
  source: "disabled" | "option" | "yourchar-env" | "legacy-env" | "yourchar-default" | "legacy-default";
  /** True only when the implicit legacy default remains in use. */
  migrationNeeded: boolean;
};

/**
 * Resolve and secure the state root before any database is opened.
 *
 * Resolution is deliberately non-mutating with respect to legacy naming:
 * explicit paths are never migrated, and an implicit legacy directory remains
 * usable until the stopped-service migrator is run. This avoids renaming an
 * online database from a normal Store constructor.
 */
export function resolveStateDirectorySelection(
  options: ResolveStateDirectoryOptions = {},
): ResolvedStateDirectory {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.stateDir !== undefined) {
    if (options.stateDir === false) {
      return { source: "disabled", migrationNeeded: false };
    }
    if (options.stateDir.trim().length === 0) {
      throw new StateDirectoryMigrationError("stateDir is explicitly set but empty");
    }
    const stateDir = resolve(cwd, options.stateDir);
    ensureStateRoot(stateDir, true);
    return { stateDir, source: "option", migrationNeeded: false };
  }

  const environment = options.environment ?? process.env;
  const currentEnvironmentPath = environment.YOURCHAR_STATE_DIR;
  if (currentEnvironmentPath !== undefined) {
    const stateDir = resolveEnvironmentPath(cwd, "YOURCHAR_STATE_DIR", currentEnvironmentPath);
    ensureStateRoot(stateDir, true);
    return { stateDir, source: "yourchar-env", migrationNeeded: false };
  }
  const legacyEnvironmentPath = environment.RP_AGENT_STATE_DIR;
  if (legacyEnvironmentPath !== undefined) {
    const stateDir = resolveEnvironmentPath(cwd, "RP_AGENT_STATE_DIR", legacyEnvironmentPath);
    ensureStateRoot(stateDir, true);
    return { stateDir, source: "legacy-env", migrationNeeded: false };
  }

  return resolveDefaultStateDirectory(cwd);
}

export function resolveStateDirectory(
  options: ResolveStateDirectoryOptions = {},
): string | undefined {
  return resolveStateDirectorySelection(options).stateDir;
}

/**
 * Rename the implicit legacy default after the service has been stopped.
 * The operation is a same-parent atomic rename only: EXDEV is rejected with a
 * manual-migration instruction, so no partially copied state can be published.
 */
export function migrateLegacyDefaultStateDirectory(
  options: { cwd?: string; now?: Date } = {},
): boolean {
  const cwd = resolve(options.cwd ?? process.cwd());
  const source = join(cwd, LEGACY_STATE_DIRECTORY_NAME);
  const target = join(cwd, DEFAULT_STATE_DIRECTORY_NAME);
  const sourceKind = pathKind(source);
  const targetKind = pathKind(target);

  assertValidDefaultPath(source, sourceKind, "Legacy");
  assertValidDefaultPath(target, targetKind, "Current");
  if (sourceKind === "directory" && targetKind === "directory") {
    throw new StateDirectoryMigrationError(
      `Both ${source} and ${target} exist; refusing to merge or overwrite state`,
    );
  }
  if (sourceKind === "missing") return false;
  if (targetKind !== "missing") {
    throw new StateDirectoryMigrationError(`Refusing to overwrite existing state path ${target}`);
  }

  ensureStateRoot(source, false);
  const sourceIdentity = directoryIdentity(source);
  const lockPath = join(cwd, STATE_DIRECTORY_MIGRATION_LOCK_NAME);
  let lockDescriptor: number | undefined;
  let ownsLock = false;
  try {
    lockDescriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    ownsLock = true;
    writeFileSync(lockDescriptor, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      source,
      target,
      sourceIdentity,
    })}\n`, "utf8");
    fsyncSync(lockDescriptor);
    closeSync(lockDescriptor);
    lockDescriptor = undefined;
  } catch (error) {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (ownsLock) rmSync(lockPath, { force: true });
    throw new StateDirectoryMigrationError(
      `Could not acquire exclusive state migration lock ${lockPath}`,
      { cause: error },
    );
  }

  try {
    if (pathKind(target) !== "missing") {
      throw new StateDirectoryMigrationError(
        `State path ${target} appeared while acquiring the migration lock`,
      );
    }
    assertDirectoryIdentity(
      source,
      sourceIdentity,
      "Legacy state directory changed while acquiring the migration lock",
    );
    assertLegacyWriterInactive(join(source, "rp-agent.sqlite"), options.now ?? new Date());
    renameSync(source, target);
    syncDirectory(cwd);
    assertDirectoryIdentity(
      target,
      sourceIdentity,
      "Atomic state migration did not preserve the source directory identity",
    );
  } catch (error) {
    if (error instanceof StateDirectoryMigrationError) throw error;
    if (isNodeError(error) && error.code === "EXDEV") {
      throw new StateDirectoryMigrationError(
        `Cannot atomically migrate ${source} to ${target} across filesystems; keep using the legacy path or perform a stopped, verified manual migration`,
        { cause: error },
      );
    }
    throw new StateDirectoryMigrationError(
      `Could not atomically migrate ${source} to ${target}`,
      { cause: error },
    );
  } finally {
    rmSync(lockPath, { force: true });
    syncDirectory(cwd);
  }
  ensureStateRoot(target, false);
  return true;
}

export class StateDirectoryMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateDirectoryMigrationError";
  }
}

function resolveDefaultStateDirectory(cwd: string): ResolvedStateDirectory {
  const current = join(cwd, DEFAULT_STATE_DIRECTORY_NAME);
  const legacy = join(cwd, LEGACY_STATE_DIRECTORY_NAME);

  // Retry once if another process creates the new default between inspection
  // and mkdir. No rename occurs on this normal startup path.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentKind = pathKind(current);
    const legacyKind = pathKind(legacy);
    assertValidDefaultPath(current, currentKind, "Current");
    assertValidDefaultPath(legacy, legacyKind, "Legacy");
    if (currentKind === "directory" && legacyKind === "directory") {
      throw new StateDirectoryMigrationError(
        `Both ${legacy} and ${current} exist; refusing to choose or merge state`,
      );
    }
    if (currentKind === "directory") {
      ensureStateRoot(current, false);
      assertOtherDefaultStillMissing(legacy, current, "legacy");
      return { stateDir: current, source: "yourchar-default", migrationNeeded: false };
    }
    if (legacyKind === "directory") {
      ensureStateRoot(legacy, false);
      assertOtherDefaultStillMissing(current, legacy, "current");
      return { stateDir: legacy, source: "legacy-default", migrationNeeded: true };
    }

    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (attempt === 0 && isNodeError(error) && error.code === "EEXIST") continue;
      throw new StateDirectoryMigrationError(`Could not create state directory ${current}`, {
        cause: error,
      });
    }
    ensureStateRoot(current, false);
    assertOtherDefaultStillMissing(legacy, current, "legacy");
    return { stateDir: current, source: "yourchar-default", migrationNeeded: false };
  }
  throw new StateDirectoryMigrationError("State directory changed repeatedly during resolution");
}

function assertOtherDefaultStillMissing(
  other: string,
  selected: string,
  label: string,
): void {
  const kind = pathKind(other);
  assertValidDefaultPath(other, kind, label === "legacy" ? "Legacy" : "Current");
  if (kind === "directory") {
    throw new StateDirectoryMigrationError(
      `Both ${other} and ${selected} exist; refusing to choose or merge state`,
    );
  }
}

function resolveEnvironmentPath(cwd: string, name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new StateDirectoryMigrationError(`${name} is set but empty`);
  }
  return resolve(cwd, value);
}

function ensureStateRoot(path: string, createIfMissing: boolean): void {
  if (parse(path).root === path) {
    throw new StateDirectoryMigrationError("The filesystem root cannot be used as the state directory");
  }
  if (createIfMissing && pathKind(path) === "missing") {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new StateDirectoryMigrationError(
      `State path ${path} must be an existing real directory`,
      { cause: error },
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) {
      throw new StateDirectoryMigrationError(`State path ${path} is not a directory`);
    }
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid !== undefined && stat.uid !== expectedUid) {
      throw new StateDirectoryMigrationError(
        `State directory ${path} is owned by uid ${stat.uid}, expected ${expectedUid}`,
      );
    }
    fchmodSync(descriptor, 0o700);
    const secured = fstatSync(descriptor);
    if ((secured.mode & 0o777) !== 0o700) {
      throw new StateDirectoryMigrationError(`State directory ${path} could not be secured to mode 0700`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertLegacyWriterInactive(databasePath: string, now: Date): void {
  if (!Number.isFinite(now.getTime())) {
    throw new StateDirectoryMigrationError("Writer-lease check requires a valid current time");
  }
  const kind = pathKind(databasePath, true);
  if (kind === "missing") return;
  if (kind !== "file") {
    throw new StateDirectoryMigrationError(
      `Legacy database path ${databasePath} is not a regular file`,
    );
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const table = database.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'memory_vault_writer_lease'
    `).get() as { present?: number } | undefined;
    if (!table?.present) return;
    const lease = database.prepare(`
      SELECT owner_id, expires_at
      FROM memory_vault_writer_lease
      WHERE singleton = 1
    `).get() as { owner_id?: string | null; expires_at?: string | null } | undefined;
    if (!lease) {
      throw new StateDirectoryMigrationError(
        "Legacy writer-lease table has no singleton row; refusing migration",
      );
    }
    if (lease.owner_id === null || lease.owner_id === undefined) return;
    const expiresAt = lease.expires_at ? Date.parse(lease.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAt)) {
      throw new StateDirectoryMigrationError(
        "Legacy writer lease has an owner but no valid expiration; refusing migration",
      );
    }
    if (expiresAt > now.getTime()) {
      throw new StateDirectoryMigrationError(
        `Legacy state has an active writer lease until ${lease.expires_at}; stop YourChar and wait for the lease to expire before migrating`,
      );
    }
  } catch (error) {
    if (error instanceof StateDirectoryMigrationError) throw error;
    throw new StateDirectoryMigrationError(
      `Could not verify the legacy database writer lease at ${databasePath}`,
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

type DirectoryIdentity = { device: string; inode: string };

function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StateDirectoryMigrationError(`State path ${path} is not a real directory`);
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  message: string,
): void {
  if (pathKind(path) !== "directory") throw new StateDirectoryMigrationError(message);
  const actual = directoryIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new StateDirectoryMigrationError(message);
  }
}

function assertValidDefaultPath(
  path: string,
  kind: ReturnType<typeof pathKind>,
  label: string,
): void {
  if (kind === "invalid" || kind === "file") {
    throw new StateDirectoryMigrationError(
      `${label} state path ${path} exists but is not a real directory`,
    );
  }
}

function pathKind(
  path: string,
  allowRegularFile = false,
): "missing" | "directory" | "file" | "invalid" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "invalid";
    if (stat.isDirectory()) return "directory";
    if (allowRegularFile && stat.isFile()) return "file";
    return "invalid";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!(isNodeError(error) && ["EINVAL", "ENOTSUP", "EBADF"].includes(error.code ?? ""))) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
