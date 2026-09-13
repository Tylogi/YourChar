import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
export const MAX_DATABASE_SCHEMA_VERSION = 63;
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
  if (
    manifest.containsCharacterAgentSkills !== undefined &&
    Boolean(manifest.containsCharacterAgentSkills) !==
      actualFiles.some((file) => file.path.startsWith("character-agent-skills/"))
  ) {
    throw new Error("backup character Agent Skill metadata does not match payload");
  }
  const characterSkillTransientStatePresent = actualFiles.some((file) =>
    isCharacterSkillTransientBackupPath(file.path)
  );
  if (
    manifest.excludesCharacterAgentSkillTransientState !== undefined &&
    (manifest.excludesCharacterAgentSkillTransientState !== true ||
      characterSkillTransientStatePresent)
  ) {
    throw new Error("backup character Agent Skill transient-state exclusion metadata does not match payload");
  }
  if (manifest.characterAgentSkillPackagesConsistent !== undefined) {
    if (manifest.characterAgentSkillPackagesConsistent !== true) {
      throw new Error("backup character Agent Skill consistency flag must be true when present");
    }
    validateCharacterAgentSkillPackages(root);
  }
  const imRuntimePresent = actualFiles.some((file) => file.path.startsWith("im-runtime/"));
  const imCredentialsPresent = existsSync(join(root, "im-runtime", "credentials.json"));
  const mineruConfigPresent = existsSync(join(root, "mineru.json"));
  const gitRegistryPresent = actualFiles.some((file) => file.path === "git/registry.json");
  const gitAccessConfigPresent = actualFiles.some((file) => file.path === "git/access.json");
  const gitCredentialsPresent = actualFiles.some((file) => file.path.startsWith("git/credentials/"));
  const gitWorkItemsPresent = actualFiles.some((file) => file.path === "git-work-items.json");
  const gitRepositoryConfigPresent = actualFiles.some((file) => file.path === "git-repository.json");
  const gitWorkspaceRepositoriesPresent = actualFiles.some(
    (file) => file.path === "workspace/repos" || file.path.startsWith("workspace/repos/"),
  );
  const memoryVaultHistoryPresent = actualFiles.some(
    (file) => file.path.startsWith("memory-vault-history.git/"),
  );
  if (
    manifest.containsMemoryVaultHistory !== undefined &&
    Boolean(manifest.containsMemoryVaultHistory) !== memoryVaultHistoryPresent
  ) {
    throw new Error("backup Memory Vault history metadata does not match payload");
  }
  if (
    manifest.excludesGitWorkspaceRepositories !== undefined &&
    (manifest.excludesGitWorkspaceRepositories !== true ||
      gitWorkspaceRepositoriesPresent)
  ) {
    throw new Error("backup Git Workspace-repository exclusion metadata does not match payload");
  }
  if (
    manifest.containsGitAccessConfig !== undefined &&
    Boolean(manifest.containsGitAccessConfig) !== gitAccessConfigPresent
  ) {
    throw new Error("backup Git access-config metadata does not match payload");
  }
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
  if (
    manifest.containsMineruCredentials !== undefined &&
    Boolean(manifest.containsMineruCredentials) !== mineruConfigPresent
  ) {
    throw new Error("backup MinerU credential metadata does not match payload");
  }
  if (
    manifest.credentials?.mineruConfigPresent !== undefined &&
    Boolean(manifest.credentials.mineruConfigPresent) !== mineruConfigPresent
  ) {
    throw new Error("backup MinerU credential manifest does not match payload");
  }
  if (
    manifest.containsGitRegistry !== undefined &&
    Boolean(manifest.containsGitRegistry) !== gitRegistryPresent
  ) {
    throw new Error("backup Git registry metadata does not match payload");
  }
  if (
    manifest.containsGitCredentials !== undefined &&
    Boolean(manifest.containsGitCredentials) !== gitCredentialsPresent
  ) {
    throw new Error("backup managed Git credential metadata does not match payload");
  }
  if (
    manifest.containsGitWorkItems !== undefined &&
    Boolean(manifest.containsGitWorkItems) !== gitWorkItemsPresent
  ) {
    throw new Error("backup Git work-item metadata does not match payload");
  }
  if (
    manifest.containsGitRepositoryConfig !== undefined &&
    Boolean(manifest.containsGitRepositoryConfig) !== gitRepositoryConfigPresent
  ) {
    throw new Error("backup Git repository config metadata does not match payload");
  }
  const database = validateDatabase(join(root, "rp-agent.sqlite"));
  const vault = validateVault(root, database);
  const memoryVaultHistory = validateMemoryVaultHistory(root);
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
  if (
    manifest.memoryVaultHistory !== undefined &&
    JSON.stringify(manifest.memoryVaultHistory) !== JSON.stringify(memoryVaultHistory)
  ) {
    throw new Error("backup Memory Vault history integrity metadata does not match payload");
  }
  return { database, vault };
}

export function validateMemoryVaultHistory(root) {
  const repository = join(root, "memory-vault-history.git");
  if (!existsSync(repository)) {
    return { present: false, headCommitId: null, checkpointCount: 0 };
  }
  const status = lstatSync(repository);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Memory Vault history must be a regular non-symlink directory");
  }
  for (const relativePath of ["objects/info/alternates", "objects/info/http-alternates", "shallow"]) {
    if (existsSync(join(repository, relativePath))) {
      throw new Error("Memory Vault history cannot use alternate or shallow object storage");
    }
  }
  const run = (...arguments_) => {
    const result = spawnSync("git", [`--git-dir=${repository}`, ...arguments_], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "").trim().replace(/\s+/gu, " ").slice(0, 300);
      throw new Error(`Memory Vault history verification failed${detail ? `: ${detail}` : ""}`);
    }
    return String(result.stdout ?? "").trim();
  };
  if (run("config", "--bool", "--get", "core.bare") !== "true") {
    throw new Error("Memory Vault history is not a bare repository");
  }
  if (run("symbolic-ref", "HEAD") !== "refs/heads/main") {
    throw new Error("Memory Vault history HEAD is not main");
  }
  if (run("rev-parse", "--show-object-format") !== "sha1") {
    throw new Error("Memory Vault history has an unsupported object format");
  }
  run("fsck", "--full", "--strict", "--no-dangling");
  const headCommitId = run("rev-parse", "--verify", "refs/heads/main");
  const checkpointCount = Number(run("rev-list", "--count", "refs/heads/main"));
  if (!/^[0-9a-f]{40}$/u.test(headCommitId) || !Number.isSafeInteger(checkpointCount) || checkpointCount < 1) {
    throw new Error("Memory Vault history metadata is invalid");
  }
  return { present: true, headCommitId, checkpointCount };
}

function isCharacterSkillTransientBackupPath(path) {
  if (!path.startsWith("character-agent-skills/")) return false;
  const segments = path.split("/").slice(1);
  return segments[0] === ".uninstall-quarantine" ||
    (/^[0-9a-f]{64}$/u.test(segments[0] ?? "") &&
      (segments[1] === "normal" || segments[1] === "secret") &&
      segments[2] === "skill-installer-quarantine");
}

/**
 * Return the exact row-backed package directories relative to
 * character-agent-skills/. The copied database snapshot, rather than the live
 * filesystem, is deliberately authoritative so crashed publish orphans are
 * never promoted into a new backup.
 */
export function characterAgentSkillPublishedDirectories(databasePath) {
  return characterAgentSkillPackageRows(databasePath).map((row) => row.relativeDirectory);
}

/**
 * Verify every durable character package row against the bytes copied into a
 * backup. This is opt-in for existing schema-v3 manifests, while every newly
 * produced backup sets the consistency flag and therefore gets strict restore
 * verification too.
 */
export function validateCharacterAgentSkillPackages(root) {
  const rows = characterAgentSkillPackageRows(join(root, "rp-agent.sqlite"));
  const expected = new Set(rows.map((row) => row.relativeDirectory));
  for (const row of rows) {
    verifyCharacterAgentSkillPackage(join(
      root,
      "character-agent-skills",
      ...row.relativeDirectory.split("/"),
    ), row);
  }
  const observed = publishedCharacterAgentSkillDirectories(
    join(root, "character-agent-skills"),
  );
  for (const relativeDirectory of observed) {
    if (!expected.has(relativeDirectory)) {
      throw new Error(`backup contains an orphan character Agent Skill package: ${relativeDirectory}`);
    }
  }
  return { consistent: true, packageCount: rows.length };
}

function characterAgentSkillPackageRows(databasePath) {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'character_agent_skill_packages'",
    ).get();
    if (!table) return [];
    const rows = database.prepare(`
      SELECT character_id, conversation_space, name, digest, manifest_json
      FROM character_agent_skill_packages
      ORDER BY character_id, conversation_space, name
    `).all();
    return rows.map((row) => {
      const characterId = typeof row.character_id === "string" ? row.character_id : "";
      const conversationSpace = row.conversation_space;
      const name = row.name;
      const digest = row.digest;
      if (!characterId || characterId.trim() !== characterId || characterId.length > 300) {
        throw new Error("backup character Agent Skill row has an invalid character id");
      }
      if (conversationSpace !== "normal" && conversationSpace !== "secret") {
        throw new Error("backup character Agent Skill row has an invalid conversation space");
      }
      if (
        typeof name !== "string" ||
        name.length > 64 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
      ) {
        throw new Error("backup character Agent Skill row has an invalid package name");
      }
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
        throw new Error(`backup character Agent Skill ${name} has an invalid package digest`);
      }
      const manifest = parseCharacterAgentSkillManifest(row.manifest_json, name);
      return {
        name,
        digest,
        manifest,
        relativeDirectory: `${sha256(characterId)}/${conversationSpace}/skills/${name}`,
      };
    });
  } finally {
    database.close();
  }
}

function parseCharacterAgentSkillManifest(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`backup character Agent Skill ${name} has invalid manifest JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 256) {
    throw new Error(`backup character Agent Skill ${name} has an invalid manifest file count`);
  }
  const manifest = [];
  let previousPath = "";
  let totalBytes = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`backup character Agent Skill ${name} has an invalid manifest entry`);
    }
    const path = validateCharacterAgentSkillManifestPath(entry.path, name);
    if (compareText(path, previousPath) <= 0) {
      throw new Error(`backup character Agent Skill ${name} manifest is not uniquely sorted`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 4 * 1024 * 1024) {
      throw new Error(`backup character Agent Skill ${name} has an invalid manifest size`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`backup character Agent Skill ${name} has an invalid file digest`);
    }
    totalBytes += entry.size;
    if (totalBytes > 16 * 1024 * 1024) {
      throw new Error(`backup character Agent Skill ${name} exceeds the package size limit`);
    }
    manifest.push({ path, size: entry.size, sha256: entry.sha256 });
    previousPath = path;
  }
  if (!manifest.some((entry) => entry.path === "SKILL.md")) {
    throw new Error(`backup character Agent Skill ${name} is missing SKILL.md in its manifest`);
  }
  return manifest;
}

function validateCharacterAgentSkillManifestPath(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.endsWith("/")
  ) {
    throw new Error(`backup character Agent Skill ${name} has an invalid manifest path`);
  }
  const parts = value.split("/");
  if (
    parts.length > 20 ||
    parts.some((part) =>
      !part || part === "." || part === ".." || part.length > 255 || /[:\x00-\x1f\x7f]/u.test(part)
    )
  ) {
    throw new Error(`backup character Agent Skill ${name} has an unsafe manifest path`);
  }
  return parts.join("/");
}

function verifyCharacterAgentSkillPackage(packageDirectory, row) {
  if (!existsSync(packageDirectory)) {
    throw new Error(`backup character Agent Skill ${row.name} package bytes are missing`);
  }
  const rootStats = lstatSync(packageDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`backup character Agent Skill ${row.name} package root is unsafe`);
  }
  const observed = [];
  const observedDirectories = [];
  let totalBytes = 0;
  const inspect = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateCharacterAgentSkillManifestPath(relativePath, row.name);
      const target = join(directory, entry.name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new Error(`backup character Agent Skill ${row.name} contains a link or special file`);
      }
      if (stats.isDirectory()) {
        observedDirectories.push(relativePath);
        inspect(target, relativePath);
        continue;
      }
      if (observed.length >= 256 || stats.size > 4 * 1024 * 1024) {
        throw new Error(`backup character Agent Skill ${row.name} exceeds file limits`);
      }
      totalBytes += stats.size;
      if (totalBytes > 16 * 1024 * 1024) {
        throw new Error(`backup character Agent Skill ${row.name} exceeds the package size limit`);
      }
      const bytes = readFileSync(target);
      observed.push({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) });
    }
  };
  inspect(packageDirectory, "");
  observed.sort((left, right) => compareText(left.path, right.path));
  observedDirectories.sort(compareText);
  const expectedDirectories = directoriesForCharacterAgentSkillManifest(row.manifest);
  const observedDigest = sha256(JSON.stringify({ version: 1, files: observed }));
  if (
    observedDigest !== row.digest ||
    JSON.stringify(observed) !== JSON.stringify(row.manifest) ||
    JSON.stringify(observedDirectories) !== JSON.stringify(expectedDirectories)
  ) {
    throw new Error(`backup character Agent Skill ${row.name} package bytes changed`);
  }
}

function directoriesForCharacterAgentSkillManifest(manifest) {
  const directories = new Set();
  for (const entry of manifest) {
    const parts = entry.path.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  return [...directories].sort(compareText);
}

function publishedCharacterAgentSkillDirectories(packageRoot) {
  if (!existsSync(packageRoot)) return [];
  const directories = [];
  for (const owner of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!owner.isDirectory() || !/^[0-9a-f]{64}$/u.test(owner.name)) continue;
    for (const space of ["normal", "secret"]) {
      const skillsRoot = join(packageRoot, owner.name, space, "skills");
      if (!existsSync(skillsRoot)) continue;
      const stats = lstatSync(skillsRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`backup character Agent Skill published root is unsafe: ${skillsRoot}`);
      }
      for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
        const skillPath = join(skillsRoot, skill.name);
        const skillStats = lstatSync(skillPath);
        if (skillStats.isSymbolicLink() || !skillStats.isDirectory()) {
          throw new Error(`backup character Agent Skill published entry is unsafe: ${skillPath}`);
        }
        directories.push(`${owner.name}/${space}/skills/${skill.name}`);
      }
    }
  }
  return directories.sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
