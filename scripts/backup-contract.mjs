import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseDocument } from "yaml";

export const BACKUP_SCHEMA_VERSION = 3;
export const MAX_DATABASE_SCHEMA_VERSION = 39;
const V1_FRONTMATTER_KEYS = [
  "schemaVersion", "id", "kind", "realm", "scope", "type", "characterId", "sessionId",
  "validity", "confirmed", "sourceSessionId", "sourceMessageId", "createdAt", "updatedAt",
  "lastUsedAt", "revision", "supersedes", "tags", "quarantineReasons", "contentHash",
  "memoryKey", "salience", "confidence", "idempotencyKey", "scene",
].sort();
const V2_FRONTMATTER_KEYS = [
  "schemaVersion", "id", "kind", "realm", "scope", "type", "characterId", "sessionId",
  "validity", "confirmed", "confirmationProvenance", "rejectedAt", "archivedAt", "deletedAt",
  "statusReason", "sourceSessionId", "sourceMessageId", "createdAt", "updatedAt", "lastUsedAt",
  "revision", "supersedes", "tags", "quarantineReasons", "contentHash", "memoryKey", "salience",
  "confidence", "idempotencyKey", "scene",
].sort();
const V3_FRONTMATTER_KEYS = [
  ...V2_FRONTMATTER_KEYS,
  "personKey", "displayName", "aliases", "relationship", "visibility",
  "visibleToCharacterIds", "sourceMemoryIds", "personConfidence",
].sort();
const V4_FRONTMATTER_KEYS = [
  ...V3_FRONTMATTER_KEYS,
  "conversationSpace", "secretOwnerCharacterId",
].sort();

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function payloadFiles(root) {
  const files = [];
  visit(root, (path) => {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath === "backup-manifest.json") return;
    const source = readFileSync(path);
    files.push({ path: relativePath, sha256: sha256(source), size: source.byteLength });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertWriterInactive(stateDir, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("writer-lease check requires a valid current time");
  }
  const databasePath = join(stateDir, "rp-agent.sqlite");
  let databaseStatus;
  try {
    databaseStatus = lstatSync(databasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (databaseStatus.isSymbolicLink() || !databaseStatus.isFile()) {
    throw new Error(`state database must be a regular non-symlink file: ${databasePath}`);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_vault_writer_lease'",
    ).get();
    if (!table) return;
    const row = database.prepare(
      "SELECT owner_id, expires_at FROM memory_vault_writer_lease WHERE singleton = 1",
    ).get();
    if (!row) {
      throw new Error("Memory Vault writer-lease table has no singleton row; refusing maintenance");
    }
    if (!row.owner_id) return;
    const expiresAt = typeof row.expires_at === "string"
      ? Date.parse(row.expires_at)
      : Number.NaN;
    if (!Number.isFinite(expiresAt)) {
      throw new Error("Memory Vault writer lease has an owner but no valid expiration");
    }
    if (expiresAt > now.getTime()) {
      throw new Error("YourChar is holding the Memory Vault writer lease; stop it before backup or restore");
    }
  } finally {
    database.close();
  }
}

export function validateBackupDirectory(root, manifest) {
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`unsupported backup schema: ${String(manifest.schemaVersion)}`);
  }
  const actualFiles = payloadFiles(root);
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
    throw new Error("backup payload hash/size manifest mismatch");
  }
  if (
    manifest.containsSecretWorkspace !== undefined &&
    Boolean(manifest.containsSecretWorkspace) !==
      actualFiles.some((file) => file.path.startsWith("workspace-secret/"))
  ) {
    throw new Error("backup secret Workspace metadata does not match payload");
  }
  if (
    manifest.containsInstalledSkills !== undefined &&
    Boolean(manifest.containsInstalledSkills) !==
      actualFiles.some((file) => file.path.startsWith("skills/"))
  ) {
    throw new Error("backup installed Skill metadata does not match payload");
  }
  const imRuntimePresent = actualFiles.some((file) => file.path.startsWith("im-runtime/"));
  const imCredentialsPresent = existsSync(join(root, "im-runtime", "credentials.json"));
  if (
    manifest.containsImRuntime !== undefined &&
    Boolean(manifest.containsImRuntime) !== imRuntimePresent
  ) {
    throw new Error("backup IM runtime metadata does not match payload");
  }
  if (
    manifest.containsImCredentials !== undefined &&
    Boolean(manifest.containsImCredentials) !== imCredentialsPresent
  ) {
    throw new Error("backup IM credential metadata does not match payload");
  }
  if (
    manifest.credentials?.imRuntimeCredentialsPresent !== undefined &&
    Boolean(manifest.credentials.imRuntimeCredentialsPresent) !== imCredentialsPresent
  ) {
    throw new Error("backup IM credential manifest does not match payload");
  }
  const database = validateDatabase(join(root, "rp-agent.sqlite"));
  const vault = validateVault(root, database);
  if (manifest.database.integrityCheck !== database.integrityCheck ||
      manifest.database.schemaVersion !== database.schemaVersion ||
      manifest.database.sha256 !== database.sha256 ||
      manifest.vault.vaultHash !== vault.vaultHash ||
      manifest.vault.projectionHash !== vault.projectionHash ||
      manifest.vault.documentCount !== vault.documentCount ||
      manifest.vault.projectionConsistent !== vault.projectionConsistent ||
      manifest.consistency.sqliteVaultProjection !== vault.sqliteVaultProjection) {
    throw new Error("backup consistency metadata does not match payload");
  }
  return { database, vault };
}

export function validateDatabase(path) {
  if (!existsSync(path)) {
    return { present: false, integrityCheck: "absent", schemaVersion: 0, sha256: null, size: 0 };
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const integrityCheck = integrityRows.length === 1 && String(integrityRows[0].integrity_check) === "ok" ? "ok" : "failed";
    if (integrityCheck !== "ok") throw new Error("SQLite integrity_check failed");
    const migration = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
    const schemaVersion = Number(migration?.version ?? 0);
    if (schemaVersion > MAX_DATABASE_SCHEMA_VERSION) {
      throw new Error(`backup database schema ${schemaVersion} is newer than supported ${MAX_DATABASE_SCHEMA_VERSION}`);
    }
    const source = readFileSync(path);
    return { present: true, integrityCheck, schemaVersion, sha256: sha256(source), size: source.byteLength };
  } finally {
    database.close();
  }
}

export function validateVault(root, databaseStatus) {
  const vaultRoot = join(root, "memory-vault");
  const statePath = join(root, "memory-vault-state.json");
  if (!existsSync(vaultRoot) && !existsSync(statePath)) {
    return {
      present: false, vaultHash: null, projectionHash: null, documentCount: 0,
      projectionConsistent: true, sqliteVaultProjection: !databaseStatus.present,
    };
  }
  if (!existsSync(vaultRoot) || !existsSync(statePath)) throw new Error("incomplete Memory Vault state");
  const documents = [];
  const ids = new Set();
  visit(vaultRoot, (path) => {
    if (!path.endsWith(".md") || path.endsWith(`${sep}README.md`)) return;
    const relativePath = relative(vaultRoot, path).split(sep).join("/");
    const source = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    const parsed = parseVaultDocument(source, relativePath);
    if (ids.has(parsed.metadata.id)) throw new Error(`duplicate Vault id ${parsed.metadata.id}`);
    ids.add(parsed.metadata.id);
    documents.push({ relativePath, documentHash: sha256(source), ...parsed });
  });
  documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const vaultHash = sha256(documents.map((entry) => `${entry.relativePath}\0${entry.documentHash}`).join("\n"));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const hashes = Object.fromEntries(documents.map((entry) => [entry.relativePath, entry.documentHash]));
  const projectionConsistent = state.schemaVersion === 1 && state.vaultHash === vaultHash &&
    state.documentCount === documents.length && JSON.stringify(state.documentHashes) === JSON.stringify(hashes);
  if (!projectionConsistent) throw new Error("Vault and projection state hashes differ");
  const sqliteVaultProjection = databaseStatus.present ? validateSqliteProjection(join(root, "rp-agent.sqlite"), documents) : false;
  if (databaseStatus.present && !sqliteVaultProjection) throw new Error("SQLite projection differs from Memory Vault");
  return {
    present: true,
    vaultHash,
    projectionHash: state.vaultHash,
    documentCount: documents.length,
    projectionConsistent,
    sqliteVaultProjection,
  };
}

function parseVaultDocument(source, relativePath) {
  if (!source.startsWith("---\n")) throw new Error(`${relativePath}: missing YAML frontmatter`);
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${relativePath}: unterminated YAML frontmatter`);
  const yaml = parseDocument(source.slice(4, end), {
    schema: "core", strict: true, uniqueKeys: true, prettyErrors: true,
  });
  if (yaml.errors.length) throw new Error(`${relativePath}: ${yaml.errors.map((entry) => entry.message).join("; ")}`);
  const metadata = yaml.toJS({ maxAliasCount: 0 });
  if (!metadata || typeof metadata !== "object" || ![1, 2, 3, 4].includes(metadata.schemaVersion) ||
      typeof metadata.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(metadata.id) ||
      !["user_profile", "person_profile", "character_soul", "scene", "memory"].includes(metadata.kind) ||
      !["reality", "roleplay", "legacy"].includes(metadata.realm) ||
      !Number.isInteger(metadata.revision) || metadata.revision < 1 ||
      typeof metadata.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.contentHash)) {
    throw new Error(`${relativePath}: invalid stable frontmatter`);
  }
  const expectedKeys = metadata.schemaVersion === 1
    ? V1_FRONTMATTER_KEYS
    : metadata.schemaVersion === 2
      ? V2_FRONTMATTER_KEYS
      : metadata.schemaVersion === 3
        ? V3_FRONTMATTER_KEYS
        : V4_FRONTMATTER_KEYS;
  const actualKeys = Object.keys(metadata).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${relativePath}: frontmatter key set is not stable schema ${metadata.schemaVersion}`);
  }
  const conversationSpace = metadata.schemaVersion >= 4 ? metadata.conversationSpace : "normal";
  const secretOwnerCharacterId = metadata.schemaVersion >= 4
    ? metadata.secretOwnerCharacterId
    : null;
  if (!['normal', 'secret'].includes(conversationSpace) ||
      (conversationSpace === 'normal' && secretOwnerCharacterId !== null) ||
      (conversationSpace === 'secret' &&
        (metadata.kind !== 'memory' ||
          typeof secretOwnerCharacterId !== 'string' ||
          !/^[A-Za-z0-9_-]+$/.test(secretOwnerCharacterId))) ||
      (metadata.kind !== 'memory' && conversationSpace !== 'normal')) {
    throw new Error(`${relativePath}: invalid conversation space frontmatter`);
  }
  if (relativePath !== expectedVaultPath(metadata)) {
    throw new Error(`${relativePath}: frontmatter resolves to ${expectedVaultPath(metadata)}`);
  }
  const body = source.slice(end + 5);
  if (sha256(body) !== metadata.contentHash) throw new Error(`${relativePath}: body contentHash mismatch`);
  return { metadata, body };
}

function expectedVaultPath(metadata) {
  if (metadata.kind === "memory" && metadata.conversationSpace === "secret") {
    return `secret/characters/${safeId(metadata.secretOwnerCharacterId, "secretOwnerCharacterId")}/memories/${metadata.id}.md`;
  }
  if (metadata.kind === "user_profile") return "reality/user-profile.md";
  if (metadata.kind === "person_profile") return `reality/people/${metadata.id}.md`;
  if (metadata.kind === "character_soul") return `roleplay/characters/${safeId(metadata.characterId, "characterId")}/SOUL.md`;
  if (metadata.kind === "scene") return `roleplay/scenes/${safeId(metadata.sessionId, "sessionId")}.md`;
  if (metadata.kind !== "memory") throw new Error(`unsupported Vault kind ${String(metadata.kind)}`);
  if (metadata.realm === "legacy") return `legacy/quarantine/${metadata.id}.md`;
  if (metadata.realm === "reality") return `reality/memories/${metadata.id}.md`;
  return `roleplay/characters/${safeId(metadata.characterId, "characterId")}/memories/${metadata.id}.md`;
}

function safeId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function validateSqliteProjection(path, documents) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const vaultMemories = documents.filter((entry) => entry.metadata.kind === "memory")
      .map((entry) => ({
        id: entry.metadata.id,
        conversationSpace: entry.metadata.schemaVersion >= 4
          ? entry.metadata.conversationSpace
          : "normal",
        secretOwnerCharacterId: entry.metadata.schemaVersion >= 4
          ? entry.metadata.secretOwnerCharacterId
          : null,
        realm: entry.metadata.realm,
        characterId: entry.metadata.characterId ?? null,
        validity: entry.metadata.validity,
        confirmed: entry.metadata.confirmed ? 1 : 0,
        content: entry.body.trimEnd(),
      })).sort((a, b) => a.id.localeCompare(b.id));
    const memoryColumns = new Set(
      database.prepare("PRAGMA table_info(rp_memories)").all().map((row) => String(row.name)),
    );
    const rows = database.prepare(
      `SELECT id,
        ${memoryColumns.has("conversation_space")
          ? "conversation_space"
          : "'normal'"} AS conversationSpace,
        ${memoryColumns.has("secret_owner_character_id")
          ? "secret_owner_character_id"
          : "NULL"} AS secretOwnerCharacterId,
        realm, character_id AS characterId, validity, confirmed, content
       FROM rp_memories ORDER BY id`,
    ).all().map((row) => ({ ...row, confirmed: Number(row.confirmed) }));
    const vaultScenes = documents.filter((entry) => entry.metadata.kind === "scene")
      .map((entry) => ({ sessionId: entry.metadata.sessionId, summary: entry.body })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const scenes = database.prepare(
      "SELECT role_session_id AS sessionId, summary FROM scene_states ORDER BY role_session_id",
    ).all();
    return JSON.stringify(vaultMemories) === JSON.stringify(rows) && JSON.stringify(vaultScenes) === JSON.stringify(scenes);
  } finally {
    database.close();
  }
}

function visit(root, onFile) {
  if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error(`backup rejects symlink: ${root}`);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup rejects symlink: ${path}`);
    if (entry.isDirectory()) visit(path, onFile);
    else if (entry.isFile()) onFile(path);
    else throw new Error(`backup rejects non-regular file: ${path}`);
  }
}
