import { randomUUID } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  BACKUP_SCHEMA_VERSION, assertWriterInactive, payloadFiles, sha256,
  validateBackupDirectory, validateDatabase, validateVault,
} from "./backup-contract.mjs";
import { resolveStateDirectory } from "./state-directory.mjs";

const stateDir = resolveStateDirectory({ explicit: process.argv[2] });
const destination = resolve(process.argv[3] ?? join("backups", `yourchar-${safeTimestamp()}`));
const staging = `${destination}.preparing-${randomUUID()}`;
if (!existsSync(stateDir)) throw new Error(`state directory not found: ${stateDir}`);
if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
assertWriterInactive(stateDir);
const externalGitPrivateKeys = readExternalGitPrivateKeyPaths(stateDir);
const gitWorkspaceRepositories = resolve(join(stateDir, "workspace", "repos"));

try {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const name of [
    "conversations.json", "pi-sessions", "pi-agent", "model-api.json", "tavily.json", "vision.json", "mineru.json",
    "git", "git-worktrees", "git-work-items.json", "git-runtime", "git-repository.json",
    "user-profile.md", "characters", "memory-vault", "memory-vault-state.json",
    "memory-vault-migration.json", "memory-vault-journal", "memory-vault-recovery.json", "workspace",
    "workspace-secret", "skills", "character-agent-skills", "im-runtime",
    "avatars", "system-prompts", "trace-archive.json", "trace-archive",
  ]) {
    const source = join(stateDir, name);
    if (existsSync(source)) {
      cpSync(source, join(staging, name), {
        recursive: true,
        filter: (candidate) => {
          const resolvedCandidate = resolve(candidate);
          return !isPathAtOrBelow(resolvedCandidate, gitWorkspaceRepositories) &&
            !externalGitPrivateKeys.has(resolvedCandidate);
        },
      });
    }
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
  const files = payloadFiles(staging);
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    sourceDirectoryName: basename(stateDir),
    files,
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
      mineruConfigPresent: existsSync(join(staging, "mineru.json")),
      imRuntimeCredentialsPresent: existsSync(join(staging, "im-runtime", "credentials.json")),
    },
    containsModelCredentials: existsSync(join(staging, "model-api.json")),
    containsTavilyCredentials: existsSync(join(staging, "tavily.json")),
    containsVisionCredentials: existsSync(join(staging, "vision.json")),
    containsMineruCredentials: existsSync(join(staging, "mineru.json")),
    containsImCredentials: existsSync(join(staging, "im-runtime", "credentials.json")),
    containsImRuntime: files.some((file) => file.path.startsWith("im-runtime/")),
    containsMemoryVault: vault.present,
    containsSecretWorkspace: files.some((file) => file.path.startsWith("workspace-secret/")),
    containsInstalledSkills: files.some((file) => file.path.startsWith("skills/")),
    containsCharacterAgentSkills: files.some((file) => file.path.startsWith("character-agent-skills/")),
    excludesGitWorkspaceRepositories: true,
    containsGitAccessConfig: existsSync(join(staging, "git", "access.json")),
    containsGitRegistry: existsSync(join(staging, "git", "registry.json")),
    containsGitCredentials: files.some((file) => file.path.startsWith("git/credentials/")),
    containsGitWorkItems: existsSync(join(staging, "git-work-items.json")),
    containsGitRepositoryConfig: existsSync(join(staging, "git-repository.json")),
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

function readExternalGitPrivateKeyPaths(stateDir) {
  const paths = new Set();
  const accessPath = join(stateDir, "git", "access.json");
  if (existsSync(accessPath)) {
    const access = JSON.parse(readFileSync(accessPath, "utf8"));
    if (access?.credential?.kind === "external-file") {
      addExternalGitPrivateKeyPath(paths, access.credential.privateKeyPath);
    }
  }
  const registryPath = join(stateDir, "git", "registry.json");
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(registry?.identities)) {
      throw new Error("Git registry identities must be an array before backup");
    }
    for (const identity of registry.identities) {
      if (identity?.credential?.kind === "external-file") {
        addExternalGitPrivateKeyPath(paths, identity.credential.privateKeyPath);
      }
    }
  }
  const legacyPath = join(stateDir, "git-repository.json");
  if (existsSync(legacyPath)) {
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
    if (legacy?.privateKeyPath) addExternalGitPrivateKeyPath(paths, legacy.privateKeyPath);
  }
  return paths;
}

function addExternalGitPrivateKeyPath(paths, value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("external Git private-key path must be absolute before backup");
  }
  paths.add(resolve(value));
}

function isPathAtOrBelow(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
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
