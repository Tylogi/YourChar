import { constants } from "node:fs";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWriterInactive } from "./backup-contract.mjs";

const legacyName = ".rp-agent";
const currentName = ".yourchar";
const lockName = ".yourchar-state-migration.lock";

export function preflightStateDirectoryMigration(parentDirectory = process.cwd()) {
  const parent = resolve(parentDirectory);
  validateOwnedDirectory(parent, "state-directory parent");
  const legacy = join(parent, legacyName);
  const current = join(parent, currentName);
  const legacyStatus = stateDirectoryStatus(legacy, "legacy state directory");
  const currentStatus = stateDirectoryStatus(current, "current state directory");
  if (legacyStatus && currentStatus) {
    throw new Error("both .yourchar and legacy .rp-agent exist; migration is ambiguous");
  }
  return {
    action: legacyStatus ? "migrate" : currentStatus ? "ready" : "create",
    parent,
    legacy,
    current,
  };
}

export function migrateStateDirectory(parentDirectory = process.cwd()) {
  const initial = preflightStateDirectoryMigration(parentDirectory);
  if (initial.action !== "migrate") {
    throw new Error(`state migration requires only ${legacyName} to exist; found ${initial.action}`);
  }
  const lockPath = join(initial.parent, lockName);
  let lockDescriptor;
  try {
    lockDescriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(
      lockDescriptor,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    fsyncSync(lockDescriptor);

    const locked = preflightStateDirectoryMigration(initial.parent);
    if (locked.action !== "migrate") throw new Error("state directories changed during migration");
    const before = lstatSync(locked.legacy);
    assertWriterInactive(locked.legacy);
    verifySameDirectory(locked.legacy, before, "legacy state directory changed before rename");
    if (stateDirectoryStatus(locked.current, "current state directory")) {
      throw new Error("current state directory appeared during migration");
    }

    renameSync(locked.legacy, locked.current);
    secureRenamedDirectory(locked.current, before);
    fsyncDirectory(locked.parent);
    return locked.current;
  } finally {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      rmSync(lockPath, { force: true });
      fsyncDirectory(initial.parent);
    }
  }
}

function stateDirectoryStatus(path, label) {
  try {
    return validateOwnedDirectory(path, label);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateOwnedDirectory(path, label) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && status.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  return status;
}

function verifySameDirectory(path, expected, message) {
  const actual = validateOwnedDirectory(path, "state directory");
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(message);
}

function secureRenamedDirectory(path, expected) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    if (before.dev !== expected.dev || before.ino !== expected.ino) {
      throw new Error("renamed state directory identity changed");
    }
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
    const secured = fstatSync(descriptor);
    if (
      secured.dev !== expected.dev || secured.ino !== expected.ino ||
      (secured.mode & 0o777) !== 0o700
    ) {
      throw new Error("renamed state directory could not be secured to mode 0700");
    }
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function run(arguments_) {
  const [command, parentDirectory] = arguments_;
  if (command === "preflight") {
    console.log(preflightStateDirectoryMigration(parentDirectory).action);
    return;
  }
  if (command === "migrate") {
    console.log(migrateStateDirectory(parentDirectory));
    return;
  }
  throw new Error("usage: migrate-state-directory.mjs preflight|migrate [parent-directory]");
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) run(process.argv.slice(2));
