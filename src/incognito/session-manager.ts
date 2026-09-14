import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import type { HistoryQuery, HistoryPage, HistorySearch } from "../history/pagination.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { ContextBudgetSnapshot } from "../context/types.js";
import type { MessageRequest, MessageResponse, SessionRecord } from "../domain/types.js";
import type { InteractionEvent, InteractionState } from "../interaction/types.js";
import type { WorldMeetingScene } from "../world/types.js";
import type {
  ConversationCompactionResult,
  ConversationMetadata,
  ConversationTranscriptMessage,
} from "../pi/session-runtime.js";
import { resolveSafePiSessionFileBinding } from "../pi/session-runtime.js";

const TMPFS_MAGIC = 0x01021994;
const DEFAULT_TMP_ROOT = "/dev/shm";
const INCOGNITO_SESSION_PREFIX = "incognito-";
const SNAPSHOT_DIRECTORY_PREFIX = "yourchar-incognito-";
const OWNER_MARKER = ".yourchar-incognito-owner.json";
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const TMPFS_RESERVE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_STABILITY_ATTEMPTS = 3;
const EXCLUDED_WORKSPACE_REPOSITORIES = "workspace/repos";

const SNAPSHOT_FILES = [
  "model-api.json",
  "user-profile.md",
] as const;

const SNAPSHOT_FINGERPRINT_FILES = [
  ...SNAPSHOT_FILES,
  "memory-vault-state.json",
  "memory-vault-recovery.json",
] as const;

const SNAPSHOT_DIRECTORIES = [
  "characters",
  "memory-vault",
  "workspace",
  "system-prompts",
] as const;

const APP_SKILL_DIRECTORIES = ["skills", ".agents/skills", ".pi/skills"] as const;
export const INCOGNITO_APP_SNAPSHOT_DIRECTORY = "app-snapshot";

export type IncognitoConversationMetadata = ConversationMetadata & {
  incognito: true;
  sourceSessionId?: string;
  sourceArchived?: true;
};

export type IncognitoInteractionInput = {
  action: "propose" | "begin" | "end" | "cancel" | "undo";
  placeId?: string;
  location?: string;
  note?: string;
  summary?: string;
  userConfirmed?: boolean;
};

export type IncognitoInteractionView = {
  state: InteractionState;
  events: InteractionEvent[];
  canUndo: boolean;
  suggestedLocations: Array<{ id: string; name: string }>;
  meetingScene?: WorldMeetingScene;
  liveState: {
    place?: string;
    activity?: string;
    availability?: string;
    presence: InteractionState["presence"];
    updatedAt: string;
  };
};

type IncognitoChildKernel = {
  openCanonicalPrivateConversation: (
    characterId: string,
    conversationSpace?: "normal" | "secret",
  ) => Promise<ConversationMetadata>;
  listConversationMetadata: () => ConversationMetadata[];
  getSession: (sessionId: string) => Promise<SessionRecord>;
  getConversationTranscript: (sessionId: string) => Promise<ConversationTranscriptMessage[]>;
  getMessageHistory: (sessionId: string, query: HistoryQuery, search?: string) => Promise<HistoryPage<ConversationTranscriptMessage> | HistorySearch>;
  sendMessage: (sessionId: string, request: MessageRequest) => Promise<MessageResponse>;
  streamMessage: (
    sessionId: string,
    request: MessageRequest,
    onEvent: (event: AgentSessionEvent) => void,
    signal?: AbortSignal,
  ) => Promise<MessageResponse>;
  cancelMessage: (sessionId: string) => Promise<boolean>;
  getConversationContextBudget: (sessionId: string) => Promise<ContextBudgetSnapshot>;
  compactConversationContext: (sessionId: string) => Promise<ConversationCompactionResult>;
  flushConversationWakeNotifications: (sessionId?: string) => Promise<number>;
  getConversationInteraction: (sessionId: string) => IncognitoInteractionView;
  transitionConversationInteraction: (
    sessionId: string,
    input: IncognitoInteractionInput,
  ) => Promise<IncognitoInteractionView>;
  dispose: () => void;
};

export class IncognitoUnavailableError extends Error {
  readonly code = "INCOGNITO_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "IncognitoUnavailableError";
  }
}

export class IncognitoConversationNotFoundError extends Error {
  readonly code = "INCOGNITO_CONVERSATION_NOT_FOUND";

  constructor(sessionId: string) {
    super(`Incognito conversation ${sessionId} was not found or has already been closed`);
    this.name = "IncognitoConversationNotFoundError";
  }
}

export class IncognitoOperationUnsupportedError extends Error {
  readonly code = "INCOGNITO_OPERATION_UNSUPPORTED";

  constructor(operation: string) {
    super(`${operation} is unavailable in an incognito conversation`);
    this.name = "IncognitoOperationUnsupportedError";
  }
}

type IncognitoEntry = {
  id: string;
  sourceSessionId?: string;
  sourceArchived?: true;
  childSessionId: string;
  characterId: string;
  createdAt: string;
  rootDir: string;
  child: IncognitoChildKernel;
  state: "active" | "closing";
  activeOperations: Set<Promise<unknown>>;
  closingTask?: Promise<void>;
};

export type IncognitoSessionManagerOptions = {
  sourceStateDir?: string;
  sourceAppDir?: string;
  sourceDatabase: DatabaseSync;
  tmpRoot?: string;
  listSourceMetadata: () => ConversationMetadata[];
  listNormalSkillPackages: (characterId: string) => Array<{
    name: string;
    baseDir: string;
    filePath: string;
  }>;
  withSnapshotLock: <T>(sessionId: string | undefined, operation: () => Promise<T>) => Promise<T>;
  createChild: (stateDir: string) => IncognitoChildKernel;
  now?: () => Date;
};

/**
 * Owns disposable, process-local conversations backed exclusively by tmpfs.
 *
 * The parent runtime is never asked to create a session or serialize a turn:
 * opening waits for an existing canonical normal conversation to become idle,
 * copies its already-persisted Pi branch, and uses SQLite's online backup API.
 * Every subsequent operation is delegated to a child CompanionKernel whose
 * state directory and workspace both live below the private tmpfs directory.
 */
export class IncognitoSessionManager {
  private readonly entries = new Map<string, IncognitoEntry>();
  private readonly tmpRoot: string;
  private readonly now: () => Date;
  private accepting = true;
  private openingTask?: Promise<IncognitoConversationMetadata>;
  private openingRootDir?: string;

  get hasSnapshot(): boolean { return Boolean(this.openingTask || this.entries.size); }

  constructor(private readonly options: IncognitoSessionManagerOptions) {
    this.tmpRoot = resolve(options.tmpRoot ?? DEFAULT_TMP_ROOT);
    this.now = options.now ?? (() => new Date());
    if (this.isUsableTmpfs()) this.cleanupStaleRoots();
  }

  async open(characterId: string): Promise<IncognitoConversationMetadata> {
    if (!this.accepting) {
      throw new IncognitoOperationUnsupportedError("opening while user data is being deleted");
    }
    if (this.entries.size > 0 || this.openingTask) {
      throw new IncognitoOperationUnsupportedError(
        "opening more than one active incognito conversation",
      );
    }
    const operation = this.openUnlocked(characterId);
    this.openingTask = operation;
    try {
      return await operation;
    } finally {
      if (this.openingTask === operation) this.openingTask = undefined;
    }
  }

  private async openUnlocked(characterId: string): Promise<IncognitoConversationMetadata> {
    const normalizedCharacterId = characterId.trim();
    if (!normalizedCharacterId) {
      throw new IncognitoUnavailableError("a character is required to open an incognito conversation");
    }
    const sourceStateDir = this.requireSourceStateDir();
    this.assertTmpfs();

    let source = this.findSource(normalizedCharacterId);
    const expectedSourceSessionId = source?.id;

    const rootDir = mkdtempSync(join(this.tmpRoot, SNAPSHOT_DIRECTORY_PREFIX));
    this.openingRootDir = rootDir;
    chmodSync(rootDir, 0o700);
    let child: IncognitoChildKernel | undefined;
    try {
      writeOwnerMarker(rootDir);
      await this.options.withSnapshotLock(expectedSourceSessionId, async () => {
        this.assertAccepting();
        source = this.findSource(normalizedCharacterId);
        if (source?.id !== expectedSourceSessionId) {
          throw new IncognitoUnavailableError(
            "the source conversation changed while creating its snapshot",
          );
        }
        await this.createStableSnapshot(
          sourceStateDir,
          rootDir,
          normalizedCharacterId,
          source,
        );
        this.assertAccepting();
      });
      this.assertAccepting();
      child = this.options.createChild(rootDir);
      const childMetadata = await child.openCanonicalPrivateConversation(
        normalizedCharacterId,
        "normal",
      );
      this.assertAccepting();
      assertIncognitoTmpfsQuota(rootDir);
      if (source && childMetadata.id !== source.id) {
        throw new IncognitoUnavailableError("the disposable child did not preserve the source conversation");
      }
      const id = `${INCOGNITO_SESSION_PREFIX}${randomUUID()}`;
      const entry: IncognitoEntry = {
        id,
        ...(source ? { sourceSessionId: source.id } : {}),
        ...(source?.archivedAt ? { sourceArchived: true as const } : {}),
        childSessionId: childMetadata.id,
        characterId: normalizedCharacterId,
        createdAt: this.now().toISOString(),
        rootDir,
        child,
        state: "active",
        activeOperations: new Set(),
      };
      this.assertAccepting();
      this.entries.set(id, entry);
      return this.metadataFor(entry);
    } catch (error) {
      let cleanupError: unknown;
      try {
        child?.dispose();
      } catch (failure) {
        cleanupError = failure;
      } finally {
        try {
          rmSync(rootDir, { recursive: true, force: true });
        } catch (failure) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, failure], "failed to clean a rejected snapshot")
            : failure;
        }
      }
      if (cleanupError) {
        throw new IncognitoUnavailableError(
          `failed to create and clean a disposable tmpfs snapshot: ${safeErrorMessage(cleanupError)}`,
        );
      }
      if (
        error instanceof IncognitoUnavailableError ||
        error instanceof IncognitoOperationUnsupportedError
      ) throw error;
      throw new IncognitoUnavailableError(
        `failed to create a disposable tmpfs snapshot: ${safeErrorMessage(error)}`,
      );
    } finally {
      if (this.openingRootDir === rootDir) this.openingRootDir = undefined;
    }
  }

  listMetadata(): IncognitoConversationMetadata[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === "active")
      .map((entry) => this.metadataFor(entry))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getMetadata(sessionId: string): IncognitoConversationMetadata | undefined {
    const entry = this.entries.get(sessionId);
    return entry?.state === "active" ? this.metadataFor(entry) : undefined;
  }

  has(sessionId: string): boolean {
    return this.entries.get(sessionId)?.state === "active";
  }

  assertUnsupported(sessionId: string, operation: string): void {
    if (this.entries.get(sessionId)?.state === "active") {
      throw new IncognitoOperationUnsupportedError(operation);
    }
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.getSession(entry.childSessionId),
      entry,
    ));
  }

  async getTranscript(sessionId: string): Promise<ConversationTranscriptMessage[]> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.getConversationTranscript(entry.childSessionId),
      entry,
    ));
  }

  async getMessageHistory(sessionId: string, query: HistoryQuery, search?: string) {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.getMessageHistory(entry.childSessionId, query, search), entry,
    ));
  }

  async sendMessage(sessionId: string, request: MessageRequest): Promise<MessageResponse> {
    const entry = this.requireEntry(sessionId);
    this.assertSafeMessageRequest(request, entry);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.sendMessage(entry.childSessionId, this.childRequest(request, entry)),
      entry,
    ));
  }

  async streamMessage(
    sessionId: string,
    request: MessageRequest,
    onEvent: (event: AgentSessionEvent) => void,
    signal?: AbortSignal,
  ): Promise<MessageResponse> {
    const entry = this.requireEntry(sessionId);
    this.assertSafeMessageRequest(request, entry);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.streamMessage(
        entry.childSessionId,
        this.childRequest(request, entry),
        (event) => onEvent(remapSessionReferences(event, entry)),
        signal,
      ),
      entry,
    ));
  }

  async cancelMessage(sessionId: string): Promise<boolean> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, () => entry.child.cancelMessage(entry.childSessionId));
  }

  async getContextBudget(sessionId: string): Promise<ContextBudgetSnapshot> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, () =>
      entry.child.getConversationContextBudget(entry.childSessionId));
  }

  async compactContext(sessionId: string): Promise<ConversationCompactionResult> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, () =>
      entry.child.compactConversationContext(entry.childSessionId));
  }

  async flushConversationWakeNotifications(sessionId: string): Promise<number> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, () =>
      entry.child.flushConversationWakeNotifications(entry.childSessionId));
  }

  getInteraction(sessionId: string): IncognitoInteractionView {
    const entry = this.requireEntry(sessionId);
    return remapSessionReferences(
      entry.child.getConversationInteraction(entry.childSessionId),
      entry,
    );
  }

  async transitionInteraction(
    sessionId: string,
    input: IncognitoInteractionInput,
  ): Promise<IncognitoInteractionView> {
    const entry = this.requireEntry(sessionId);
    return this.trackOperation(entry, async () => remapSessionReferences(
      await entry.child.transitionConversationInteraction(entry.childSessionId, input),
      entry,
    ));
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new IncognitoConversationNotFoundError(sessionId);
    if (entry.closingTask) return entry.closingTask;
    entry.state = "closing";
    const task = this.closeEntry(entry);
    entry.closingTask = task;
    try {
      await task;
    } finally {
      if (this.entries.get(sessionId) === entry && entry.closingTask === task) {
        entry.closingTask = undefined;
      }
    }
  }

  async closeAll(): Promise<void> {
    this.accepting = false;
    try {
      await this.openingTask?.catch(() => undefined);
      for (const sessionId of [...this.entries.keys()]) {
        try {
          await this.close(sessionId);
        } catch (error) {
          if (!(error instanceof IncognitoConversationNotFoundError)) throw error;
        }
      }
    } catch (error) {
      // A forced disposal still guarantees that no tmpfs snapshot survives.
      try {
        this.disposeEntries();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to close all incognito snapshots");
      }
      throw error;
    }
  }

  resumeAfterDataDeletion(): void {
    this.accepting = true;
  }

  dispose(): void {
    this.accepting = false;
    const errors: unknown[] = [];
    if (this.openingRootDir) {
      try {
        rmSync(this.openingRootDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.disposeEntries();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "failed to dispose incognito state");
  }

  private disposeEntries(): void {
    const errors: unknown[] = [];
    for (const [sessionId, entry] of this.entries) {
      try {
        disposeEntry(entry);
        this.entries.delete(sessionId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "failed to dispose incognito snapshots");
  }

  private async closeEntry(entry: IncognitoEntry): Promise<void> {
    try {
      await entry.child.cancelMessage(entry.childSessionId);
    } catch {
      // Active work is still drained below; disposal is the final cancellation boundary.
    }
    await Promise.allSettled([...entry.activeOperations]);
    disposeEntry(entry);
    this.entries.delete(entry.id);
  }

  private trackOperation<T>(entry: IncognitoEntry, operation: () => Promise<T>): Promise<T> {
    if (entry.state !== "active" || this.entries.get(entry.id) !== entry) {
      throw new IncognitoConversationNotFoundError(entry.id);
    }
    let tracked: Promise<T>;
    try {
      assertIncognitoTmpfsQuota(entry.rootDir);
      tracked = (async () => {
        try {
          return await operation();
        } finally {
          assertIncognitoTmpfsQuota(entry.rootDir);
        }
      })().finally(() => {
        entry.activeOperations.delete(tracked);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    entry.activeOperations.add(tracked);
    return tracked;
  }

  private metadataFor(entry: IncognitoEntry): IncognitoConversationMetadata {
    const child = entry.child.listConversationMetadata()
      .find((metadata) => metadata.id === entry.childSessionId);
    const updatedAt = child?.updatedAt ?? entry.createdAt;
    return {
      ...(child ?? {
        id: entry.childSessionId,
        mode: "sms" as const,
        conversationSpace: "normal" as const,
        characterId: entry.characterId,
        canonicalDirect: true,
        createdAt: entry.createdAt,
        updatedAt,
      }),
      id: entry.id,
      mode: "sms",
      conversationSpace: "normal",
      characterId: entry.characterId,
      canonicalDirect: true,
      incognito: true,
      ...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
      ...(entry.sourceArchived ? { sourceArchived: true as const } : {}),
      createdAt: entry.createdAt,
      updatedAt,
    };
  }

  private requireEntry(sessionId: string): IncognitoEntry {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== "active") throw new IncognitoConversationNotFoundError(sessionId);
    return entry;
  }

  private findSource(characterId: string): ConversationMetadata | undefined {
    return this.options.listSourceMetadata().find((entry) =>
      entry.mode === "sms" &&
      entry.conversationSpace === "normal" &&
      entry.characterId === characterId &&
      entry.canonicalDirect === true
    );
  }

  private assertAccepting(): void {
    if (!this.accepting) {
      throw new IncognitoOperationUnsupportedError("opening after incognito shutdown");
    }
  }

  private requireSourceStateDir(): string {
    const configured = this.options.sourceStateDir;
    if (!configured || !existsSync(configured)) {
      throw new IncognitoUnavailableError(
        "incognito mode requires a configured persistent source state directory",
      );
    }
    return realpathSync(configured);
  }

  private assertTmpfs(): void {
    if (!existsSync(this.tmpRoot)) {
      throw new IncognitoUnavailableError(`tmpfs root does not exist: ${this.tmpRoot}`);
    }
    const stats = statfsSync(this.tmpRoot);
    if (Number(stats.type) !== TMPFS_MAGIC) {
      throw new IncognitoUnavailableError(
        `refusing incognito mode because ${this.tmpRoot} is not a tmpfs filesystem`,
      );
    }
  }

  private isUsableTmpfs(): boolean {
    try {
      return existsSync(this.tmpRoot) && Number(statfsSync(this.tmpRoot).type) === TMPFS_MAGIC;
    } catch {
      return false;
    }
  }

  private cleanupStaleRoots(): void {
    for (const name of readdirSync(this.tmpRoot)) {
      if (!name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)) continue;
      const path = join(this.tmpRoot, name);
      try {
        const stats = lstatSync(path);
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
        if (typeof process.getuid === "function" && stats.uid !== process.getuid()) continue;
        if (dirname(realpathSync(path)) !== realpathSync(this.tmpRoot)) continue;
        const markerPath = join(path, OWNER_MARKER);
        const markerStats = lstatSync(markerPath);
        if (!markerStats.isFile() || markerStats.isSymbolicLink()) continue;
        if (typeof process.getuid === "function" && markerStats.uid !== process.getuid()) continue;
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        if (marker.schemaVersion !== 1 || marker.uid !== currentUid()) continue;
        if (typeof marker.pid !== "number" || typeof marker.processIdentity !== "string") continue;
        if (processIdentity(marker.pid) === marker.processIdentity) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Unknown or malformed entries are never deleted.
      }
    }
  }

  private async createStableSnapshot(
    sourceStateDir: string,
    destination: string,
    characterId: string,
    metadata?: ConversationMetadata,
  ): Promise<void> {
    const sourceAppDir = resolve(this.options.sourceAppDir ?? process.cwd());
    for (let attempt = 1; attempt <= SNAPSHOT_STABILITY_ATTEMPTS; attempt += 1) {
      clearSnapshotPayload(destination);
      const skillsBefore = normalSkillSnapshotBindings(
        sourceStateDir,
        sourceAppDir,
        this.options.listNormalSkillPackages(characterId),
      );
      const before = snapshotSourceFingerprint(
        sourceStateDir,
        sourceAppDir,
        metadata,
        skillsBefore,
      );
      await this.createSnapshot(sourceStateDir, destination, metadata, skillsBefore);
      const skillsAfter = normalSkillSnapshotBindings(
        sourceStateDir,
        sourceAppDir,
        this.options.listNormalSkillPackages(characterId),
      );
      const after = snapshotSourceFingerprint(
        sourceStateDir,
        sourceAppDir,
        metadata,
        skillsAfter,
      );
      if (before === after) return;
    }
    clearSnapshotPayload(destination);
    throw new IncognitoUnavailableError(
      "the source state kept changing while creating the incognito snapshot",
    );
  }

  private async createSnapshot(
    sourceStateDir: string,
    destination: string,
    metadata?: ConversationMetadata,
    normalSkills: SkillSnapshotBinding[] = [],
  ): Promise<void> {
    const budget = snapshotCopyBudget(destination, this.options.sourceDatabase);
    for (const name of SNAPSHOT_FILES) {
      const source = join(sourceStateDir, name);
      if (existsSync(source)) copySnapshotEntry(source, join(destination, name), budget);
    }
    for (const name of SNAPSHOT_DIRECTORIES) {
      const source = join(sourceStateDir, name);
      if (existsSync(source)) {
        copySnapshotEntry(source, join(destination, name), budget, name);
      }
    }
    const appSnapshotDir = join(destination, INCOGNITO_APP_SNAPSHOT_DIRECTORY);
    mkdirSync(appSnapshotDir, { recursive: true, mode: 0o700 });
    for (const skill of normalSkills) {
      copySnapshotEntry(
        skill.sourceDir,
        join(destination, skill.destinationRelative),
        budget,
        skill.destinationRelative,
      );
    }

    const piSessionDir = join(destination, "pi-sessions");
    mkdirSync(piSessionDir, { recursive: true, mode: 0o700 });
    let clonedPiSessionFile: string | undefined;
    if (metadata?.piSessionFile) {
      const sourceFile = safeSourcePiSessionFile(sourceStateDir, metadata);
      clonedPiSessionFile = join(piSessionDir, basename(sourceFile));
      copySnapshotEntry(sourceFile, clonedPiSessionFile, budget);
    }

    const childConversation = metadata
      ? { ...metadata, ...(clonedPiSessionFile ? { piSessionFile: clonedPiSessionFile } : {}) }
      : undefined;
    if (childConversation) {
      // A pending wake belongs to the persistent source runtime. Preserve the
      // sleeping checkpoint so the first successful child turn can resume it,
      // but never replay the source outbox inside the disposable overlay.
      delete childConversation.pendingWakeNotificationId;
      delete childConversation.pendingWakeNotificationAt;
      delete childConversation.wakeNotificationAttempts;
      delete childConversation.wakeNotificationLastError;
    }
    writeFileSync(
      join(destination, "conversations.json"),
      `${JSON.stringify({
        version: 1,
        conversations: childConversation ? [childConversation] : [],
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const databasePath = join(destination, "rp-agent.sqlite");
    await backup(this.options.sourceDatabase, databasePath);
    const clone = new DatabaseSync(databasePath);
    try {
      const leaseExists = clone.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_vault_writer_lease'
      `).get() as { present?: number } | undefined;
      if (leaseExists?.present) {
        clone.prepare(`
          UPDATE memory_vault_writer_lease
          SET owner_id = NULL,
              expires_at = NULL,
              process_identity = NULL,
              heartbeat_at = NULL
          WHERE singleton = 1
        `).run();
      }
      purgeSecretSnapshotState(
        clone,
        this.options.listSourceMetadata()
          .filter((entry) => entry.conversationSpace === "secret")
          .map((entry) => entry.id),
      );
      configureIncognitoSkillSnapshot(clone, normalSkills, this.now().toISOString());
    } finally {
      clone.close();
    }
    chmodSync(databasePath, 0o600);
  }

  private assertSafeMessageRequest(request: MessageRequest, entry: IncognitoEntry): void {
    if (request.mode !== undefined && request.mode !== "sms") {
      throw new IncognitoOperationUnsupportedError("RP-mode messages");
    }
    if (request.conversationSpace !== undefined && request.conversationSpace !== "normal") {
      throw new IncognitoOperationUnsupportedError("cross-space messages");
    }
    if (request.characterId !== undefined && request.characterId !== entry.characterId) {
      throw new IncognitoOperationUnsupportedError("changing the selected character");
    }
    if (request.attachments?.length) {
      throw new IncognitoOperationUnsupportedError("message attachments");
    }
  }

  private childRequest(request: MessageRequest, entry: IncognitoEntry): MessageRequest {
    return {
      ...request,
      mode: "sms",
      conversationSpace: "normal",
      characterId: entry.characterId,
      attachments: [],
    };
  }
}

export function assertIncognitoTmpfsQuota(rootDir: string, additionalBytes = 0): void {
  const normalizedAdditionalBytes = Math.max(0, Math.ceil(additionalBytes));
  const currentBytes = snapshotTreeBytes(rootDir, MAX_SNAPSHOT_BYTES + 1);
  if (currentBytes + normalizedAdditionalBytes > MAX_SNAPSHOT_BYTES) {
    throw new IncognitoUnavailableError(
      `the disposable session exceeds the ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB runtime quota`,
    );
  }
  const stats = statfsSync(rootDir);
  if (Number(stats.type) !== TMPFS_MAGIC) {
    throw new IncognitoUnavailableError("the disposable session is no longer backed by tmpfs");
  }
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (availableBytes - normalizedAdditionalBytes < TMPFS_RESERVE_BYTES) {
    throw new IncognitoUnavailableError(
      `the disposable session must preserve ${TMPFS_RESERVE_BYTES / 1024 / 1024} MiB of tmpfs capacity`,
    );
  }
}

function snapshotTreeBytes(path: string, stopAfter: number): number {
  if (!existsSync(path)) return 0;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  let total = 0;
  for (const name of readdirSync(path)) {
    total += snapshotTreeBytes(join(path, name), stopAfter - total);
    if (total > stopAfter) return total;
  }
  return total;
}

function disposeEntry(entry: IncognitoEntry): void {
  const errors: unknown[] = [];
  try {
    entry.child.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    rmSync(entry.rootDir, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "failed to dispose an incognito snapshot");
}

export function isIncognitoSessionId(sessionId: string): boolean {
  return /^incognito-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(sessionId);
}

function safeSourcePiSessionFile(
  sourceStateDir: string,
  metadata: ConversationMetadata,
): string {
  if (!metadata.piSessionFile || !metadata.piSessionId) {
    throw new IncognitoUnavailableError("the source conversation has no persisted Pi session");
  }
  const path = resolveSafePiSessionFileBinding(
    join(sourceStateDir, "pi-sessions"),
    metadata.piSessionFile,
    metadata.piSessionId,
  );
  if (!path) {
    throw new IncognitoUnavailableError("the source conversation has an unsafe Pi session binding");
  }
  return path;
}

function writeOwnerMarker(rootDir: string): void {
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error("cannot determine the incognito owner process identity");
  writeFileSync(
    join(rootDir, OWNER_MARKER),
    `${JSON.stringify({
      schemaVersion: 1,
      uid: currentUid(),
      pid: process.pid,
      processIdentity: identity,
      createdAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function processIdentity(pid: number): string | undefined {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const afterName = source.slice(source.lastIndexOf(")") + 1).trim().split(/\s+/);
    return `${pid}:${afterName[19] ?? "unknown"}`;
  } catch {
    return undefined;
  }
}

type SnapshotCopyBudget = { copiedBytes: number; maximumBytes: number };

function copySnapshotEntry(
  source: string,
  destination: string,
  budget: SnapshotCopyBudget,
  relativePath = basename(source),
): void {
  // Persistent Git checkouts are normal-mode working state, not disposable
  // conversation context. Match the lexical snapshot path before touching the
  // source so even a dangling or redirected workspace/repos symlink is never
  // followed or included in the copy budget.
  if (relativePath === EXCLUDED_WORKSPACE_REPOSITORIES) return;
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) return;
  if (relativePath === "memory-vault/secret") return;
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const entry of readdirSync(source)) {
      copySnapshotEntry(
        join(source, entry),
        join(destination, entry),
        budget,
        `${relativePath}/${entry}`,
      );
    }
    return;
  }
  if (!stats.isFile()) return;
  budget.copiedBytes += stats.size;
  if (budget.copiedBytes > budget.maximumBytes) {
    throw new IncognitoUnavailableError(
      `the disposable snapshot exceeds the ${Math.floor(budget.maximumBytes / 1024 / 1024)} MiB tmpfs budget`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function snapshotCopyBudget(
  destination: string,
  database: DatabaseSync,
): SnapshotCopyBudget {
  const stats = statfsSync(destination);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const maximumBytes = Math.min(
    MAX_SNAPSHOT_BYTES,
    Math.max(0, availableBytes - TMPFS_RESERVE_BYTES),
  );
  const pageCount = Number((database.prepare("PRAGMA page_count").get() as { page_count?: number })?.page_count ?? 0);
  const pageSize = Number((database.prepare("PRAGMA page_size").get() as { page_size?: number })?.page_size ?? 0);
  const databaseBytes = Math.max(0, pageCount * pageSize);
  if (maximumBytes <= 0 || databaseBytes > maximumBytes) {
    throw new IncognitoUnavailableError("tmpfs does not have enough reserved capacity for an incognito snapshot");
  }
  return { copiedBytes: databaseBytes, maximumBytes };
}

function purgeSecretSnapshotState(database: DatabaseSync, secretSessionIds: string[]): void {
  const sessionIds = [...new Set(secretSessionIds)];
  const sessionColumns = new Set([
    "session_id",
    "app_session_id",
    "role_session_id",
    "source_session_id",
    "parent_session_id",
  ]);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("PRAGMA temp_store = MEMORY");
  const tempStore = database.prepare("PRAGMA temp_store").get() as { temp_store?: number } | undefined;
  if (Number(tempStore?.temp_store) !== 2) {
    throw new IncognitoUnavailableError(
      "failed to confine SQLite snapshot cleanup temporary state to memory",
    );
  }
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA secure_delete = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    resetRuntimeEventSnapshot(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      let columns: string[];
      try {
        columns = (database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
          .map((column) => column.name);
      } catch {
        continue;
      }
      const conditions: string[] = [];
      const parameters: string[] = [];
      if (columns.includes("conversation_space")) {
        conditions.push("conversation_space = 'secret'");
      }
      if (columns.includes("secret_owner_character_id")) {
        conditions.push("secret_owner_character_id IS NOT NULL");
      }
      if (sessionIds.length) {
        const placeholders = sessionIds.map(() => "?").join(", ");
        for (const column of columns.filter((column) => sessionColumns.has(column))) {
          conditions.push(`"${column}" IN (${placeholders})`);
          parameters.push(...sessionIds);
        }
      }
      if (!conditions.length) continue;
      try {
        database.prepare(`DELETE FROM "${name}" WHERE ${conditions.join(" OR ")}`)
          .run(...parameters);
      } catch {
        // FTS shadow tables and read-only views are covered by their owning table.
      }
    }
    const skillSpaceColumns = database.prepare("PRAGMA table_info(agent_skill_space_settings)")
      .all() as Array<{ name: string }>;
    if (skillSpaceColumns.some((column) => column.name === "secret_enabled")) {
      database.prepare("DELETE FROM agent_skill_space_settings WHERE normal_enabled = 0").run();
      database.prepare("UPDATE agent_skill_space_settings SET secret_enabled = 0").run();
    }
    const providerSettingsTable = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'agent_module_provider_settings'
    `).get();
    if (providerSettingsTable) {
      // Runtime packages are deliberately not inherited by disposable child
      // kernels, so neither are their provider settings or write-only secrets.
      database.prepare("DELETE FROM agent_module_provider_settings").run();
    }
    const subagentJobsTable = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'subagent_jobs'
    `).get();
    if (subagentJobsTable) {
      // Raw delegated prompts/results belong to the persistent parent and the
      // Subagent capability is absent from disposable incognito children.
      database.prepare("DELETE FROM subagent_jobs").run();
    }
    const auditRows = database.prepare("SELECT id, payload_json FROM audit_actions").all() as Array<{
      id: string;
      payload_json: string;
    }>;
    const removeAudit = database.prepare("DELETE FROM audit_actions WHERE id = ?");
    for (const row of auditRows) {
      if (auditPayloadConversationSpace(row.payload_json) === "secret") {
        removeAudit.run(row.id);
      }
    }
    database.prepare(`
      DELETE FROM memory_retrieval_stats
      WHERE NOT EXISTS (
        SELECT 1 FROM rp_memories WHERE rp_memories.id = memory_retrieval_stats.memory_id
      )
    `).run();
    database.exec("COMMIT");
    database.exec("VACUUM");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function resetRuntimeEventSnapshot(database: DatabaseSync): void {
  if (!tableExists(database, "runtime_event_streams")) return;
  // The disposable child needs the sanitized current projection, not the
  // parent's historical event payloads. Clearing every ledger table avoids
  // retaining a deleted secret or parent-only row in a checkpoint or tombstone.
  // Child startup immediately bootstraps a fresh ledger from the scrubbed DB.
  for (const table of [
    "runtime_event_checkpoints",
    "runtime_events",
    "runtime_event_streams",
    "runtime_event_capture_catalog",
  ]) {
    if (tableExists(database, table)) database.exec(`DELETE FROM "${table}"`);
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function auditPayloadConversationSpace(payloadJson: string): "normal" | "secret" | undefined {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const scope = payload.__rp_agent_action_scope_v1;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
    const value = (scope as Record<string, unknown>).conversationSpace;
    return value === "secret" ? "secret" : value === "normal" ? "normal" : undefined;
  } catch {
    return undefined;
  }
}

type SkillSnapshotBinding = {
  skillName: string;
  sourceDir: string;
  destinationRelative: string;
};

function normalSkillSnapshotBindings(
  sourceStateDir: string,
  sourceAppDir: string,
  packages: Array<{ name: string; baseDir: string; filePath: string }>,
): SkillSnapshotBinding[] {
  const roots = [
    {
      source: join(sourceStateDir, "skills"),
      destination: "skills",
    },
    {
      source: join(sourceStateDir, "character-agent-skills"),
      // Private packages are flattened into the disposable app discovery tree.
      // The child has no package-management service or persisted binding surface.
      destination: `${INCOGNITO_APP_SNAPSHOT_DIRECTORY}/skills`,
    },
    ...APP_SKILL_DIRECTORIES.map((path) => ({
      source: join(sourceAppDir, path),
      destination: `${INCOGNITO_APP_SNAPSHOT_DIRECTORY}/${path}`,
    })),
  ].flatMap((entry) => {
    if (!existsSync(entry.source)) return [];
    const lexical = resolve(entry.source);
    const real = realpathSync(lexical);
    if (lexical !== real || lstatSync(lexical).isSymbolicLink()) {
      throw new IncognitoUnavailableError(`refusing an unsafe Skill discovery root: ${lexical}`);
    }
    return [{ ...entry, source: lexical }];
  });

  const destinations = new Map<string, { skillName: string; sourceDir: string }>();
  for (const skill of packages) {
    const baseDir = resolve(skill.baseDir);
    const filePath = resolve(skill.filePath);
    if (
      !existsSync(baseDir) || !existsSync(filePath) ||
      lstatSync(baseDir).isSymbolicLink() || lstatSync(filePath).isSymbolicLink() ||
      realpathSync(baseDir) !== baseDir || realpathSync(filePath) !== filePath ||
      filePath !== join(baseDir, "SKILL.md")
    ) {
      throw new IncognitoUnavailableError(`refusing an unsafe normal Skill package: ${baseDir}`);
    }
    const root = roots.find((entry) => isStrictlyWithin(entry.source, baseDir));
    if (!root) {
      throw new IncognitoUnavailableError(
        `normal Skill package is outside the frozen discovery roots: ${baseDir}`,
      );
    }
    const nested = relative(root.source, baseDir);
    const destinationRelative = `${root.destination}/${nested}`;
    const existing = destinations.get(destinationRelative);
    if (
      existing &&
      (existing.sourceDir !== baseDir || existing.skillName !== skill.name)
    ) {
      throw new IncognitoUnavailableError(
        `normal Skill packages collide in the disposable snapshot: ${destinationRelative}`,
      );
    }
    destinations.set(destinationRelative, {
      skillName: skill.name,
      sourceDir: baseDir,
    });
  }
  return [...destinations]
    .map(([destinationRelative, binding]) => ({
      ...binding,
      destinationRelative,
    }))
    .sort((left, right) => left.destinationRelative.localeCompare(right.destinationRelative));
}

function configureIncognitoSkillSnapshot(
  database: DatabaseSync,
  skills: readonly SkillSnapshotBinding[],
  updatedAt: string,
): void {
  const enableSkill = database.prepare(`
    INSERT INTO agent_skill_space_settings(
      module_id, normal_enabled, secret_enabled, updated_at
    ) VALUES (?, 1, 0, ?)
    ON CONFLICT(module_id) DO UPDATE SET
      normal_enabled = 1,
      secret_enabled = 0,
      updated_at = excluded.updated_at
  `);
  for (const name of new Set(skills.map((skill) => skill.skillName))) {
    enableSkill.run(`skill:${name}`, updatedAt);
  }
  database.prepare(`
    INSERT INTO agent_module_settings(module_id, enabled, updated_at)
    VALUES ('permission:character-skill-manage', 0, ?)
    ON CONFLICT(module_id) DO UPDATE SET
      enabled = 0,
      updated_at = excluded.updated_at
  `).run(updatedAt);
}

function snapshotSourceFingerprint(
  sourceStateDir: string,
  sourceAppDir: string,
  metadata?: ConversationMetadata,
  normalSkills: SkillSnapshotBinding[] = [],
): string {
  const hash = createHash("sha256");
  const budget = { bytes: 0 };
  for (const name of [
    ...SNAPSHOT_FINGERPRINT_FILES,
    ...SNAPSHOT_DIRECTORIES,
    "conversations.json",
  ] as const) {
    fingerprintEntry(join(sourceStateDir, name), name, hash, budget);
  }
  hash.update(`source-app\0${sourceAppDir}\0`);
  for (const skill of normalSkills) {
    fingerprintEntry(skill.sourceDir, skill.destinationRelative, hash, budget);
  }
  if (metadata?.piSessionFile) {
    const sourceFile = safeSourcePiSessionFile(sourceStateDir, metadata);
    fingerprintEntry(sourceFile, `pi-sessions/${basename(sourceFile)}`, hash, budget);
  }
  return hash.digest("hex");
}

function isStrictlyWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested !== "" && nested !== ".." && !nested.startsWith(`..${sep}`);
}

function fingerprintEntry(
  path: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  budget: { bytes: number },
): void {
  // Keep this boundary identical to copySnapshotEntry. It must be checked
  // before existsSync/lstatSync so workspace/repos cannot influence snapshot
  // stability or the source-size budget, including when it is a symlink.
  if (relativePath === EXCLUDED_WORKSPACE_REPOSITORIES) {
    hash.update(`workspace-repositories-skipped\0${EXCLUDED_WORKSPACE_REPOSITORIES}\0`);
    return;
  }
  if (relativePath === "memory-vault/secret") {
    hash.update("private-subtree-skipped\0memory-vault/secret\0");
    return;
  }
  if (!existsSync(path)) {
    hash.update(`missing\0${relativePath}\0`);
    return;
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    hash.update(`symlink-skipped\0${relativePath}\0`);
    return;
  }
  if (stats.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    for (const name of readdirSync(path).sort()) {
      fingerprintEntry(join(path, name), `${relativePath}/${name}`, hash, budget);
    }
    return;
  }
  if (!stats.isFile()) {
    hash.update(`special-skipped\0${relativePath}\0`);
    return;
  }
  budget.bytes += stats.size;
  if (budget.bytes > MAX_SNAPSHOT_BYTES) {
    throw new IncognitoUnavailableError(
      `the source files exceed the ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB incognito limit`,
    );
  }
  hash.update(`file\0${relativePath}\0${stats.size}\0`);
  hash.update(readFileSync(path));
}

function clearSnapshotPayload(destination: string): void {
  for (const name of [
    ...SNAPSHOT_FILES,
    ...SNAPSHOT_DIRECTORIES,
    "pi-sessions",
    "conversations.json",
    "rp-agent.sqlite",
    "rp-agent.sqlite-wal",
    "rp-agent.sqlite-shm",
    INCOGNITO_APP_SNAPSHOT_DIRECTORY,
  ]) {
    rmSync(join(destination, name), { recursive: true, force: true });
  }
}

function remapSessionReferences<T>(value: T, entry: IncognitoEntry): T {
  return remapValue(value, entry.childSessionId, entry.id) as T;
}

function remapValue(value: unknown, sourceSessionId: string, syntheticId: string): unknown {
  if (value === sourceSessionId) return syntheticId;
  if (Array.isArray(value)) {
    return value.map((entry) => remapValue(entry, sourceSessionId, syntheticId));
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = remapValue(child, sourceSessionId, syntheticId);
  }
  return output;
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
