import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppDatabase } from "../storage/database.js";
import type { VaultDocument } from "./types.js";
import { MemoryVaultError } from "./errors.js";
import { durableAtomicWrite, fsyncDirectory, isSimulatedCrash, runFailpoint, type MemoryVaultFailpoint } from "./durability.js";

export type MemoryVaultProjectionState = {
  schemaVersion: 1;
  vaultHash: string;
  documentCount: number;
  rebuiltAt: string;
  documentHashes: Record<string, string>;
};

export type MemoryVaultRebuildResult = MemoryVaultProjectionState & {
  memories: number;
  scenes: number;
};

export class MemoryVaultProjection {
  private memoryState?: MemoryVaultProjectionState;

  constructor(
    private readonly database: AppDatabase,
    private readonly statePath?: string,
    private readonly hooks: {
      beforeProjectionCommit?: () => void;
      afterProjectionCommit?: () => void;
      beforeStateCommit?: () => void;
      afterStateCommit?: () => void;
      failpoint?: MemoryVaultFailpoint;
      beforeDurableCommit?: () => void;
    } = {},
  ) {}

  readState(): MemoryVaultProjectionState | undefined {
    if (!this.statePath) return this.memoryState;
    if (!existsSync(this.statePath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<MemoryVaultProjectionState>;
      if (
        value.schemaVersion !== 1 ||
        typeof value.vaultHash !== "string" ||
        typeof value.documentCount !== "number" ||
        typeof value.rebuiltAt !== "string" ||
        !value.documentHashes || typeof value.documentHashes !== "object"
      ) return undefined;
      return value as MemoryVaultProjectionState;
    } catch {
      return undefined;
    }
  }

  rebuild(documents: VaultDocument[], vaultHash: string, rebuiltAt: string): MemoryVaultRebuildResult {
    const memories = documents.filter((document) => document.metadata.kind === "memory");
    const scenes = documents.filter((document) => document.metadata.kind === "scene");
    preflight(this.database, memories, scenes);
    this.hooks.beforeProjectionCommit?.();
    runFailpoint(this.hooks.failpoint, "projection.before_commit");

    try {
      this.database.transaction(() => {
        const connection = this.database.connection;
        connection.prepare("DELETE FROM scene_states").run();
        connection.prepare("DELETE FROM rp_memories_fts").run();
        connection.prepare("UPDATE rp_memories SET superseded_by_id = NULL").run();
        connection.prepare("DELETE FROM rp_memories").run();

        const insertScene = connection.prepare(`
          INSERT INTO scene_states(
            role_session_id, location, in_world_time, participants_json,
            current_objective, open_threads_json, summary, last_tool_call_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const document of scenes.sort(byId)) {
          const scene = document.metadata.scene!;
          insertScene.run(
            document.metadata.sessionId!,
            scene.location,
            scene.inWorldTime,
            JSON.stringify(scene.participants),
            scene.currentObjective,
            JSON.stringify(scene.openThreads),
            document.body,
            document.metadata.idempotencyKey,
            document.metadata.updatedAt,
          );
        }

        const insertMemory = connection.prepare(`
          INSERT INTO rp_memories(
            id, realm, scope, type, memory_key, content, normalized_content, source_session_id,
            source_message_id, character_id, salience, confidence, validity,
            confirmed, confirmation_kind, confirmed_at, confirmation_evidence_message_id,
            rejected_at, archived_at, deleted_at, status_reason,
            tags_json, superseded_by_id, idempotency_key,
            created_at, updated_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `);
        const insertFts = connection.prepare(
          "INSERT INTO rp_memories_fts(memory_id, content, tags) VALUES (?, ?, ?)",
        );
        for (const document of memories.sort(byId)) {
          const metadata = document.metadata;
          insertMemory.run(
            metadata.id,
            metadata.realm,
            metadata.scope,
            metadata.type!,
            metadata.memoryKey,
            document.body.trimEnd(),
            normalizeMemoryContent(document.body),
            metadata.sourceSessionId,
            metadata.sourceMessageId,
            metadata.characterId,
            metadata.salience!,
            metadata.confidence!,
            metadata.validity!,
            metadata.confirmed ? 1 : 0,
            metadata.confirmationProvenance?.kind ?? null,
            metadata.confirmationProvenance?.confirmedAt ?? null,
            metadata.confirmationProvenance?.evidenceMessageId ?? null,
            metadata.rejectedAt,
            metadata.archivedAt,
            metadata.deletedAt,
            metadata.statusReason,
            JSON.stringify(metadata.tags),
            metadata.idempotencyKey,
            metadata.createdAt,
            metadata.updatedAt,
            metadata.lastUsedAt,
          );
          if (!["rejected", "archived", "deleted"].includes(metadata.validity!)) {
            insertFts.run(metadata.id, document.body.trimEnd(), metadata.tags.join(" "));
          }
        }

        const setSuccessor = connection.prepare("UPDATE rp_memories SET superseded_by_id = ? WHERE id = ?");
        for (const document of memories.filter((entry) => entry.metadata.supersedes).sort(byId)) {
          setSuccessor.run(document.metadata.id, document.metadata.supersedes!);
        }
      });
      this.hooks.afterProjectionCommit?.();
      runFailpoint(this.hooks.failpoint, "projection.after_commit");
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      throw new MemoryVaultError(
        `vault rebuild failed; SQLite projection was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        "MEMORY_VAULT_REBUILD_FAILED",
      );
    }

    const state: MemoryVaultProjectionState = {
      schemaVersion: 1,
      vaultHash,
      documentCount: documents.length,
      rebuiltAt,
      documentHashes: Object.fromEntries(
        documents
          .map((document) => [document.relativePath, document.documentHash] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    try {
      this.hooks.beforeStateCommit?.();
      runFailpoint(this.hooks.failpoint, "projection_state.before_write");
      this.writeState(state);
      this.hooks.afterStateCommit?.();
      runFailpoint(this.hooks.failpoint, "projection_state.after_write");
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      throw new MemoryVaultError(
        `SQLite projection committed but projection state could not be written: ${error instanceof Error ? error.message : String(error)}`,
        "MEMORY_VAULT_REBUILD_FAILED",
      );
    }
    return { ...state, memories: memories.length, scenes: scenes.length };
  }

  clearState(): void {
    this.memoryState = undefined;
    if (this.statePath) {
      rmSync(this.statePath, { force: true });
      fsyncDirectory(dirname(this.statePath));
    }
  }

  private writeState(state: MemoryVaultProjectionState): void {
    if (!this.statePath) {
      this.memoryState = state;
      return;
    }
    durableAtomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      failpoint: this.hooks.failpoint,
      failpointPrefix: "projection_state_file",
      beforeCommit: this.hooks.beforeDurableCommit,
    });
  }
}

function preflight(database: AppDatabase, memories: VaultDocument[], scenes: VaultDocument[]): void {
  const characterIds = new Set(
    (database.connection.prepare("SELECT id FROM characters").all() as Array<{ id: string }>).map((row) => row.id),
  );
  const sessionIds = new Set(
    (database.connection.prepare("SELECT app_session_id FROM role_sessions").all() as Array<{ app_session_id: string }>).
      map((row) => row.app_session_id),
  );
  for (const document of memories) {
    if (document.metadata.realm === "roleplay" && !characterIds.has(document.metadata.characterId!)) {
      invalid(`memory ${document.metadata.id} references unknown character ${document.metadata.characterId}`);
    }
  }
  for (const document of scenes) {
    if (!sessionIds.has(document.metadata.sessionId!)) {
      invalid(`scene ${document.metadata.id} references unknown role session ${document.metadata.sessionId}`);
    }
  }
  const memoryIds = new Set(memories.map((document) => document.metadata.id));
  const superseded = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const document of memories) {
    const previous = document.metadata.supersedes;
    if (previous && (!memoryIds.has(previous) || previous === document.metadata.id)) {
      invalid(`memory ${document.metadata.id} has invalid supersedes target ${previous}`);
    }
    if (previous && superseded.has(previous)) invalid(`multiple memories supersede ${previous}`);
    if (previous) superseded.add(previous);
    const key = document.metadata.idempotencyKey;
    if (key && idempotencyKeys.has(key)) invalid(`duplicate memory idempotency key ${key}`);
    if (key) idempotencyKeys.add(key);
  }
}

function normalizeMemoryContent(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]+/g, "");
}

function byId(left: VaultDocument, right: VaultDocument): number {
  return left.metadata.id.localeCompare(right.metadata.id);
}

function invalid(message: string): never {
  throw new MemoryVaultError(message, "MEMORY_VAULT_REBUILD_FAILED");
}
