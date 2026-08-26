import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ConversationSpace } from "../domain/types.js";
import type { AppDatabase } from "../storage/database.js";
import {
  AgentSkillInstallerError,
  AgentSkillInstallerService,
  type AgentSkillInstallerOptions,
  type AgentSkillManifestEntry,
  type AgentSkillSourceMetadata,
  type AgentSkillStageInput,
  type AgentSkillStageResult,
  verifyAgentSkillPackage,
} from "./skill-installer.js";

export const characterAgentSkillPackageLimit = 12;
export const characterAgentSkillStageLimit = 4;

export type CharacterAgentSkillPackageScope = {
  characterId: string;
  conversationSpace: ConversationSpace;
};

export type CharacterAgentSkillPackageIntegrity =
  | "verified"
  | "missing"
  | "changed"
  | "invalid";

export type CharacterAgentSkillPackage = CharacterAgentSkillPackageScope & {
  name: string;
  description: string;
  enabled: boolean;
  source: AgentSkillSourceMetadata;
  archiveSha256: string;
  digest: string;
  manifest: AgentSkillManifestEntry[];
  createdAt: string;
  updatedAt: string;
  integrity: CharacterAgentSkillPackageIntegrity;
};

export type CharacterAgentSkillPackageLocation = {
  name: string;
  description: string;
  baseDir: string;
  filePath: string;
  digest: string;
};

export type CharacterAgentSkillPackageServiceOptions = {
  database: AppDatabase;
  stateDir: string;
  transport?: AgentSkillInstallerOptions["transport"];
  resolveHostname?: AgentSkillInstallerOptions["resolveHostname"];
  now?: AgentSkillInstallerOptions["now"];
  limits?: AgentSkillInstallerOptions["limits"];
  isSkillNameAvailable?: AgentSkillInstallerOptions["isSkillNameAvailable"];
};

export type CharacterAgentSkillStageInput = CharacterAgentSkillPackageScope & AgentSkillStageInput;

export type CharacterAgentSkillStageLookup = CharacterAgentSkillPackageScope & {
  stageId: string;
};

export type CharacterAgentSkillConfirmInput = CharacterAgentSkillStageLookup & {
  digest: string;
  enabled: boolean;
};

export type CharacterAgentSkillCancelInput = CharacterAgentSkillStageLookup & {
  digest?: string;
};

export type CharacterAgentSkillEnabledInput = CharacterAgentSkillPackageScope & {
  name: string;
  enabled: boolean;
};

type PackageRow = {
  character_id: string;
  conversation_space: string;
  name: string;
  description: string;
  enabled: number;
  source_requested_url: string;
  source_resolved_url: string;
  source_final_url: string;
  source_package_path: string | null;
  source_requested_ref: string | null;
  source_resolved_commit: string | null;
  archive_sha256: string;
  digest: string;
  manifest_json: string;
  created_at: string;
  updated_at: string;
};

type ScopedInstaller = {
  characterId: string;
  conversationSpace: ConversationSpace;
  installer: AgentSkillInstallerService;
};

const sha256Pattern = /^[0-9a-f]{64}$/;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CharacterAgentSkillPackageService {
  private readonly database: AppDatabase;
  private readonly stateDir: string;
  private readonly packageRoot: string;
  private readonly installerOptions: Omit<AgentSkillInstallerOptions, "stateDir">;
  private readonly installers = new Map<string, ScopedInstaller>();
  private readonly now: () => number;
  private disposed = false;

  constructor(options: CharacterAgentSkillPackageServiceOptions) {
    this.database = options.database;
    this.stateDir = requiredStateDirectory(options.stateDir);
    this.packageRoot = join(this.stateDir, "character-agent-skills");
    this.now = options.now ?? Date.now;
    this.installerOptions = {
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
      now: this.now,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.isSkillNameAvailable
        ? { isSkillNameAvailable: options.isSkillNameAvailable }
        : {}),
    };
    ensureOwnedDirectory(this.packageRoot);
  }

  async stage(
    input: CharacterAgentSkillStageInput,
    signal?: AbortSignal,
  ): Promise<AgentSkillStageResult> {
    const scope = this.scope(input);
    this.assertCharacterExists(scope.characterId);
    this.assertBelowPackageLimit(scope);
    const installer = this.installerFor(scope);
    if (installer.listStages().length >= characterAgentSkillStageLimit) {
      throw new AgentSkillInstallerError(
        `a character can have at most ${characterAgentSkillStageLimit} pending Skill reviews per space`,
        "STAGE_LIMIT",
      );
    }
    const staged = await installer.stage({
      sourceUrl: input.sourceUrl,
      ...(input.packagePath ? { packagePath: input.packagePath } : {}),
      ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
    }, signal);
    if (this.findRow(scope, staged.metadata.name)) {
      installer.cancel({ stageId: staged.stageId, digest: staged.digest });
      throw new AgentSkillInstallerError(
        `Skill ${staged.metadata.name} is already installed for this character and space`,
        "SKILL_EXISTS",
      );
    }
    return staged;
  }

  list(scopeInput: CharacterAgentSkillPackageScope): CharacterAgentSkillPackage[] {
    const scope = this.scope(scopeInput);
    this.assertCharacterExists(scope.characterId);
    const rows = this.database.connection.prepare(`
      SELECT *
      FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ?
      ORDER BY name
    `).all(scope.characterId, scope.conversationSpace) as PackageRow[];
    return rows.map((row) => this.packageFromRow(row));
  }

  getStage(input: CharacterAgentSkillStageLookup): AgentSkillStageResult | undefined {
    const scope = this.scope(input);
    const installer = this.installers.get(scopeKey(scope))?.installer;
    return installer?.getStage(requiredStageId(input.stageId));
  }

  listStages(scopeInput: CharacterAgentSkillPackageScope): AgentSkillStageResult[] {
    const scope = this.scope(scopeInput);
    this.assertCharacterExists(scope.characterId);
    return this.installers.get(scopeKey(scope))?.installer.listStages() ?? [];
  }

  confirm(input: CharacterAgentSkillConfirmInput): CharacterAgentSkillPackage {
    const scope = this.scope(input);
    this.assertCharacterExists(scope.characterId);
    if (typeof input.enabled !== "boolean") {
      throw new AgentSkillInstallerError("enabled must be a boolean", "PACKAGE_INPUT_INVALID");
    }
    const stageId = requiredStageId(input.stageId);
    const installer = this.installers.get(scopeKey(scope))?.installer;
    const staged = installer?.getStage(stageId);
    if (!installer || !staged) {
      throw new AgentSkillInstallerError(
        "Skill stage was not found for this character and conversation space",
        "STAGE_NOT_FOUND",
      );
    }
    if (staged.digest !== input.digest) {
      throw new AgentSkillInstallerError(
        "stage digest does not match the reviewed package",
        "STAGE_DIGEST_MISMATCH",
      );
    }
    if (this.findRow(scope, staged.metadata.name)) {
      throw new AgentSkillInstallerError(
        `Skill ${staged.metadata.name} is already installed for this character and space`,
        "SKILL_EXISTS",
      );
    }
    if (this.packageCount(scope) >= characterAgentSkillPackageLimit) {
      installer.cancel({ stageId, digest: input.digest });
      throw packageLimitError();
    }

    const receipt = installer.confirm({ stageId, digest: input.digest });
    try {
      this.database.connection.prepare(`
        INSERT INTO character_agent_skill_packages(
          character_id, conversation_space, name, description, enabled,
          source_requested_url, source_resolved_url, source_final_url,
          source_package_path, source_requested_ref, source_resolved_commit,
          archive_sha256, digest, manifest_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.characterId,
        scope.conversationSpace,
        staged.metadata.name,
        staged.metadata.description,
        input.enabled ? 1 : 0,
        staged.source.requestedUrl,
        staged.source.resolvedArchiveUrl,
        staged.source.finalArchiveUrl,
        staged.source.packagePath ?? null,
        staged.source.requestedRef ?? null,
        staged.source.resolvedCommit ?? null,
        staged.archiveSha256,
        staged.digest,
        JSON.stringify(staged.manifest),
        receipt.installedAt,
        receipt.installedAt,
      );
    } catch (error) {
      try {
        installer.rollbackInstall(receipt);
      } catch (rollbackError) {
        throw new AgentSkillInstallerError(
          "failed to persist the character Skill package and its published directory could not be rolled back",
          "ROLLBACK_CHANGED",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw error;
    }
    installer.finalizeInstall(receipt);
    return this.packageFromRow(this.requiredRow(scope, staged.metadata.name));
  }

  cancel(input: CharacterAgentSkillCancelInput): boolean {
    const scope = this.scope(input);
    const installer = this.installers.get(scopeKey(scope))?.installer;
    if (!installer) return false;
    return installer.cancel({
      stageId: requiredStageId(input.stageId),
      ...(input.digest ? { digest: input.digest } : {}),
    });
  }

  setEnabled(input: CharacterAgentSkillEnabledInput): CharacterAgentSkillPackage {
    const scope = this.scope(input);
    this.assertCharacterExists(scope.characterId);
    const name = requiredSkillName(input.name);
    if (typeof input.enabled !== "boolean") {
      throw new AgentSkillInstallerError("enabled must be a boolean", "PACKAGE_INPUT_INVALID");
    }
    const current = this.packageFromRow(this.requiredRow(scope, name));
    if (input.enabled && current.integrity !== "verified") {
      throw new AgentSkillInstallerError(
        `Skill ${name} cannot be enabled because its installed package failed integrity verification`,
        "SKILL_SOURCE_MISMATCH",
      );
    }
    const updatedAt = new Date(checkedNow(this.now)).toISOString();
    this.database.connection.prepare(`
      UPDATE character_agent_skill_packages
      SET enabled = ?, updated_at = ?
      WHERE character_id = ? AND conversation_space = ? AND name = ?
    `).run(
      input.enabled ? 1 : 0,
      updatedAt,
      scope.characterId,
      scope.conversationSpace,
      name,
    );
    return this.packageFromRow(this.requiredRow(scope, name));
  }

  effectivePackageLocations(
    scopeInput: CharacterAgentSkillPackageScope,
  ): CharacterAgentSkillPackageLocation[] {
    const scope = this.scope(scopeInput);
    this.assertCharacterExists(scope.characterId);
    const rows = this.database.connection.prepare(`
      SELECT *
      FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ? AND enabled = 1
      ORDER BY name
    `).all(scope.characterId, scope.conversationSpace) as PackageRow[];
    return rows.map((row) => this.packageFromRow(row))
      .filter((entry) => entry.integrity === "verified")
      .map((entry) => {
        const baseDir = this.packageDirectory(entry);
        return {
          name: entry.name,
          description: entry.description,
          baseDir,
          filePath: join(baseDir, "SKILL.md"),
          digest: entry.digest,
        };
      });
  }

  readPackageSkillMarkdown(input: CharacterAgentSkillPackageScope & { name: string }): string {
    const scope = this.scope(input);
    this.assertCharacterExists(scope.characterId);
    const name = requiredSkillName(input.name);
    const entry = this.packageFromRow(this.requiredRow(scope, name));
    if (entry.integrity !== "verified") {
      throw new AgentSkillInstallerError(
        `Skill ${name} cannot be read because its installed package failed integrity verification`,
        "SKILL_SOURCE_MISMATCH",
      );
    }
    const expected = entry.manifest.find((manifestEntry) => manifestEntry.path === "SKILL.md");
    const maximumBytes = this.installerOptions.limits?.maximumSkillMarkdownBytes ?? 128 * 1024;
    if (!expected || expected.size > maximumBytes) {
      throw new AgentSkillInstallerError(
        "installed Skill markdown exceeds the configured read limit",
        "SKILL_SOURCE_MISMATCH",
      );
    }
    const baseDir = this.packageDirectory(entry);
    const filePath = join(baseDir, "SKILL.md");
    let descriptor: number | undefined;
    try {
      const expectedRealPath = join(realpathSync(baseDir), "SKILL.md");
      const observedRealPath = realpathSync(filePath);
      if (observedRealPath !== expectedRealPath) {
        throw new AgentSkillInstallerError(
          "installed Skill markdown resolves outside its verified package",
          "SKILL_SOURCE_MISMATCH",
        );
      }
      descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      const observed = lstatSync(observedRealPath);
      if (
        !opened.isFile()
        || opened.dev !== observed.dev
        || opened.ino !== observed.ino
        || opened.size !== expected.size
        || opened.size > maximumBytes
      ) {
        throw new AgentSkillInstallerError(
          "installed Skill markdown changed while it was being opened",
          "SKILL_SOURCE_MISMATCH",
        );
      }
      const bytes = readFileSync(descriptor);
      if (
        bytes.byteLength !== expected.size
        || createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      ) {
        throw new AgentSkillInstallerError(
          "installed Skill markdown no longer matches its persisted manifest",
          "SKILL_SOURCE_MISMATCH",
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new AgentSkillInstallerError(
          "installed Skill markdown is not valid UTF-8",
          "SKILL_SOURCE_MISMATCH",
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof AgentSkillInstallerError) throw error;
      throw new AgentSkillInstallerError(
        "installed Skill markdown could not be opened safely",
        "SKILL_SOURCE_MISMATCH",
        { cause: error },
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  clearAll(): void {
    this.assertAvailable();
    this.disposeInstallers();
    assertOwnedPackageRoot(this.stateDir, this.packageRoot);
    if (existsSync(this.packageRoot)) {
      const stats = lstatSync(this.packageRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AgentSkillInstallerError(
          "character Skill package root must be a real directory",
          "UNSAFE_STATE_DIRECTORY",
        );
      }
      rmSync(this.packageRoot, { recursive: true, force: false });
    }
    ensureOwnedDirectory(this.packageRoot);
    this.database.connection.prepare("DELETE FROM character_agent_skill_packages").run();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposeInstallers();
    this.disposed = true;
  }

  private installerFor(scope: CharacterAgentSkillPackageScope): AgentSkillInstallerService {
    this.assertAvailable();
    const key = scopeKey(scope);
    const existing = this.installers.get(key);
    if (existing) return existing.installer;
    const installer = new AgentSkillInstallerService({
      ...this.installerOptions,
      stateDir: this.scopeStateDirectory(scope),
    });
    this.installers.set(key, { ...scope, installer });
    return installer;
  }

  private scope(input: CharacterAgentSkillPackageScope): CharacterAgentSkillPackageScope {
    this.assertAvailable();
    const characterId = typeof input.characterId === "string" ? input.characterId.trim() : "";
    if (!characterId || characterId !== input.characterId || characterId.length > 300) {
      throw new AgentSkillInstallerError("characterId is invalid", "PACKAGE_INPUT_INVALID");
    }
    if (input.conversationSpace !== "normal" && input.conversationSpace !== "secret") {
      throw new AgentSkillInstallerError(
        "conversationSpace must be normal or secret",
        "PACKAGE_INPUT_INVALID",
      );
    }
    return { characterId, conversationSpace: input.conversationSpace };
  }

  private assertCharacterExists(characterId: string): void {
    const row = this.database.connection.prepare(
      "SELECT 1 AS present FROM characters WHERE id = ?",
    ).get(characterId) as { present?: number } | undefined;
    if (row?.present !== 1) {
      throw new AgentSkillInstallerError(
        "character was not found",
        "CHARACTER_NOT_FOUND",
      );
    }
  }

  private assertBelowPackageLimit(scope: CharacterAgentSkillPackageScope): void {
    if (this.packageCount(scope) >= characterAgentSkillPackageLimit) throw packageLimitError();
  }

  private packageCount(scope: CharacterAgentSkillPackageScope): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ?
    `).get(scope.characterId, scope.conversationSpace) as { count: number };
    return Number(row.count);
  }

  private findRow(
    scope: CharacterAgentSkillPackageScope,
    name: string,
  ): PackageRow | undefined {
    return this.database.connection.prepare(`
      SELECT *
      FROM character_agent_skill_packages
      WHERE character_id = ? AND conversation_space = ? AND name = ?
    `).get(scope.characterId, scope.conversationSpace, name) as PackageRow | undefined;
  }

  private requiredRow(scope: CharacterAgentSkillPackageScope, name: string): PackageRow {
    const row = this.findRow(scope, name);
    if (!row) {
      throw new AgentSkillInstallerError(
        `Skill ${name} is not installed for this character and space`,
        "SKILL_NOT_FOUND",
      );
    }
    return row;
  }

  private packageFromRow(row: PackageRow): CharacterAgentSkillPackage {
    const conversationSpace = requiredConversationSpace(row.conversation_space);
    const name = requiredSkillName(row.name);
    const manifest = parseManifest(row.manifest_json);
    const source: AgentSkillSourceMetadata = {
      requestedUrl: row.source_requested_url,
      resolvedArchiveUrl: row.source_resolved_url,
      finalArchiveUrl: row.source_final_url,
      ...(row.source_package_path ? { packagePath: row.source_package_path } : {}),
      ...(row.source_requested_ref ? { requestedRef: row.source_requested_ref } : {}),
      ...(row.source_resolved_commit ? { resolvedCommit: row.source_resolved_commit } : {}),
    };
    const integrity = this.packageIntegrity({
      characterId: row.character_id,
      conversationSpace,
      name,
      digest: row.digest,
      manifest,
      manifestValid: manifest !== undefined,
    });
    return {
      characterId: row.character_id,
      conversationSpace,
      name,
      description: row.description,
      enabled: row.enabled === 1,
      source,
      archiveSha256: row.archive_sha256,
      digest: row.digest,
      manifest: manifest ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      integrity,
    };
  }

  private packageIntegrity(input: CharacterAgentSkillPackageScope & {
    name: string;
    digest: string;
    manifest: AgentSkillManifestEntry[] | undefined;
    manifestValid: boolean;
  }): CharacterAgentSkillPackageIntegrity {
    if (!input.manifestValid || !input.manifest || !sha256Pattern.test(input.digest)) return "invalid";
    const baseDir = this.packageDirectory(input);
    if (!existsSync(baseDir)) return "missing";
    try {
      verifyAgentSkillPackage({
        rootDirectory: baseDir,
        digest: input.digest,
        manifest: input.manifest,
        ...(this.installerOptions.limits ? { limits: this.installerOptions.limits } : {}),
      });
      return "verified";
    } catch (error) {
      return error instanceof AgentSkillInstallerError && error.code === "PERSISTED_MANIFEST_INVALID"
        ? "invalid"
        : "changed";
    }
  }

  private packageDirectory(input: CharacterAgentSkillPackageScope & { name: string }): string {
    return join(this.scopeStateDirectory(input), "skills", requiredSkillName(input.name));
  }

  private scopeStateDirectory(scope: CharacterAgentSkillPackageScope): string {
    return join(
      this.packageRoot,
      createHash("sha256").update(scope.characterId).digest("hex"),
      scope.conversationSpace,
    );
  }

  private disposeInstallers(): void {
    for (const entry of this.installers.values()) entry.installer.dispose();
    this.installers.clear();
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new AgentSkillInstallerError(
        "character Skill package service is disposed",
        "INSTALLER_UNAVAILABLE",
      );
    }
  }
}

function scopeKey(scope: CharacterAgentSkillPackageScope): string {
  return `${scope.characterId.length}:${scope.characterId}:${scope.conversationSpace}`;
}

function requiredStageId(value: string): string {
  const stageId = typeof value === "string" ? value.trim() : "";
  if (!stageId || stageId !== value) {
    throw new AgentSkillInstallerError("stageId is invalid", "PACKAGE_INPUT_INVALID");
  }
  return stageId;
}

function requiredConversationSpace(value: string): ConversationSpace {
  if (value !== "normal" && value !== "secret") {
    throw new AgentSkillInstallerError(
      "persisted conversation space is invalid",
      "PERSISTED_MANIFEST_INVALID",
    );
  }
  return value;
}

function requiredSkillName(value: string): string {
  if (!skillNamePattern.test(value) || value.length > 64) {
    throw new AgentSkillInstallerError("Skill name is invalid", "PERSISTED_MANIFEST_INVALID");
  }
  return value;
}

function parseManifest(value: string): AgentSkillManifestEntry[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("invalid manifest entry");
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.path !== "string"
        || typeof record.size !== "number"
        || typeof record.sha256 !== "string"
      ) {
        throw new Error("invalid manifest entry");
      }
      return { path: record.path, size: record.size, sha256: record.sha256 };
    });
  } catch {
    return undefined;
  }
}

function requiredStateDirectory(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentSkillInstallerError(
      "a persistent state directory is required for character Skill packages",
      "INSTALLER_UNAVAILABLE",
    );
  }
  const stateDir = resolve(value);
  ensureOwnedDirectory(stateDir);
  return stateDir;
}

function ensureOwnedDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AgentSkillInstallerError(
      "character Skill package state must be a real directory",
      "UNSAFE_STATE_DIRECTORY",
    );
  }
  chmodSync(path, 0o700);
}

function assertOwnedPackageRoot(stateDir: string, packageRoot: string): void {
  const nested = relative(resolve(stateDir), resolve(packageRoot));
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`)) {
    throw new AgentSkillInstallerError(
      "character Skill package root is outside the state directory",
      "UNSAFE_REMOVE",
    );
  }
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new AgentSkillInstallerError("clock is outside the supported date range", "INVALID_CLOCK");
  }
  return value;
}

function packageLimitError(): AgentSkillInstallerError {
  return new AgentSkillInstallerError(
    `a character can install at most ${characterAgentSkillPackageLimit} private Skill packages per space`,
    "PACKAGE_LIMIT",
  );
}
