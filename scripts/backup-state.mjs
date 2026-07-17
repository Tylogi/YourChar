import { randomUUID } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  BACKUP_SCHEMA_VERSION, assertWriterInactive, payloadFiles, sha256,
  validateBackupDirectory, validateDatabase, validateVault,
} from "./backup-contract.mjs";

const stateDir = resolve(process.argv[2] ?? process.env.RP_AGENT_STATE_DIR ?? ".rp-agent");
const destination = resolve(process.argv[3] ?? join("backups", `rp-agent-${safeTimestamp()}`));
const staging = `${destination}.preparing-${randomUUID()}`;
if (!existsSync(stateDir)) throw new Error(`state directory not found: ${stateDir}`);
if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
assertWriterInactive(stateDir);

try {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const name of [
    "conversations.json", "pi-sessions", "pi-agent", "model-api.json", "tavily.json", "vision.json",
    "user-profile.md", "characters", "memory-vault", "memory-vault-state.json",
    "memory-vault-migration.json", "memory-vault-journal", "memory-vault-recovery.json", "workspace",
    "avatars", "system-prompts",
  ]) {
    const source = join(stateDir, name);
    if (existsSync(source)) cpSync(source, join(staging, name), { recursive: true });
  }
  const databasePath = join(stateDir, "rp-agent.sqlite");
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(database, join(staging, "rp-agent.sqlite"));
    } finally {
      database.close();
    }
  }
  assertWriterInactive(stateDir);
  const database = validateDatabase(join(staging, "rp-agent.sqlite"));
  const vault = validateVault(staging, database);
  const createdAt = new Date().toISOString();
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    sourceDirectoryName: basename(stateDir),
    files: payloadFiles(staging),
    database,
    vault,
    consistency: {
      sqliteIntegrity: database.integrityCheck,
      vaultProjectionState: vault.projectionConsistent,
      sqliteVaultProjection: vault.sqliteVaultProjection,
    },
    credentials: {
      modelConfigPresent: existsSync(join(staging, "model-api.json")),
      tavilyConfigPresent: existsSync(join(staging, "tavily.json")),
      visionConfigPresent: existsSync(join(staging, "vision.json")),
    },
    containsModelCredentials: existsSync(join(staging, "model-api.json")),
    containsTavilyCredentials: existsSync(join(staging, "tavily.json")),
    containsVisionCredentials: existsSync(join(staging, "vision.json")),
    containsMemoryVault: vault.present,
  };
  writeFileSync(join(staging, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  validateBackupDirectory(staging, manifest);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(staging, destination);
  fsyncDirectory(dirname(destination));
  writeBackupStatus(stateDir, { schemaVersion: 1, generatedAt: createdAt, verifiedAt: new Date().toISOString(), valid: true, manifestHash: sha256(JSON.stringify(manifest)) });
  console.log(destination);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function writeBackupStatus(stateDir, value) {
  const target = join(stateDir, "memory-vault-backup-status.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const descriptor = openSync(temporary, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, target);
  fsyncDirectory(stateDir);
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
