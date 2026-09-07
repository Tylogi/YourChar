import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
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

export type CharacterAgentSkillInstallInput = CharacterAgentSkillStageInput;

export type CharacterAgentSkillInstallResult = {
  package: CharacterAgentSkillPackage;
  sourceHost: string;
  finalArchiveHost: string;
  resolvedCommit?: string;
  digest: string;
  fileCount: number;
  alreadyInstalled: boolean;
};

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

export type CharacterAgentSkillUninstallInput = CharacterAgentSkillPackageScope & {
  name: string;
  digest: string;
};

export type CharacterAgentSkillUninstallResult = CharacterAgentSkillPackageScope & {
  name: string;
  digest: string;
  integrityAtRemoval: CharacterAgentSkillPackageIntegrity;
  removedAt: string;
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

type CharacterSkillUninstallJournal = {
  version: 1;
  characterId: string;
  conversationSpace: ConversationSpace;
  name: string;
  digest: string;
  sourceRelative: string;
  tombstoneName: string;
};

const sha256Pattern = /^[0-9a-f]{64}$/;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uninstallJournalNamePattern = /^uninstall-([0-9a-f-]{36})\.json$/u;
const uninstallTombstoneNamePattern = /^remove-([0-9a-f-]{36})$/u;
const orphanTombstoneNamePattern = /^orphan-([0-9a-f-]{36})$/u;

export class CharacterAgentSkillPackageService {
  private readonly database: AppDatabase;
  private readonly stateDir: string;
  private readonly packageRoot: string;
  private readonly uninstallRoot: string;
  private readonly installerOptions: Omit<AgentSkillInstallerOptions, "stateDir">;
  private readonly installers = new Map<string, ScopedInstaller>();
  private readonly installTails = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private disposed = false;

  constructor(options: CharacterAgentSkillPackageServiceOptions) {
    this.database = options.database;
    this.stateDir = requiredStateDirectory(options.stateDir);
    this.packageRoot = join(this.stateDir, "character-agent-skills");
    this.uninstallRoot = join(this.packageRoot, ".uninstall-quarantine");
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
    ensureOwnedDirectory(this.uninstallRoot);
    this.recoverUninstallJournals();
    this.reconcileOrphanPackages();
  }

  async stage(
    input: CharacterAgentSkillStageInput,
    signal?: AbortSignal,
  ): Promise<AgentSkillStageResult> {
    return this.withInstallLock(this.scope(input), () => this.stageUnlocked(input, signal));
  }

  private async stageUnlocked(
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

  /**
   * Install and enable one remote package through the same quarantined staging
   * pipeline used by the trusted control plane. Keeping this composition in
   * the package service prevents model-facing callers from choosing a stage
   * digest or bypassing any download, archive, manifest, or publish check.
   */
  async install(
    input: CharacterAgentSkillInstallInput,
    signal?: AbortSignal,
  ): Promise<CharacterAgentSkillInstallResult> {
    const scope = this.scope(input);
    return this.withInstallLock(scope, async () => {
      assertInstallNotAborted(signal);
      this.assertCharacterExists(scope.characterId);
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
      try {
        // Publishing is deliberately separated from the awaited network and
        // extraction phase so cancellation can never install a package after
        // its originating turn has been aborted.
        assertInstallNotAborted(signal);
        const existingRow = this.findRow(scope, staged.metadata.name);
        if (existingRow) {
          const existing = this.packageFromRow(existingRow);
          if (!sameInstalledSource(existing, staged)) {
            throw new AgentSkillInstallerError(
              `Skill ${staged.metadata.name} is already installed for this character and space`,
              "SKILL_EXISTS",
            );
          }
          if (existing.integrity !== "verified") {
            throw new AgentSkillInstallerError(
              `Skill ${existing.name} cannot be reused because its installed package failed integrity verification`,
              "SKILL_SOURCE_MISMATCH",
            );
          }
          const enabled = existing.enabled
            ? existing
            : this.setEnabled({ ...scope, name: existing.name, enabled: true });
          return installResult(enabled, true);
        }
        if (this.packageCount(scope) >= characterAgentSkillPackageLimit) throw packageLimitError();
        const installed = this.confirm({
          ...scope,
          stageId: staged.stageId,
          digest: staged.digest,
          enabled: true,
        });
        return installResult(installed, false);
      } catch (error) {
        // confirm() already rolls back any published bytes before throwing;
        // cancel() removes only a remaining quarantine stage.
        try {
          installer.cancel({ stageId: staged.stageId, digest: staged.digest });
        } catch {
          // Preserve the original installation error.
        }
        throw error;
      } finally {
        // Successful idempotent retries do not consume a quarantine slot.
        if (installer.getStage(staged.stageId)) {
          installer.cancel({ stageId: staged.stageId, digest: staged.digest });
        }
      }
    });
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

  async uninstall(
    input: CharacterAgentSkillUninstallInput,
  ): Promise<CharacterAgentSkillUninstallResult> {
    const scope = this.scope(input);
    return this.withInstallLock(scope, async () => {
      this.assertCharacterExists(scope.characterId);
      const name = requiredSkillName(input.name);
      const digest = requiredDigest(input.digest);
      const installed = this.packageFromRow(this.requiredRow(scope, name));
      if (installed.digest !== digest) {
        throw new AgentSkillInstallerError(
          "installed package digest does not match the uninstall request",
          "PACKAGE_DIGEST_MISMATCH",
        );
      }
      if (installed.enabled) {
        throw new AgentSkillInstallerError(
          `Skill ${name} must be disabled before it can be uninstalled`,
          "PACKAGE_ENABLED",
        );
      }
      const source = this.packageDirectory(installed);
      const sourcePresent = pathEntryExists(source);
      if (sourcePresent) {
        // Integrity failures may be the reason the user needs recovery. Move
        // only the exact top-level scoped directory without inspecting or
        // following its untrusted descendants.
        assertInstalledPackageRemovalSource(
          source,
          join(this.scopeStateDirectory(scope), "skills"),
        );
      }
      ensureOwnedDirectory(this.uninstallRoot);
      const uninstallId = sourcePresent ? randomUUID() : undefined;
      const quarantineName = uninstallId ? `remove-${uninstallId}` : undefined;
      const quarantine = quarantineName
        ? join(this.uninstallRoot, quarantineName)
        : undefined;
      const journal = quarantineName
        ? this.persistUninstallJournal({
            version: 1,
            ...scope,
            name,
            digest,
            sourceRelative: relative(this.packageRoot, source),
            tombstoneName: quarantineName,
          }, uninstallId!)
        : undefined;
      const removedAt = new Date(checkedNow(this.now)).toISOString();
      if (quarantine) {
        try {
          renameSync(source, quarantine);
          fsyncDirectory(join(this.scopeStateDirectory(scope), "skills"));
          fsyncDirectory(this.uninstallRoot);
        } catch (error) {
          try {
            if (journal) removeUninstallJournal(journal, this.uninstallRoot);
          } catch {
            // Startup recovery will clear a pre-rename journal.
          }
          throw new AgentSkillInstallerError(
            "failed to quarantine the disabled Skill before uninstall",
            "UNINSTALL_FAILED",
            { cause: error },
          );
        }
      }

      try {
        this.database.transaction(() => {
          const deleted = this.database.connection.prepare(`
            DELETE FROM character_agent_skill_packages
            WHERE character_id = ? AND conversation_space = ? AND name = ?
              AND digest = ? AND enabled = 0
          `).run(scope.characterId, scope.conversationSpace, name, digest);
          if (deleted.changes !== 1) {
            throw new Error("character Skill package row changed during uninstall");
          }
        });
      } catch (error) {
        try {
          if (quarantine && pathEntryExists(quarantine) && !pathEntryExists(source)) {
            renameSync(quarantine, source);
            fsyncDirectory(join(this.scopeStateDirectory(scope), "skills"));
            fsyncDirectory(this.uninstallRoot);
          }
        } catch (rollbackError) {
          throw new AgentSkillInstallerError(
            "failed to persist Skill uninstall and its package could not be restored",
            "UNINSTALL_ROLLBACK_FAILED",
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        try {
          if (journal) removeUninstallJournal(journal, this.uninstallRoot);
        } catch {
          // The durable journal will confirm the restored source at startup.
        }
        throw new AgentSkillInstallerError(
          "failed to persist Skill uninstall; the package was restored",
          "UNINSTALL_FAILED",
          { cause: error },
        );
      }

      // The row is already gone and the package is outside every discovery
      // root. Cleanup is best-effort and retried on the next service start.
      if (quarantine && journal) {
        try {
          removeUninstallQuarantine(quarantine, this.uninstallRoot);
          removeUninstallJournal(journal, this.uninstallRoot);
        } catch {
          // Keep the journal until startup can observe the committed DB state
          // and safely finish the inaccessible tombstone.
        }
      }
      return {
        ...scope,
        name,
        digest,
        integrityAtRemoval: installed.integrity,
        removedAt,
      };
    });
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

  isCharacterBusy(characterId: string): boolean {
    return (["normal", "secret"] as const).some(conversationSpace =>
      this.installTails.has(scopeKey({ characterId, conversationSpace })));
  }

  assertCharacterDeletable(characterId: string): void {
    this.assertAvailable();
    this.assertCharacterExists(characterId);
    if (this.isCharacterBusy(characterId)) throw new Error("角色 Skill 正在安装，请稍后再删除角色");
    assertOwnedPackageRoot(this.stateDir, this.packageRoot);
    const ownerPath = join(this.packageRoot, createHash("sha256").update(characterId).digest("hex"));
    if (pathEntryExists(ownerPath) && !realDirectoryAtExactPath(ownerPath)) {
      throw new AgentSkillInstallerError("角色 Skill 目录不安全，无法删除", "UNSAFE_STATE_DIRECTORY");
    }
  }

  deleteCharacter(characterId: string): void {
    this.assertCharacterDeletable(characterId);
    const ownerPath = join(this.packageRoot, createHash("sha256").update(characterId).digest("hex"));
    for (const [key, entry] of this.installers) {
      if (entry.characterId !== characterId) continue;
      entry.installer.dispose();
      this.installers.delete(key);
    }
    rmSync(ownerPath, { recursive: true, force: true });
    this.database.connection.prepare("DELETE FROM character_agent_skill_packages WHERE character_id = ?").run(characterId);
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
    ensureOwnedDirectory(this.uninstallRoot);
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

  private async withInstallLock<T>(
    scope: CharacterAgentSkillPackageScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = scopeKey(scope);
    const previous = this.installTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((resolveOwned) => {
      release = resolveOwned;
    });
    const tail = previous.catch(() => undefined).then(() => owned);
    this.installTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.installTails.get(key) === tail) this.installTails.delete(key);
    }
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

  private persistUninstallJournal(
    journal: CharacterSkillUninstallJournal,
    uninstallId: string,
  ): string {
    const path = join(this.uninstallRoot, `uninstall-${uninstallId}.json`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(journal)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(this.uninstallRoot);
      return path;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (pathEntryExists(path)) rmSync(path, { force: true });
      throw new AgentSkillInstallerError(
        "failed to persist the Skill uninstall recovery journal",
        "UNINSTALL_FAILED",
        { cause: error },
      );
    }
  }

  private recoverUninstallJournals(): void {
    for (const entry of readdirSync(this.uninstallRoot, { withFileTypes: true })) {
      if (!uninstallJournalNamePattern.test(entry.name)) continue;
      const journalPath = join(this.uninstallRoot, entry.name);
      try {
        const journal = readUninstallJournal(
          journalPath,
          this.packageRoot,
          this.uninstallRoot,
        );
        const scope = {
          characterId: journal.characterId,
          conversationSpace: journal.conversationSpace,
        };
        const source = join(this.packageRoot, journal.sourceRelative);
        const tombstone = join(this.uninstallRoot, journal.tombstoneName);
        const skillsRoot = join(this.scopeStateDirectory(scope), "skills");
        const row = this.findRow(scope, journal.name);
        if (row && row.digest !== journal.digest) continue;
        const sourcePresent = pathEntryExists(source);
        const tombstonePresent = pathEntryExists(tombstone);
        if (row) {
          if (sourcePresent && tombstonePresent) continue;
          if (tombstonePresent) {
            if (!realDirectoryAtExactPath(skillsRoot)) continue;
            assertUninstallQuarantineDirectory(tombstone, this.uninstallRoot);
            renameSync(tombstone, source);
            fsyncDirectory(skillsRoot);
            fsyncDirectory(this.uninstallRoot);
          } else if (sourcePresent) {
            assertInstalledPackageRemovalSource(
              source,
              skillsRoot,
            );
          } else {
            continue;
          }
        } else {
          if (sourcePresent && tombstonePresent) continue;
          if (sourcePresent) {
            assertInstalledPackageRemovalSource(
              source,
              skillsRoot,
            );
            renameSync(source, tombstone);
            fsyncDirectory(skillsRoot);
            fsyncDirectory(this.uninstallRoot);
          }
          if (pathEntryExists(tombstone)) {
            removeUninstallQuarantine(tombstone, this.uninstallRoot);
          }
        }
        removeUninstallJournal(journalPath, this.uninstallRoot);
      } catch {
        // Preserve ambiguous state for manual repair instead of deleting a
        // directory that may still be referenced by the durable row.
      }
    }
  }

  private reconcileOrphanPackages(): void {
    const expected = new Set<string>();
    const rows = this.database.connection.prepare(`
      SELECT character_id, conversation_space, name
      FROM character_agent_skill_packages
    `).all() as Array<{ character_id: string; conversation_space: string; name: string }>;
    for (const row of rows) {
      try {
        expected.add(this.packageDirectory({
          characterId: row.character_id,
          conversationSpace: requiredConversationSpace(row.conversation_space),
          name: requiredSkillName(row.name),
        }));
      } catch {
        // Invalid rows are preserved for explicit trusted repair.
      }
    }

    for (const entry of readdirSync(this.uninstallRoot, { withFileTypes: true })) {
      if (!orphanTombstoneNamePattern.test(entry.name)) continue;
      try {
        removeOrphanQuarantine(join(this.uninstallRoot, entry.name), this.uninstallRoot);
      } catch {
        // Keep suspicious entries isolated.
      }
    }

    for (const owner of readdirSync(this.packageRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f]{64}$/u.test(owner.name)) continue;
      const ownerPath = join(this.packageRoot, owner.name);
      if (!realDirectoryAtExactPath(ownerPath)) continue;
      for (const space of ["normal", "secret"] as const) {
        const skillsRoot = join(ownerPath, space, "skills");
        if (!pathEntryExists(skillsRoot) || !realDirectoryAtExactPath(skillsRoot)) continue;
        for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
          if (!skillNamePattern.test(skill.name) || skill.name.length > 64) continue;
          const path = join(skillsRoot, skill.name);
          if (expected.has(path) || !realDirectoryAtExactPath(path)) continue;
          const quarantine = join(this.uninstallRoot, `orphan-${randomUUID()}`);
          try {
            renameSync(path, quarantine);
            fsyncDirectory(skillsRoot);
            fsyncDirectory(this.uninstallRoot);
            removeOrphanQuarantine(quarantine, this.uninstallRoot);
          } catch {
            // Leave an ambiguous package isolated in place for manual repair.
          }
        }
      }
    }
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

function sameInstalledSource(
  installed: CharacterAgentSkillPackage,
  staged: AgentSkillStageResult,
): boolean {
  return installed.name === staged.metadata.name &&
    installed.digest === staged.digest &&
    installed.source.requestedUrl === staged.source.requestedUrl &&
    (installed.source.packagePath ?? "") === (staged.source.packagePath ?? "");
}

function installResult(
  installed: CharacterAgentSkillPackage,
  alreadyInstalled: boolean,
): CharacterAgentSkillInstallResult {
  return {
    package: installed,
    sourceHost: new URL(installed.source.requestedUrl).hostname,
    finalArchiveHost: new URL(installed.source.finalArchiveUrl).hostname,
    ...(installed.source.resolvedCommit
      ? { resolvedCommit: installed.source.resolvedCommit }
      : {}),
    digest: installed.digest,
    fileCount: installed.manifest.length,
    alreadyInstalled,
  };
}

function assertInstallNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new AgentSkillInstallerError(
    "Skill installation was cancelled before publication",
    "REQUEST_ABORTED",
    signal.reason === undefined ? undefined : { cause: signal.reason },
  );
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

function requiredDigest(value: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AgentSkillInstallerError("package digest is invalid", "PACKAGE_INPUT_INVALID");
  }
  return value;
}

function assertInstalledPackageRemovalSource(source: string, skillsRoot: string): void {
  const resolvedRoot = resolve(skillsRoot);
  const resolvedSource = resolve(source);
  const nested = relative(resolvedRoot, resolvedSource);
  if (!nested || nested.includes(sep) || nested === ".." || nested.startsWith(`..${sep}`)) {
    throw new AgentSkillInstallerError(
      "refusing to uninstall a package outside its scoped Skill root",
      "UNSAFE_REMOVE",
    );
  }
  try {
    const rootStats = lstatSync(resolvedRoot);
    const sourceStats = lstatSync(resolvedSource);
    if (
      rootStats.isSymbolicLink() || !rootStats.isDirectory() ||
      sourceStats.isSymbolicLink() || !sourceStats.isDirectory() ||
      realpathSync(resolvedRoot) !== resolvedRoot ||
      realpathSync(resolvedSource) !== resolvedSource
    ) {
      throw new Error("package removal path is not a real directory");
    }
  } catch (error) {
    if (error instanceof AgentSkillInstallerError) throw error;
    throw new AgentSkillInstallerError(
      "installed Skill package is not safe to remove",
      "UNSAFE_REMOVE",
      { cause: error },
    );
  }
}

function removeUninstallQuarantine(path: string, uninstallRoot: string): void {
  assertUninstallQuarantineDirectory(path, uninstallRoot);
  if (!pathEntryExists(path)) return;
  rmSync(path, { recursive: true, force: false });
  fsyncDirectory(uninstallRoot);
}

function assertUninstallQuarantineDirectory(path: string, uninstallRoot: string): void {
  const root = resolve(uninstallRoot);
  const candidate = resolve(path);
  const nested = relative(root, candidate);
  if (
    !uninstallTombstoneNamePattern.test(nested) ||
    nested.includes(sep) ||
    realpathSync(root) !== root
  ) {
    throw new AgentSkillInstallerError(
      "refusing to remove a path outside uninstall quarantine",
      "UNSAFE_REMOVE",
    );
  }
  if (!pathEntryExists(candidate)) return;
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(candidate) !== candidate) {
    throw new AgentSkillInstallerError(
      "uninstall quarantine entry must be a real directory",
      "UNSAFE_REMOVE",
    );
  }
}

function removeOrphanQuarantine(path: string, uninstallRoot: string): void {
  const root = resolve(uninstallRoot);
  const candidate = resolve(path);
  const nested = relative(root, candidate);
  if (
    !orphanTombstoneNamePattern.test(nested) ||
    nested.includes(sep) ||
    realpathSync(root) !== root ||
    !realDirectoryAtExactPath(candidate)
  ) {
    throw new AgentSkillInstallerError(
      "orphan quarantine entry is unsafe",
      "UNSAFE_REMOVE",
    );
  }
  rmSync(candidate, { recursive: true, force: false });
  fsyncDirectory(root);
}

function readUninstallJournal(
  path: string,
  packageRoot: string,
  uninstallRoot: string,
): CharacterSkillUninstallJournal {
  const root = resolve(uninstallRoot);
  const journalPath = resolve(path);
  const journalName = relative(root, journalPath);
  const nameMatch = uninstallJournalNamePattern.exec(journalName);
  if (!nameMatch || journalName.includes(sep) || realpathSync(root) !== root) {
    throw new AgentSkillInstallerError("uninstall journal path is unsafe", "UNSAFE_REMOVE");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 2 || stats.size > 16 * 1024) {
      throw new Error("uninstall journal is not a bounded regular file");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("uninstall journal is invalid");
    }
    const record = parsed as Record<string, unknown>;
    const characterId = typeof record.characterId === "string" ? record.characterId : "";
    if (!characterId || characterId.trim() !== characterId || characterId.length > 300) {
      throw new Error("uninstall journal character is invalid");
    }
    const conversationSpace = requiredConversationSpace(String(record.conversationSpace));
    const name = requiredSkillName(String(record.name));
    const digest = requiredDigest(String(record.digest));
    const tombstoneName = String(record.tombstoneName);
    if (
      record.version !== 1 ||
      !uninstallTombstoneNamePattern.test(tombstoneName) ||
      uninstallTombstoneNamePattern.exec(tombstoneName)?.[1] !== nameMatch[1]
    ) {
      throw new Error("uninstall journal identity is invalid");
    }
    const sourceRelative = String(record.sourceRelative);
    const expectedRelative = relative(resolve(packageRoot), join(
      resolve(packageRoot),
      createHash("sha256").update(characterId).digest("hex"),
      conversationSpace,
      "skills",
      name,
    ));
    if (sourceRelative !== expectedRelative || sourceRelative.startsWith(`..${sep}`)) {
      throw new Error("uninstall journal source is invalid");
    }
    return {
      version: 1,
      characterId,
      conversationSpace,
      name,
      digest,
      sourceRelative,
      tombstoneName,
    };
  } catch (error) {
    if (error instanceof AgentSkillInstallerError) throw error;
    throw new AgentSkillInstallerError(
      "uninstall recovery journal is invalid",
      "UNINSTALL_RECOVERY_REQUIRED",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeUninstallJournal(path: string, uninstallRoot: string): void {
  const root = resolve(uninstallRoot);
  const candidate = resolve(path);
  const nested = relative(root, candidate);
  if (
    !uninstallJournalNamePattern.test(nested) ||
    nested.includes(sep) ||
    realpathSync(root) !== root
  ) {
    throw new AgentSkillInstallerError("uninstall journal path is unsafe", "UNSAFE_REMOVE");
  }
  if (!pathEntryExists(candidate)) return;
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AgentSkillInstallerError("uninstall journal is unsafe", "UNSAFE_REMOVE");
  }
  rmSync(candidate, { force: false });
  fsyncDirectory(root);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function realDirectoryAtExactPath(path: string): boolean {
  try {
    const resolved = resolve(path);
    const stats = lstatSync(resolved);
    return stats.isDirectory() && !stats.isSymbolicLink() && realpathSync(resolved) === resolved;
  } catch {
    return false;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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
