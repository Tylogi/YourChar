import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import { UserProfileValidationError } from "../profile/service.js";
import type { UserProfileDocument } from "../profile/types.js";
import type { RpMemory, SceneState } from "../rp/types.js";
import {
  CHARACTER_SOUL_MAX_CHARACTERS,
  CharacterSoulValidationError,
  type CharacterSoulDocument,
} from "../rp/soul.js";
import { USER_PROFILE_MAX_CHARACTERS } from "../profile/types.js";
import { hashVaultBody, serializeVaultMarkdown } from "./codec.js";
import { MemoryVaultError } from "./errors.js";
import { relativePathForMetadata } from "./paths.js";
import { MemoryVaultProjection, type MemoryVaultRebuildResult } from "./projection.js";
import { MemoryVaultStore } from "./store.js";
import {
  createJournalSnapshot,
  MemoryVaultJournal,
  type SnapshotData,
  type VaultJournalOperation,
  type VaultMirrorEntry,
} from "./journal.js";
import { MemoryVaultWriterLock } from "./writer-lock.js";
import {
  durableAtomicWrite,
  fsyncDirectory,
  isSimulatedCrash,
  type MemoryVaultFailpoint,
} from "./durability.js";
import {
  MEMORY_VAULT_SCHEMA_VERSION,
  type LegacyVaultSnapshot,
  type MemoryVaultStatus,
  type PersonProfile,
  type VaultCas,
  type VaultDocument,
  type VaultDocumentSummary,
  type VaultFrontmatter,
  type VaultMigrationManifest,
  type UpdatePersonProfileInput,
  type VaultWriteInput,
} from "./types.js";

export const PERSON_PROFILE_MAX_CHARACTERS = 8_000;
const PERSON_CONTEXT_MAX_CHARACTERS = 180;
const PERSON_FACTS_START = "<!-- rp-agent:person-facts:start -->";
const PERSON_FACTS_END = "<!-- rp-agent:person-facts:end -->";

export type MemoryVaultServiceOptions = {
  database: AppDatabase;
  clock: Clock;
  stateDir?: string;
  onAutomaticSync?: (event: {
    documentCount: number;
    externalModifiedPaths: string[];
    vaultHash: string;
  }) => void;
  failpoint?: MemoryVaultFailpoint;
};

export class MemoryVaultService {
  readonly store: MemoryVaultStore;
  private readonly projection: MemoryVaultProjection;
  private readonly manifestPath?: string;
  private readonly projectionStatePath?: string;
  private readonly backupStatusPath?: string;
  private readonly writer: MemoryVaultWriterLock;
  private readonly journal: MemoryVaultJournal;
  private activeOperation?: VaultJournalOperation;
  private startupRecoveryCount = 0;
  private memoryManifest?: VaultMigrationManifest;
  private legacySource?: () => LegacyVaultSnapshot;

  constructor(private readonly options: MemoryVaultServiceOptions) {
    if (options.stateDir) mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.writer = new MemoryVaultWriterLock(options.database, options.stateDir);
    try {
      this.store = new MemoryVaultStore(options.stateDir, options.failpoint, () => this.writer.renewAndAssert());
      this.projectionStatePath = options.stateDir ? join(options.stateDir, "memory-vault-state.json") : undefined;
      this.projection = new MemoryVaultProjection(
        options.database,
        this.projectionStatePath,
        {
          beforeProjectionCommit: () => this.beforeProjectionCommit(),
          afterProjectionCommit: () => this.afterProjectionCommit(),
          beforeStateCommit: () => this.beforeStateCommit(),
          afterStateCommit: () => this.afterStateCommit(),
          failpoint: options.failpoint,
          beforeDurableCommit: () => this.writer.renewAndAssert(),
        },
      );
      this.manifestPath = options.stateDir ? join(options.stateDir, "memory-vault-migration.json") : undefined;
      this.backupStatusPath = options.stateDir ? join(options.stateDir, "memory-vault-backup-status.json") : undefined;
      this.journal = new MemoryVaultJournal(options.stateDir, options.clock, this.writer, options.failpoint);
      const recovery = this.journal.recoverPending({
        restore: (snapshot) => this.restoreSnapshot(snapshot),
        rebuild: () => { this.rebuildDocuments(this.store.list()); },
        alignMirrors: () => this.alignCompatibilityMirrors(),
      });
      this.startupRecoveryCount = recovery.recovered;
      this.alignCompatibilityMirrors();
    } catch (error) {
      this.writer.release();
      throw error;
    }
  }

  setLegacySource(source: () => LegacyVaultSnapshot): void {
    this.legacySource = source;
  }

  ensureMigrated(): VaultMigrationManifest {
    const existing = this.readManifest();
    if (existing?.status === "complete") {
      this.rebuild();
      return existing;
    }
    return this.applyMigration();
  }

  migrationDryRun(): VaultMigrationManifest {
    const manifest = this.buildManifest(this.snapshot());
    this.writeManifest(manifest);
    return manifest;
  }

  applyMigration(): VaultMigrationManifest {
    const snapshot = this.snapshot();
    const documents = migrationDocuments(snapshot);
    const manifest = this.buildManifest(snapshot);
    manifest.status = "in_progress";
    manifest.updatedAt = this.now();
    this.writeManifest(manifest);
    try {
      this.atomicMutation("migration_apply", `migration:${manifest.sourceHash}`, () => {
        const byId = new Map(documents.map((document) => [document.metadata.id, document]));
        for (const item of manifest.items) {
          if (item.action === "create") this.store.import(byId.get(item.id)!);
          manifest.completedIds = [...new Set([...manifest.completedIds, item.id])].sort();
          manifest.updatedAt = this.now();
          this.writeManifest(manifest);
        }
        this.rebuildDocuments(this.store.list());
      });
      manifest.status = "complete";
      manifest.updatedAt = this.now();
      delete manifest.error;
      this.writeManifest(manifest);
      return manifest;
    } catch (error) {
      manifest.status = "failed";
      manifest.updatedAt = this.now();
      manifest.error = error instanceof Error ? error.message : String(error);
      this.writeManifest(manifest);
      throw new MemoryVaultError(`vault migration failed: ${manifest.error}`, "MEMORY_VAULT_MIGRATION_FAILED");
    }
  }

  status(): MemoryVaultStatus {
    const documents = this.store.list();
    const vaultHash = this.store.hash(documents);
    const projection = this.projection.readState();
    const manifest = this.readManifest();
    const counts: MemoryVaultStatus["counts"] = {
      user_profile: 0,
      person_profile: 0,
      character_soul: 0,
      scene: 0,
      memory: 0,
    };
    for (const document of documents) counts[document.metadata.kind] += 1;
    return {
      available: Boolean(this.store.rootPath),
      ...(this.store.rootPath ? { rootPath: this.store.rootPath } : {}),
      documentCount: documents.length,
      counts,
      vaultHash,
      ...(projection ? { projectionHash: projection.vaultHash, lastRebuiltAt: projection.rebuiltAt } : {}),
      inSync: Boolean(projection && projection.vaultHash === vaultHash && !documents.some((entry) => entry.externalModified)),
      externalModifiedCount: documents.filter((entry) => entry.externalModified).length,
      migrationStatus: manifest?.status ?? (documents.length ? "complete" : "not_required"),
    };
  }

  list(): VaultDocumentSummary[] {
    return this.store.summaries();
  }

  documentsForInterchange(): VaultDocument[] {
    this.syncIfChanged();
    return this.store.list().map((document) => ({
      ...document,
      metadata: {
        ...document.metadata,
        tags: [...document.metadata.tags],
        quarantineReasons: [...document.metadata.quarantineReasons],
        ...(document.metadata.confirmationProvenance ? {
          confirmationProvenance: { ...document.metadata.confirmationProvenance },
        } : {}),
        ...(document.metadata.scene ? {
          scene: {
            ...document.metadata.scene,
            participants: [...document.metadata.scene.participants],
            openThreads: [...document.metadata.scene.openThreads],
          },
        } : {}),
        aliases: [...document.metadata.aliases],
        visibleToCharacterIds: [...document.metadata.visibleToCharacterIds],
        sourceMemoryIds: [...document.metadata.sourceMemoryIds],
      },
    }));
  }

  sync(): MemoryVaultRebuildResult {
    return this.atomicMutation("vault_sync", `sync:${this.now()}`, () => {
      const documents = this.store.normalizeExternalEdits(this.now());
      return this.rebuildDocuments(documents);
    });
  }

  rebuild(): MemoryVaultRebuildResult {
    return this.atomicMutation("projection_rebuild", `rebuild:${this.store.hash()}`, () =>
      this.rebuildDocuments(this.store.list()));
  }

  syncIfChanged(): void {
    const documents = this.store.list();
    const hash = this.store.hash(documents);
    if (this.projection.readState()?.vaultHash !== hash || documents.some((entry) => entry.externalModified)) {
      const externalModifiedPaths = documents
        .filter((entry) => entry.externalModified)
        .map((entry) => entry.relativePath)
        .sort();
      const result = this.atomicMutation("automatic_sync", `auto-sync:${hash}`, () => {
        const normalized = documents.some((entry) => entry.externalModified)
          ? this.store.normalizeExternalEdits(this.now())
          : documents;
        return this.rebuildDocuments(normalized);
      });
      this.options.onAutomaticSync?.({
        documentCount: result.documentCount,
        externalModifiedPaths,
        vaultHash: result.vaultHash,
      });
    }
  }

  getProfile(): UserProfileDocument | undefined {
    const document = this.store.get("user-profile");
    if (!document) return undefined;
    return {
      realm: "reality",
      scope: "global",
      markdown: document.body,
      characterCount: [...document.body].length,
      maxCharacters: USER_PROFILE_MAX_CHARACTERS,
      updatedAt: document.metadata.updatedAt,
    };
  }

  writeProfile(markdown: string, cas: VaultCas = {}): UserProfileDocument {
    const now = this.now();
    const existing = this.store.get("user-profile");
    const input: VaultWriteInput = {
      metadata: baseMetadata({
        id: "user-profile",
        kind: "user_profile",
        realm: "reality",
        scope: "global",
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
      }),
      body: markdown,
    };
    this.atomicMutation("profile_write", `profile:${createHash("sha256").update(markdown).digest("hex")}`, () => {
      this.store.write(input, this.casForWrite(existing, input.metadata, cas));
      this.rebuildDocuments(this.store.list());
    });
    return this.getProfile()!;
  }

  deleteProfile(): void {
    if (!this.store.get("user-profile")) return;
    this.atomicMutation("profile_delete", "profile:user-profile:delete", () => {
      this.store.remove("user-profile");
      this.rebuildDocuments(this.store.list());
    });
  }

  listPersonProfiles(): PersonProfile[] {
    this.syncIfChanged();
    return this.store.getByKind("person_profile")
      .map(personProfileFromDocument)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  getPersonProfile(id: string): PersonProfile | undefined {
    this.syncIfChanged();
    const document = this.store.get(id);
    return document?.metadata.kind === "person_profile" ? personProfileFromDocument(document) : undefined;
  }

  updatePersonProfile(id: string, patch: UpdatePersonProfileInput): PersonProfile {
    this.syncIfChanged();
    const existing = this.store.get(id);
    if (!existing || existing.metadata.kind !== "person_profile") {
      throw new MemoryVaultError(`person profile not found: ${id}`, "MEMORY_VAULT_INVALID_DOCUMENT");
    }
    const displayName = patch.displayName === undefined
      ? existing.metadata.displayName!
      : cleanPersonField(patch.displayName, "displayName", 80);
    const aliases = patch.aliases === undefined
      ? existing.metadata.aliases
      : cleanPersonList(patch.aliases, "aliases", 20, 80);
    const relationship = patch.relationship === undefined
      ? existing.metadata.relationship
      : patch.relationship === null || !patch.relationship.trim()
        ? null
        : cleanPersonField(patch.relationship, "relationship", 120);
    const visibility = patch.visibility ?? existing.metadata.visibility!;
    const requestedCharacterIds = patch.visibleToCharacterIds ?? existing.metadata.visibleToCharacterIds;
    const visibleToCharacterIds = visibility === "global"
      ? []
      : validateVisibleCharacterIds(this.options.database, requestedCharacterIds);
    const markdown = patch.markdown === undefined ? existing.body : patch.markdown.replace(/\r\n?/g, "\n");
    assertPersonProfileWithinLimit(markdown);
    const now = this.now();
    const input: VaultWriteInput = {
      metadata: {
        ...stripGenerated(existing.metadata),
        displayName,
        aliases,
        relationship,
        visibility,
        visibleToCharacterIds,
        updatedAt: now,
      },
      body: markdown,
    };
    this.atomicMutation("person_profile_write", `person-profile:${id}:${createHash("sha256").update(JSON.stringify(patch)).digest("hex")}`, () => {
      this.store.write(input, this.casForWrite(existing, input.metadata));
      this.rebuildDocuments(this.store.list());
    });
    return this.getPersonProfile(id)!;
  }

  ensurePersonProfiles(): number {
    this.syncIfChanged();
    return this.atomicMutation("person_profiles_ensure", `person-profiles:${this.store.hash()}`, () => {
      const changed = this.syncPersonProfileDocuments();
      if (changed) this.rebuildDocuments(this.store.list());
      return changed;
    });
  }

  contextualizeRealityMemories(memories: RpMemory[], viewerCharacterId?: string, query = ""): RpMemory[] {
    this.syncIfChanged();
    const profiles = new Map(this.store.getByKind("person_profile").map((document) => [
      normalizePersonKey(document.metadata.personKey!),
      document,
    ]));
    return memories.flatMap((memory) => {
      if (memory.realm !== "reality" || memory.type !== "person") return [memory];
      const profile = profiles.get(normalizePersonKey(personKeyForMemory(memory)));
      if (!profile) return [memory];
      if (
        profile.metadata.visibility === "selected_characters" &&
        (!viewerCharacterId || !profile.metadata.visibleToCharacterIds.includes(viewerCharacterId))
      ) return [];
      const profileText = boundedPersonContext(profile, query);
      return [{
        ...memory,
        content: profileText,
        normalizedContent: normalizePersonContent(profileText),
      }];
    });
  }

  getSoul(characterId: string): CharacterSoulDocument | undefined {
    const document = this.store.getByKind("character_soul").find(
      (entry) => entry.metadata.characterId === characterId,
    );
    if (!document) return undefined;
    return {
      markdown: document.body,
      characterCount: [...document.body].length,
      maxCharacters: CHARACTER_SOUL_MAX_CHARACTERS,
    };
  }

  writeSoul(characterId: string, markdown: string, timestamps?: { createdAt: string; updatedAt: string }): CharacterSoulDocument {
    const id = `soul_${characterId}`;
    const existing = this.store.get(id);
    const now = this.now();
    const input: VaultWriteInput = {
      metadata: baseMetadata({
        id,
        kind: "character_soul",
        realm: "roleplay",
        scope: "character",
        characterId,
        createdAt: existing?.metadata.createdAt ?? timestamps?.createdAt ?? now,
        updatedAt: timestamps?.updatedAt ?? now,
      }),
      body: markdown,
    };
    this.atomicMutation("soul_write", `soul:${characterId}:${createHash("sha256").update(markdown).digest("hex")}`, () => {
      this.store.write(input, this.casForWrite(existing, input.metadata));
      this.rebuildDocuments(this.store.list());
    });
    return this.getSoul(characterId)!;
  }

  deleteSoul(characterId: string): void {
    const document = this.store.getByKind("character_soul").find((entry) => entry.metadata.characterId === characterId);
    if (!document) return;
    this.atomicMutation("soul_delete", `soul:${characterId}:delete`, () => {
      this.store.remove(document.metadata.id);
      this.rebuildDocuments(this.store.list());
    });
  }

  clearSouls(): void {
    const ids = this.store.getByKind("character_soul").map((document) => document.metadata.id);
    if (!ids.length) return;
    this.atomicMutation("souls_clear", `souls:clear:${ids.sort().join(",")}`, () => {
      for (const id of ids) this.store.remove(id);
      this.rebuildDocuments(this.store.list());
    });
  }

  getScene(sessionId: string): SceneState | undefined {
    const document = this.store.getByKind("scene").find((entry) => entry.metadata.sessionId === sessionId);
    if (!document) return undefined;
    const scene = document.metadata.scene!;
    return {
      roleSessionId: sessionId,
      ...(scene.location === null ? {} : { location: scene.location }),
      ...(scene.inWorldTime === null ? {} : { inWorldTime: scene.inWorldTime }),
      participants: scene.participants,
      ...(scene.currentObjective === null ? {} : { currentObjective: scene.currentObjective }),
      openThreads: scene.openThreads,
      summary: document.body,
      updatedAt: document.metadata.updatedAt,
    };
  }

  listScenes(): SceneState[] {
    return this.store.getByKind("scene")
      .map((document) => this.getScene(document.metadata.sessionId!)!)
      .sort((left, right) => left.roleSessionId.localeCompare(right.roleSessionId));
  }

  writeScene(scene: SceneState, characterId: string, idempotencyKey?: string): SceneState {
    const id = `scene_${scene.roleSessionId}`;
    const existing = this.store.get(id);
    const input: VaultWriteInput = {
      metadata: baseMetadata({
        id,
        kind: "scene",
        realm: "roleplay",
        scope: "session",
        characterId,
        sessionId: scene.roleSessionId,
        createdAt: existing?.metadata.createdAt ?? scene.updatedAt,
        updatedAt: scene.updatedAt,
        idempotencyKey: idempotencyKey ?? null,
        scene: {
          location: scene.location ?? null,
          inWorldTime: scene.inWorldTime ?? null,
          participants: scene.participants,
          currentObjective: scene.currentObjective ?? null,
          openThreads: scene.openThreads,
        },
      }),
      body: sceneMarkdown(scene),
    };
    this.atomicMutation("scene_write", idempotencyKey ?? `scene:${scene.roleSessionId}:${scene.updatedAt}`, () => {
      this.store.write(input, this.casForWrite(existing, input.metadata));
      this.rebuildDocuments(this.store.list());
    });
    return this.getScene(scene.roleSessionId)!;
  }

  removeScene(sessionId: string): boolean {
    const document = this.store.getByKind("scene").find((entry) => entry.metadata.sessionId === sessionId);
    if (!document) return false;
    return this.atomicMutation("scene_remove", `scene:${sessionId}:remove`, () => {
      const removed = this.store.remove(document.metadata.id);
      if (removed) this.rebuildDocuments(this.store.list());
      return removed;
    });
  }

  writeMemory(memory: RpMemory, idempotencyKey?: string, supersedes?: string): RpMemory {
    const existing = this.store.get(memory.id);
    const input = memoryInput(
      memory,
      idempotencyKey ?? existing?.metadata.idempotencyKey ?? undefined,
      supersedes ?? existing?.metadata.supersedes ?? undefined,
    );
    this.atomicMutation("memory_write", idempotencyKey ?? existing?.metadata.idempotencyKey ?? `memory:${memory.id}:${memory.updatedAt}`, () => {
      this.store.write(input, this.casForWrite(existing, input.metadata));
      this.syncPersonProfileDocuments();
      this.rebuildDocuments(this.store.list());
    });
    return this.readMemory(memory.id)!;
  }

  writeMemoryPair(memory: RpMemory, previous: RpMemory, idempotencyKey?: string): RpMemory {
    const previousDocument = this.store.get(previous.id);
    if (!previousDocument) throw new MemoryVaultError(`missing superseded memory ${previous.id}`, "MEMORY_VAULT_INVALID_DOCUMENT");
    const previousInput = memoryInput(
      previous,
      previousDocument.metadata.idempotencyKey ?? undefined,
      previousDocument.metadata.supersedes ?? undefined,
    );
    const nextInput = memoryInput(memory, idempotencyKey, previous.id);
    this.atomicMutation("memory_pair_write", idempotencyKey ?? `memory-pair:${previous.id}:${memory.id}`, () => {
      this.store.write(previousInput, this.casForWrite(previousDocument, previousInput.metadata));
      this.store.write(nextInput, this.casForWrite(undefined, nextInput.metadata));
      this.syncPersonProfileDocuments();
      this.rebuildDocuments(this.store.list());
    });
    return this.readMemory(memory.id)!;
  }

  writeMemoriesAtomically(
    entries: Array<{ memory: RpMemory; idempotencyKey?: string; supersedes?: string }>,
    profileMarkdown?: string,
  ): RpMemory[] {
    if (!entries.length) return [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.memory.id)) {
        throw new MemoryVaultError(`duplicate atomic memory id ${entry.memory.id}`, "MEMORY_VAULT_DUPLICATE_ID");
      }
      seen.add(entry.memory.id);
    }
    this.atomicMutation("memory_batch_write", `memory-batch:${entries.map((entry) => entry.idempotencyKey ?? entry.memory.id).sort().join(",")}`, () => {
      for (const entry of entries) {
        const existing = this.store.get(entry.memory.id);
        const input = memoryInput(
          entry.memory,
          entry.idempotencyKey ?? existing?.metadata.idempotencyKey ?? undefined,
          entry.supersedes ?? existing?.metadata.supersedes ?? undefined,
        );
        this.store.write(input, this.casForWrite(existing, input.metadata));
      }
      if (profileMarkdown !== undefined) {
        assertProfileWithinLimit(profileMarkdown);
        const existingProfile = this.store.get("user-profile");
        const now = this.now();
        const profileInput: VaultWriteInput = {
          metadata: baseMetadata({
            id: "user-profile",
            kind: "user_profile",
            realm: "reality",
            scope: "global",
            createdAt: existingProfile?.metadata.createdAt ?? now,
            updatedAt: now,
          }),
          body: profileMarkdown,
        };
        this.store.write(profileInput, this.casForWrite(existingProfile, profileInput.metadata));
      }
      this.syncPersonProfileDocuments();
      this.rebuildDocuments(this.store.list());
    });
    return entries.map((entry) => this.readMemory(entry.memory.id)!);
  }

  readMemory(id: string): RpMemory | undefined {
    const document = this.store.get(id);
    if (!document || document.metadata.kind !== "memory") return undefined;
    const successor = this.store.getByKind("memory").find((entry) => entry.metadata.supersedes === id)?.metadata.id;
    return memoryFromDocument(document, successor);
  }

  touchMemories(ids: string[]): void {
    const now = this.now();
    const documents = ids
      .map((id) => this.store.get(id))
      .filter((document): document is VaultDocument => document?.metadata.kind === "memory");
    if (!documents.length) return;
    this.atomicMutation("memory_touch", `memory-touch:${now}:${documents.map((entry) => entry.metadata.id).sort().join(",")}`, () => {
      for (const document of documents) {
        this.store.write({
          metadata: { ...stripGenerated(document.metadata), lastUsedAt: now, updatedAt: document.metadata.updatedAt },
          body: document.body,
        }, this.casForWrite(document, document.metadata));
      }
      this.rebuildDocuments(this.store.list());
    });
  }

  deleteAll(): number {
    return this.atomicMutation("vault_delete_all", `vault-delete-all:${this.now()}`, () => {
      const count = this.store.deleteAll();
      this.rebuildDocuments(this.store.list());
      if (this.manifestPath) {
        this.writer.renewAndAssert();
        rmSync(this.manifestPath, { force: true });
        fsyncDirectory(dirname(this.manifestPath));
      }
      this.memoryManifest = undefined;
      return count;
    });
  }

  health(): {
    writer: ReturnType<MemoryVaultWriterLock["health"]>;
    journal: ReturnType<MemoryVaultJournal["health"]>;
    startupRecoveryCount: number;
    projectionConsistent: boolean;
    vaultHash: string;
    projectionHash: string | null;
    backup: { generatedAt: string | null; verifiedAt: string | null; valid: boolean | null };
  } {
    const documents = this.store.list();
    const vaultHash = this.store.hash(documents);
    const projectionHash = this.projection.readState()?.vaultHash ?? null;
    return {
      writer: this.writer.health(),
      journal: this.journal.health(),
      startupRecoveryCount: this.startupRecoveryCount,
      projectionConsistent: projectionHash === vaultHash && !documents.some((entry) => entry.externalModified),
      vaultHash,
      projectionHash,
      backup: this.readBackupStatus(),
    };
  }

  dispose(): void {
    this.writer.release();
  }

  private rebuildDocuments(documents: VaultDocument[]): MemoryVaultRebuildResult {
    const byId = new Map(documents.map((document) => [document.metadata.id, document]));
    for (const document of documents) {
      const count = [...document.body].length;
      if (document.metadata.kind === "user_profile") assertProfileWithinLimit(document.body);
      if (document.metadata.kind === "character_soul" && count > CHARACTER_SOUL_MAX_CHARACTERS) {
        throw new CharacterSoulValidationError(
          `character SOUL.md must not exceed ${CHARACTER_SOUL_MAX_CHARACTERS} characters (received ${count})`,
        );
      }
      if (document.metadata.kind === "person_profile") assertPersonProfileWithinLimit(document.body);
      if (document.metadata.kind === "person_profile") {
        for (const memoryId of document.metadata.sourceMemoryIds) {
          const source = byId.get(memoryId);
          if (
            source?.metadata.kind !== "memory" || source.metadata.realm !== "reality" ||
            source.metadata.type !== "person" ||
            normalizePersonKey(source.metadata.memoryKey ?? `memory:${source.metadata.id}`) !==
              normalizePersonKey(document.metadata.personKey!)
          ) {
            throw new MemoryVaultError(
              `person profile ${document.metadata.id} has invalid source memory ${memoryId}`,
              "MEMORY_VAULT_INVALID_DOCUMENT",
            );
          }
        }
      }
    }
    return this.projection.rebuild(documents, this.store.hash(documents), this.now());
  }

  private syncPersonProfileDocuments(): number {
    const documents = this.store.list();
    const personMemories = documents.filter((document) =>
      document.metadata.kind === "memory" &&
      document.metadata.realm === "reality" &&
      document.metadata.type === "person"
    );
    const grouped = new Map<string, VaultDocument[]>();
    for (const memory of personMemories) {
      const key = normalizePersonKey(memory.metadata.memoryKey ?? `memory:${memory.metadata.id}`);
      grouped.set(key, [...(grouped.get(key) ?? []), memory]);
    }
    const existingProfiles = new Map(this.store.getByKind("person_profile").map((document) => [
      normalizePersonKey(document.metadata.personKey!),
      document,
    ]));
    let changed = 0;
    for (const [personKey, sources] of grouped) {
      const active = sources.filter((document) =>
        document.metadata.validity === "active" && document.metadata.confirmed
      );
      const existing = existingProfiles.get(personKey);
      if (!active.length && !existing) continue;
      const structured = structuredPersonMetadata(active);
      const fallbackDisplayName = derivePersonDisplayName(personKey);
      const canUpgradeFallback = Boolean(
        existing && structured.displayName && existing.metadata.displayName === fallbackDisplayName
      );
      const displayName = canUpgradeFallback
        ? structured.displayName!
        : existing?.metadata.displayName ?? structured.displayName ?? fallbackDisplayName;
      const relationship = existing?.metadata.relationship ?? structured.relationship ?? null;
      const aliases = [...new Set([...(existing?.metadata.aliases ?? []), ...structured.aliases])].sort();
      const sourceMemoryIds = sources.map((document) => document.metadata.id).sort();
      const confidence = active.length
        ? Math.max(...active.map((document) => document.metadata.confidence ?? 0))
        : 0;
      const currentBody = canUpgradeFallback
        ? replaceGeneratedPersonHeading(existing!.body, fallbackDisplayName, displayName)
        : existing?.body;
      const body = projectPersonProfileBody(currentBody, displayName, active);
      assertPersonProfileWithinLimit(body);
      const now = this.now();
      const input: VaultWriteInput = {
        metadata: baseMetadata({
          id: existing?.metadata.id ?? personProfileId(personKey),
          kind: "person_profile",
          realm: "reality",
          scope: "global",
          createdAt: existing?.metadata.createdAt ?? earliestTimestamp(sources),
          updatedAt: now,
          tags: ["person-directory"],
          personKey,
          displayName,
          aliases,
          relationship,
          visibility: existing?.metadata.visibility ?? "global",
          visibleToCharacterIds: existing?.metadata.visibleToCharacterIds ?? [],
          sourceMemoryIds,
          personConfidence: confidence,
        }),
        body,
      };
      if (existing && personProfileMatches(existing, input)) continue;
      this.store.write(input, this.casForWrite(existing, input.metadata));
      changed += 1;
    }
    return changed;
  }

  private snapshot(): LegacyVaultSnapshot {
    return this.legacySource?.() ?? { characters: [], scenes: [], memories: [] };
  }

  private buildManifest(snapshot: LegacyVaultSnapshot): VaultMigrationManifest {
    const inputs = migrationDocuments(snapshot);
    const existing = new Map(this.store.list().map((document) => [document.metadata.id, document]));
    const sourceDocuments = inputs.map((input) => {
      const source = serializeVaultMarkdown({
        ...input.metadata,
        schemaVersion: MEMORY_VAULT_SCHEMA_VERSION,
        revision: input.metadata.revision ?? 1,
        contentHash: hashVaultBody(input.body),
      }, input.body);
      return { input, sourceHash: createHash("sha256").update(source).digest("hex") };
    });
    const now = this.now();
    return {
      schemaVersion: 1,
      sourceHash: createHash("sha256").update(sourceDocuments.map((entry) => entry.sourceHash).sort().join("\n")).digest("hex"),
      status: "pending",
      generatedAt: now,
      updatedAt: now,
      completedIds: [],
      items: sourceDocuments
        .map(({ input, sourceHash }) => {
          const current = existing.get(input.metadata.id);
          return {
            id: input.metadata.id,
            kind: input.metadata.kind,
            targetPath: relativePathForMetadata(input.metadata),
            action: !current ? "create" as const : current.documentHash === sourceHash ? "unchanged" as const : "preserve_vault" as const,
            sourceHash,
          };
        })
        .sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
    };
  }

  private readManifest(): VaultMigrationManifest | undefined {
    if (!this.manifestPath) return this.memoryManifest;
    if (!existsSync(this.manifestPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.manifestPath, "utf8")) as VaultMigrationManifest;
    } catch {
      return undefined;
    }
  }

  private writeManifest(manifest: VaultMigrationManifest): void {
    if (!this.manifestPath) {
      this.memoryManifest = structuredClone(manifest);
      return;
    }
    this.writer.assertOwner();
    atomicJson(this.manifestPath, manifest, () => this.writer.renewAndAssert());
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private casForWrite(
    existing: VaultDocument | undefined,
    target: Pick<VaultFrontmatter, "id" | "kind" | "realm" | "characterId" | "sessionId">,
    override: VaultCas = {},
  ): VaultCas {
    const targetPath = existing?.relativePath ?? relativePathForMetadata(target);
    const syncedHash = this.projection.readState()?.documentHashes[targetPath];
    if (!existing) {
      return syncedHash && override.expectedHash === undefined
        ? { ...override, expectedHash: syncedHash }
        : override;
    }
    return {
      expectedRevision: override.expectedRevision ?? existing.metadata.revision,
      expectedHash: override.expectedHash ?? syncedHash ?? existing.documentHash,
    };
  }

  private atomicMutation<T>(operationName: string, idempotencyKey: string, operation: () => T): T {
    this.writer.assertOwner();
    const before = this.captureSnapshot();
    const active = this.journal.prepare(operationName, idempotencyKey, before);
    this.activeOperation = active;
    try {
      const result = operation();
      if (active.record.stage === "prepared") this.journal.filesCommitted(active, this.captureSnapshot());
      if (active.record.stage === "files_committed") this.journal.projectionCommitted(active);
      if (active.record.stage === "projection_committed") this.journal.stateCommitted(active);
      this.alignCompatibilityMirrors();
      this.journal.refreshAfter(active, this.captureSnapshot());
      this.journal.complete(active);
      return result;
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      this.activeOperation = undefined;
      try {
        this.restoreSnapshot(before);
        if (active.record.stage === "projection_committed" || active.record.stage === "state_committed") {
          this.rebuildDocuments(this.store.list());
        }
        this.alignCompatibilityMirrors();
        this.journal.rolledBack(active, error);
      } catch (rollbackError) {
        throw new MemoryVaultError(
          `vault mutation failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          "MEMORY_VAULT_RECOVERY_FAILED",
        );
      }
      throw error;
    } finally {
      this.activeOperation = undefined;
    }
  }

  private beforeProjectionCommit(): void {
    this.writer.renewAndAssert();
    if (this.activeOperation?.record.stage === "prepared") {
      this.journal.filesCommitted(this.activeOperation, this.captureSnapshot());
    }
  }

  private afterProjectionCommit(): void {
    if (this.activeOperation) this.journal.projectionCommitted(this.activeOperation);
  }

  private beforeStateCommit(): void {
    if (this.activeOperation?.record.stage === "prepared") {
      this.journal.filesCommitted(this.activeOperation, this.captureSnapshot());
    }
    if (this.activeOperation?.record.stage === "files_committed") {
      this.journal.projectionCommitted(this.activeOperation);
    }
  }

  private afterStateCommit(): void {
    if (this.activeOperation) this.journal.stateCommitted(this.activeOperation);
  }

  private captureSnapshot(): SnapshotData {
    return createJournalSnapshot({
      vault: this.store.snapshotRawEntries(),
      mirrors: this.readMirrorEntries(),
      projectionState: this.projectionStatePath && existsSync(this.projectionStatePath)
        ? readFileSync(this.projectionStatePath, "utf8")
        : null,
    });
  }

  private restoreSnapshot(snapshot: SnapshotData): void {
    this.store.restoreRawEntries(snapshot.vault);
    this.restoreMirrorEntries(snapshot.mirrors);
    if (this.projectionStatePath) {
      if (snapshot.projectionState === null) {
        this.writer.renewAndAssert();
        rmSync(this.projectionStatePath, { force: true });
        fsyncDirectory(dirname(this.projectionStatePath));
      } else {
        durableAtomicWrite(this.projectionStatePath, snapshot.projectionState, {
          failpoint: this.options.failpoint,
          failpointPrefix: "projection_state_restore",
          beforeCommit: () => this.writer.renewAndAssert(),
        });
      }
    }
  }

  private readMirrorEntries(): VaultMirrorEntry[] {
    const stateDir = this.options.stateDir;
    if (!stateDir) return [];
    const entries: VaultMirrorEntry[] = [];
    const profilePath = join(stateDir, "user-profile.md");
    if (existsSync(profilePath)) {
      if (!lstatSync(profilePath).isFile() || lstatSync(profilePath).isSymbolicLink()) {
        throw new MemoryVaultError("user profile mirror must be a regular file", "MEMORY_VAULT_PATH_INVALID");
      }
      entries.push({ relativePath: "user-profile.md", source: readFileSync(profilePath, "utf8") });
    }
    const charactersDir = join(stateDir, "characters");
    if (existsSync(charactersDir)) {
      if (!lstatSync(charactersDir).isDirectory() || lstatSync(charactersDir).isSymbolicLink()) {
        throw new MemoryVaultError("character mirror directory is invalid", "MEMORY_VAULT_PATH_INVALID");
      }
      for (const entry of readdirSync(charactersDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
        const soulPath = join(charactersDir, entry.name, "SOUL.md");
        if (!existsSync(soulPath)) continue;
        if (!lstatSync(soulPath).isFile() || lstatSync(soulPath).isSymbolicLink()) {
          throw new MemoryVaultError(`invalid SOUL mirror for ${entry.name}`, "MEMORY_VAULT_PATH_INVALID");
        }
        entries.push({ relativePath: `characters/${entry.name}/SOUL.md`, source: readFileSync(soulPath, "utf8") });
      }
    }
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private restoreMirrorEntries(entries: VaultMirrorEntry[]): void {
    const stateDir = this.options.stateDir;
    if (!stateDir) return;
    const desired = new Map(entries.map((entry) => [entry.relativePath, entry.source]));
    const currentEntries = this.readMirrorEntries();
    const currentByPath = new Map(currentEntries.map((entry) => [entry.relativePath, entry.source]));
    for (const current of currentEntries) {
      if (desired.has(current.relativePath)) continue;
      const path = join(stateDir, current.relativePath);
      this.writer.renewAndAssert();
      rmSync(path, { force: true });
      fsyncDirectory(dirname(path));
    }
    for (const [relativePath, source] of desired) {
      if (currentByPath.get(relativePath) === source) continue;
      const path = join(stateDir, relativePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      durableAtomicWrite(path, source, {
        failpoint: this.options.failpoint,
        failpointPrefix: relativePath === "user-profile.md" ? "profile_mirror_file" : "soul_mirror_file",
        metadata: { relativePath },
        beforeCommit: () => this.writer.renewAndAssert(),
      });
    }
  }

  private alignCompatibilityMirrors(): void {
    const stateDir = this.options.stateDir;
    if (!stateDir) return;
    const desired: VaultMirrorEntry[] = [];
    const profile = this.store.get("user-profile");
    if (profile) desired.push({ relativePath: "user-profile.md", source: profile.body });
    for (const soul of this.store.getByKind("character_soul")) {
      desired.push({ relativePath: `characters/${soul.metadata.characterId}/SOUL.md`, source: soul.body });
    }
    this.restoreMirrorEntries(desired);
  }

  private readBackupStatus(): { generatedAt: string | null; verifiedAt: string | null; valid: boolean | null } {
    if (!this.backupStatusPath || !existsSync(this.backupStatusPath)) {
      return { generatedAt: null, verifiedAt: null, valid: null };
    }
    try {
      const value = JSON.parse(readFileSync(this.backupStatusPath, "utf8")) as Record<string, unknown>;
      return {
        generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
        verifiedAt: typeof value.verifiedAt === "string" ? value.verifiedAt : null,
        valid: typeof value.valid === "boolean" ? value.valid : null,
      };
    } catch {
      return { generatedAt: null, verifiedAt: null, valid: false };
    }
  }
}

function assertProfileWithinLimit(markdown: string): void {
  const count = [...markdown].length;
  if (count > USER_PROFILE_MAX_CHARACTERS) {
    throw new UserProfileValidationError(
      `user profile must not exceed ${USER_PROFILE_MAX_CHARACTERS} characters (received ${count})`,
    );
  }
}

function migrationDocuments(snapshot: LegacyVaultSnapshot): VaultWriteInput[] {
  const inputs: VaultWriteInput[] = [];
  if (snapshot.profile) {
    inputs.push({
      metadata: baseMetadata({
        id: "user-profile", kind: "user_profile", realm: "reality", scope: "global",
        createdAt: snapshot.profile.updatedAt, updatedAt: snapshot.profile.updatedAt,
      }),
      body: snapshot.profile.markdown,
    });
  }
  for (const character of snapshot.characters) {
    inputs.push({
      metadata: baseMetadata({
        id: `soul_${character.id}`, kind: "character_soul", realm: "roleplay", scope: "character",
        characterId: character.id, createdAt: character.createdAt, updatedAt: character.updatedAt,
      }),
      body: character.soulMarkdown,
    });
  }
  for (const scene of snapshot.scenes) {
    const state: SceneState = {
      roleSessionId: scene.roleSessionId,
      ...(scene.location === undefined ? {} : { location: scene.location }),
      ...(scene.inWorldTime === undefined ? {} : { inWorldTime: scene.inWorldTime }),
      participants: scene.participants,
      ...(scene.currentObjective === undefined ? {} : { currentObjective: scene.currentObjective }),
      openThreads: scene.openThreads,
      summary: scene.summary,
      updatedAt: scene.updatedAt,
    };
    inputs.push({
      metadata: baseMetadata({
        id: `scene_${scene.roleSessionId}`, kind: "scene", realm: "roleplay", scope: "session",
        characterId: scene.characterId ?? null, sessionId: scene.roleSessionId,
        createdAt: scene.updatedAt, updatedAt: scene.updatedAt,
        idempotencyKey: scene.idempotencyKey ?? null,
        scene: {
          location: scene.location ?? null,
          inWorldTime: scene.inWorldTime ?? null,
          participants: scene.participants,
          currentObjective: scene.currentObjective ?? null,
          openThreads: scene.openThreads,
        },
      }),
      body: sceneMarkdown(state),
    });
  }
  const supersedes = new Map(snapshot.memories.filter((memory) => memory.supersededById).map((memory) => [memory.supersededById!, memory.id]));
  for (const memory of snapshot.memories) {
    inputs.push(memoryInput({
      ...memory,
      normalizedContent: "",
    }, memory.idempotencyKey, supersedes.get(memory.id)));
  }
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.metadata.id)) {
      throw new MemoryVaultError(`legacy migration has duplicate id ${input.metadata.id}`, "MEMORY_VAULT_DUPLICATE_ID");
    }
    ids.add(input.metadata.id);
  }
  return inputs.sort((left, right) => relativePathForMetadata(left.metadata).localeCompare(relativePathForMetadata(right.metadata)));
}

function memoryInput(
  memory: Omit<RpMemory, "quarantineReasons"> & { quarantineReasons?: string[] },
  idempotencyKey?: string,
  supersedes?: string,
): VaultWriteInput {
  const legacy = memory.realm === "legacy";
  return {
    metadata: baseMetadata({
      id: memory.id,
      kind: "memory",
      realm: memory.realm,
      scope: memory.scope,
      type: memory.type,
      characterId: memory.characterId ?? null,
      validity: memory.validity,
      confirmed: memory.confirmed,
      confirmationProvenance: memory.confirmationProvenance
        ? { ...memory.confirmationProvenance, evidenceMessageId: memory.confirmationProvenance.evidenceMessageId ?? null }
        : memory.confirmed
          ? {
              kind: "trusted_control_plane",
              actor: "user",
              confirmedAt: memory.updatedAt,
              evidenceMessageId: memory.sourceMessageId ?? null,
            }
          : null,
      rejectedAt: memory.rejectedAt ?? null,
      archivedAt: memory.archivedAt ?? null,
      deletedAt: memory.deletedAt ?? null,
      statusReason: memory.statusReason ?? null,
      sourceSessionId: memory.sourceSessionId ?? null,
      sourceMessageId: memory.sourceMessageId ?? null,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      lastUsedAt: memory.lastUsedAt ?? null,
      supersedes: supersedes ?? null,
      tags: memory.tags,
      quarantineReasons: legacy
        ? memory.quarantineReasons?.length ? memory.quarantineReasons : ["legacy_quarantine"]
        : [],
      memoryKey: memory.key ?? null,
      salience: memory.salience,
      confidence: memory.confidence,
      idempotencyKey: idempotencyKey ?? null,
    }),
    body: memory.content,
  };
}

function memoryFromDocument(document: VaultDocument, successor?: string): RpMemory {
  const metadata = document.metadata;
  return {
    id: metadata.id,
    realm: metadata.realm,
    scope: metadata.scope === "session" ? "character" : metadata.scope,
    type: metadata.type!,
    ...(metadata.memoryKey === null ? {} : { key: metadata.memoryKey }),
    content: document.body.trimEnd(),
    normalizedContent: document.body.trim().toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]+/g, ""),
    ...(metadata.sourceSessionId === null ? {} : { sourceSessionId: metadata.sourceSessionId }),
    ...(metadata.sourceMessageId === null ? {} : { sourceMessageId: metadata.sourceMessageId }),
    ...(metadata.characterId === null ? {} : { characterId: metadata.characterId }),
    ...(metadata.realm === "legacy" ? {
      quarantineReasons: metadata.quarantineReasons.filter(
        (reason): reason is "missing_character" | "disallowed_profile_type" =>
          reason === "missing_character" || reason === "disallowed_profile_type",
      ),
    } : {}),
    salience: metadata.salience!,
    confidence: metadata.confidence!,
    validity: metadata.validity!,
    confirmed: metadata.confirmed!,
    ...(metadata.confirmationProvenance ? {
      confirmationProvenance: { ...metadata.confirmationProvenance },
    } : {}),
    ...(metadata.rejectedAt ? { rejectedAt: metadata.rejectedAt } : {}),
    ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
    ...(metadata.deletedAt ? { deletedAt: metadata.deletedAt } : {}),
    ...(metadata.statusReason ? { statusReason: metadata.statusReason } : {}),
    tags: metadata.tags,
    ...(successor ? { supersededById: successor } : {}),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.lastUsedAt === null ? {} : { lastUsedAt: metadata.lastUsedAt }),
  };
}

function baseMetadata(
  patch: Partial<Omit<VaultFrontmatter, "schemaVersion" | "revision" | "contentHash">> &
    Pick<VaultFrontmatter, "id" | "kind" | "realm" | "scope" | "createdAt" | "updatedAt">,
): VaultWriteInput["metadata"] {
  return {
    id: patch.id,
    kind: patch.kind,
    realm: patch.realm,
    scope: patch.scope,
    type: patch.type ?? null,
    characterId: patch.characterId ?? null,
    sessionId: patch.sessionId ?? null,
    validity: patch.validity ?? null,
    confirmed: patch.confirmed ?? null,
    confirmationProvenance: patch.confirmationProvenance ?? null,
    rejectedAt: patch.rejectedAt ?? null,
    archivedAt: patch.archivedAt ?? null,
    deletedAt: patch.deletedAt ?? null,
    statusReason: patch.statusReason ?? null,
    sourceSessionId: patch.sourceSessionId ?? null,
    sourceMessageId: patch.sourceMessageId ?? null,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
    lastUsedAt: patch.lastUsedAt ?? null,
    supersedes: patch.supersedes ?? null,
    tags: patch.tags ?? [],
    quarantineReasons: patch.quarantineReasons ?? [],
    memoryKey: patch.memoryKey ?? null,
    salience: patch.salience ?? null,
    confidence: patch.confidence ?? null,
    idempotencyKey: patch.idempotencyKey ?? null,
    scene: patch.scene ?? null,
    personKey: patch.personKey ?? null,
    displayName: patch.displayName ?? null,
    aliases: patch.aliases ?? [],
    relationship: patch.relationship ?? null,
    visibility: patch.visibility ?? null,
    visibleToCharacterIds: patch.visibleToCharacterIds ?? [],
    sourceMemoryIds: patch.sourceMemoryIds ?? [],
    personConfidence: patch.personConfidence ?? null,
  };
}

function stripGenerated(metadata: VaultFrontmatter): VaultWriteInput["metadata"] {
  const { schemaVersion: _schemaVersion, revision, contentHash: _contentHash, ...rest } = metadata;
  return { ...rest, revision };
}

function sceneMarkdown(scene: SceneState): string {
  return scene.summary;
}

function personProfileFromDocument(document: VaultDocument): PersonProfile {
  const metadata = document.metadata;
  return {
    id: metadata.id,
    personKey: metadata.personKey!,
    displayName: metadata.displayName!,
    aliases: [...metadata.aliases],
    ...(metadata.relationship ? { relationship: metadata.relationship } : {}),
    visibility: metadata.visibility!,
    visibleToCharacterIds: [...metadata.visibleToCharacterIds],
    sourceMemoryIds: [...metadata.sourceMemoryIds],
    confidence: metadata.personConfidence!,
    markdown: document.body,
    revision: metadata.revision,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function personProfileId(personKey: string): string {
  return `person_${createHash("sha256").update(normalizePersonKey(personKey)).digest("hex").slice(0, 24)}`;
}

function personKeyForMemory(memory: RpMemory): string {
  return memory.key?.trim() || `memory:${memory.id}`;
}

function normalizePersonKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, "_").slice(0, 240);
}

function derivePersonDisplayName(personKey: string): string {
  const tail = personKey.split(/[.:/]/u).filter(Boolean).at(-1) ?? personKey;
  if (/^[a-f0-9]{16,}$/u.test(tail)) return `相关人物 ${tail.slice(0, 6)}`;
  const display = tail.replace(/[_-]+/gu, " ").trim();
  return [...display].slice(0, 80).join("") || "相关人物";
}

function structuredPersonMetadata(documents: VaultDocument[]): {
  displayName?: string;
  aliases: string[];
  relationship?: string;
} {
  const ordered = [...documents].sort((left, right) => right.metadata.updatedAt.localeCompare(left.metadata.updatedAt));
  const values = ordered.flatMap((document) => document.metadata.tags);
  return {
    displayName: taggedValue(values, "person-name:"),
    aliases: values.flatMap((tag) => tag.startsWith("person-alias:") ? [tag.slice("person-alias:".length)] : [])
      .map((value) => value.trim()).filter(Boolean),
    relationship: taggedValue(values, "person-relationship:"),
  };
}

function taggedValue(tags: string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

function projectPersonProfileBody(
  current: string | undefined,
  displayName: string,
  activeSources: VaultDocument[],
): string {
  const manual = stripPersonFacts(current ?? `# ${displayName}\n`).trimEnd();
  const facts = [...activeSources]
    .sort((left, right) => right.metadata.updatedAt.localeCompare(left.metadata.updatedAt))
    .map((document) => {
      const content = document.body.trim().replace(/\s+/gu, " ");
      const confidence = (document.metadata.confidence ?? 0).toFixed(2);
      return `- ${content}\n  - 来源：\`${document.metadata.id}\`；置信度：${confidence}`;
    })
    .join("\n");
  return `${manual || `# ${displayName}`}\n\n${PERSON_FACTS_START}\n## 已确认信息\n\n${facts}\n${PERSON_FACTS_END}\n`;
}

function replaceGeneratedPersonHeading(markdown: string, previous: string, next: string): string {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() === `# ${previous}`) lines[0] = `# ${next}`;
  return lines.join("\n");
}

function stripPersonFacts(markdown: string): string {
  const start = markdown.indexOf(PERSON_FACTS_START);
  if (start < 0) return markdown;
  const end = markdown.indexOf(PERSON_FACTS_END, start);
  if (end < 0) return markdown.slice(0, start);
  return `${markdown.slice(0, start)}${markdown.slice(end + PERSON_FACTS_END.length)}`.trimEnd();
}

function boundedPersonContext(document: VaultDocument, query: string): string {
  const identity = [
    `人物档案：${document.metadata.displayName}`,
    document.metadata.relationship ? `与用户关系：${document.metadata.relationship}` : "",
    document.metadata.aliases.length ? `别名：${document.metadata.aliases.join("、")}` : "",
  ].filter(Boolean).join("\n");
  const queryTerms = personContextTerms(query);
  const bodyLines = document.body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("<!--") &&
      !/^- 来源：/u.test(line))
    .map((line) => line.replace(/^-\s*/u, ""));
  const ordered = [...new Set(bodyLines)].sort((left, right) =>
    personLineScore(right, queryTerms) - personLineScore(left, queryTerms)
  );
  let context = identity;
  for (const line of ordered) {
    const candidate = `${context}\n${line}`;
    if ([...candidate].length > PERSON_CONTEXT_MAX_CHARACTERS) continue;
    context = candidate;
  }
  return context;
}

function personContextTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9_]{2,}/gu) ?? [];
  const han = [...(normalized.match(/[\p{Script=Han}]+/gu) ?? [])].flatMap((sequence) => {
    const characters = [...sequence];
    return characters.flatMap((character, index) => index + 1 < characters.length
      ? [`${character}${characters[index + 1]}`]
      : []);
  });
  return [...new Set([...words, ...han])];
}

function personLineScore(line: string, queryTerms: string[]): number {
  const normalized = line.toLocaleLowerCase();
  return queryTerms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function normalizePersonContent(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]+/g, "");
}

function earliestTimestamp(documents: VaultDocument[]): string {
  return documents.map((document) => document.metadata.createdAt).sort()[0];
}

function personProfileMatches(existing: VaultDocument, input: VaultWriteInput): boolean {
  const current = stripGenerated(existing.metadata);
  const target = input.metadata;
  return existing.body === input.body && JSON.stringify({ ...current, updatedAt: null, revision: null }) ===
    JSON.stringify({ ...target, updatedAt: null, revision: null });
}

function cleanPersonField(value: string, field: string, max: number): string {
  const text = value.trim();
  if (!text) throw new MemoryVaultError(`${field} is required`, "MEMORY_VAULT_INVALID_DOCUMENT");
  if ([...text].length > max) {
    throw new MemoryVaultError(`${field} exceeds ${max} characters`, "MEMORY_VAULT_INVALID_DOCUMENT");
  }
  return text;
}

function cleanPersonList(values: string[], field: string, maxItems: number, maxCharacters: number): string[] {
  if (values.length > maxItems) {
    throw new MemoryVaultError(`${field} exceeds ${maxItems} items`, "MEMORY_VAULT_INVALID_DOCUMENT");
  }
  return [...new Set(values.map((value) => cleanPersonField(value, field, maxCharacters)))];
}

function validateVisibleCharacterIds(database: AppDatabase, values: string[]): string[] {
  const requested = [...new Set(values)];
  const existing = new Set(
    (database.connection.prepare("SELECT id FROM characters").all() as Array<{ id: string }>).map((row) => row.id),
  );
  const unknown = requested.filter((id) => !existing.has(id));
  if (unknown.length) {
    throw new MemoryVaultError(`unknown visible character: ${unknown.join(", ")}`, "MEMORY_VAULT_INVALID_DOCUMENT");
  }
  return requested.sort();
}

function assertPersonProfileWithinLimit(markdown: string): void {
  const count = [...markdown].length;
  if (count > PERSON_PROFILE_MAX_CHARACTERS) {
    throw new MemoryVaultError(
      `person profile must not exceed ${PERSON_PROFILE_MAX_CHARACTERS} characters (received ${count})`,
      "MEMORY_VAULT_INVALID_DOCUMENT",
    );
  }
}

function atomicJson(path: string, value: unknown, beforeCommit?: () => void): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  durableAtomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { beforeCommit });
}
