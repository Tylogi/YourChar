import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Clock } from "../app/clock.js";
import { MemoryVaultError } from "./errors.js";
import {
  durableAtomicWrite,
  fsyncDirectory,
  runFailpoint,
  type MemoryVaultFailpoint,
} from "./durability.js";
import type { MemoryVaultWriterLock } from "./writer-lock.js";

export type VaultRawEntry = { relativePath: string; source: string };
export type VaultMirrorEntry = { relativePath: string; source: string };

export type VaultJournalStage =
  | "prepared"
  | "files_committed"
  | "projection_committed"
  | "state_committed"
  | "completed"
  | "rolled_back";

export type VaultSnapshotManifest = {
  vaultHash: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  mirrors: Array<{ path: string; sha256: string; size: number }>;
  projectionStateHash: string | null;
};

export type VaultJournalRecord = {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  operation: string;
  fenceToken: number;
  stage: VaultJournalStage;
  before: VaultSnapshotManifest;
  after: VaultSnapshotManifest | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recoveryOutcome: "before" | "after" | null;
  errorCode: string | null;
};

export type VaultJournalHealth = {
  pendingCount: number;
  lastCheckpointAt: string | null;
  lastRecoveryAt: string | null;
  lastRecoveryOutcome: "before" | "after" | null;
  lastOperationId: string | null;
  operationsRetained: number;
};

export type SnapshotData = {
  schemaVersion: 1;
  vault: VaultRawEntry[];
  mirrors: VaultMirrorEntry[];
  projectionState: string | null;
};

export type VaultJournalOperation = { record: VaultJournalRecord; directory?: string };

type RecoveryStatus = {
  schemaVersion: 1;
  recoveredAt: string;
  operationId: string;
  outcome: "before" | "after";
};

export class MemoryVaultJournal {
  private readonly root?: string;
  private readonly recoveryPath?: string;
  private readonly memoryRecords: VaultJournalRecord[] = [];

  constructor(
    stateDir: string | undefined,
    private readonly clock: Clock,
    private readonly writer: MemoryVaultWriterLock,
    private readonly failpoint?: MemoryVaultFailpoint,
  ) {
    if (stateDir) {
      this.root = join(stateDir, "memory-vault-journal");
      this.recoveryPath = join(stateDir, "memory-vault-recovery.json");
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      fsyncDirectory(stateDir);
      this.cleanupOrphanedPrepares();
      this.cleanupFinishedSnapshots();
    }
  }

  prepare(
    operation: string,
    idempotencyKey: string,
    snapshot: SnapshotData,
  ): VaultJournalOperation {
    this.writer.assertOwner();
    const now = this.now();
    const operationId = `vault-op-${randomUUID()}`;
    const directory = this.root ? join(this.root, operationId) : undefined;
    if (directory) {
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      fsyncDirectory(this.root!);
      this.writeSnapshot(directory, "before", snapshot);
    }
    const record: VaultJournalRecord = {
      schemaVersion: 1,
      operationId,
      idempotencyKey,
      operation,
      fenceToken: this.writer.fenceToken,
      stage: "prepared",
      before: manifestFor(snapshot),
      after: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      recoveryOutcome: null,
      errorCode: null,
    };
    const active = { record, ...(directory ? { directory } : {}) };
    this.persist(active);
    runFailpoint(this.failpoint, "journal.after_prepare", { operationId, operation });
    return active;
  }

  filesCommitted(active: VaultJournalOperation, snapshot: SnapshotData): void {
    if (active.record.stage !== "prepared") return;
    if (active.directory) this.writeSnapshot(active.directory, "after", snapshot);
    active.record.after = manifestFor(snapshot);
    this.transition(active, "files_committed");
  }

  projectionCommitted(active: VaultJournalOperation): void {
    if (active.record.stage === "prepared") throw invalidStage(active, "projection_committed");
    if (active.record.stage === "files_committed") this.transition(active, "projection_committed");
  }

  stateCommitted(active: VaultJournalOperation): void {
    if (active.record.stage === "projection_committed") this.transition(active, "state_committed");
  }

  refreshAfter(active: VaultJournalOperation, snapshot: SnapshotData): void {
    if (active.directory) this.writeSnapshot(active.directory, "after", snapshot);
    active.record.after = manifestFor(snapshot);
    this.persist(active);
  }

  complete(active: VaultJournalOperation): void {
    if (active.record.stage === "prepared") throw invalidStage(active, "completed");
    active.record.stage = "completed";
    active.record.updatedAt = this.now();
    active.record.completedAt = active.record.updatedAt;
    this.persist(active);
    this.removeSnapshots(active);
    this.trim();
  }

  rolledBack(active: VaultJournalOperation, error: unknown): void {
    active.record.stage = "rolled_back";
    active.record.updatedAt = this.now();
    active.record.completedAt = active.record.updatedAt;
    active.record.recoveryOutcome = "before";
    active.record.errorCode = errorCode(error);
    this.persist(active);
    this.removeSnapshots(active);
    this.trim();
  }

  recoverPending(handlers: {
    restore: (snapshot: SnapshotData) => void;
    rebuild: () => void;
    alignMirrors: () => void;
  }): { recovered: number; outcomes: Array<{ operationId: string; outcome: "before" | "after" }> } {
    const outcomes: Array<{ operationId: string; outcome: "before" | "after" }> = [];
    for (const active of this.readOperations()) {
      if (active.record.stage === "completed" || active.record.stage === "rolled_back") continue;
      this.writer.assertOwner();
      const outcome = active.record.stage === "prepared" || !active.record.after ? "before" : "after";
      const snapshot = this.readSnapshot(active, outcome);
      assertManifest(snapshot, outcome === "before" ? active.record.before : active.record.after!);
      try {
        handlers.restore(snapshot);
        handlers.rebuild();
        handlers.alignMirrors();
      } catch (error) {
        throw new MemoryVaultError(
          `Memory Vault recovery failed for ${active.record.operationId}: ${error instanceof Error ? error.message : String(error)}`,
          "MEMORY_VAULT_RECOVERY_FAILED",
        );
      }
      active.record.stage = "completed";
      active.record.updatedAt = this.now();
      active.record.completedAt = active.record.updatedAt;
      active.record.recoveryOutcome = outcome;
      this.persist(active);
      this.writeRecoveryStatus(active.record.operationId, outcome);
      this.removeSnapshots(active);
      outcomes.push({ operationId: active.record.operationId, outcome });
    }
    this.trim();
    return { recovered: outcomes.length, outcomes };
  }

  health(): VaultJournalHealth {
    const operations = this.readOperations().map((entry) => entry.record)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const recovery = this.readRecoveryStatus();
    return {
      pendingCount: operations.filter((entry) => entry.stage !== "completed" && entry.stage !== "rolled_back").length,
      lastCheckpointAt: operations[0]?.updatedAt ?? null,
      lastRecoveryAt: recovery?.recoveredAt ?? null,
      lastRecoveryOutcome: recovery?.outcome ?? null,
      lastOperationId: operations[0]?.operationId ?? null,
      operationsRetained: operations.length,
    };
  }

  private transition(active: VaultJournalOperation, stage: VaultJournalStage): void {
    active.record.stage = stage;
    active.record.updatedAt = this.now();
    this.persist(active);
    runFailpoint(this.failpoint, `journal.after_${stage}`, {
      operationId: active.record.operationId,
      operation: active.record.operation,
    });
  }

  private persist(active: VaultJournalOperation): void {
    this.writer.assertOwner();
    if (!active.directory) {
      const index = this.memoryRecords.findIndex((entry) => entry.operationId === active.record.operationId);
      if (index >= 0) this.memoryRecords[index] = structuredClone(active.record);
      else this.memoryRecords.push(structuredClone(active.record));
      return;
    }
    durableAtomicWrite(
      join(active.directory, "journal.json"),
      `${JSON.stringify(active.record, null, 2)}\n`,
      { failpoint: this.failpoint, failpointPrefix: "journal_file", beforeCommit: () => this.writer.renewAndAssert() },
    );
  }

  private writeSnapshot(directory: string, name: "before" | "after", snapshot: SnapshotData): void {
    durableAtomicWrite(join(directory, `${name}.snapshot.json`), `${JSON.stringify(snapshot)}\n`, {
      failpoint: this.failpoint,
      failpointPrefix: "journal_snapshot",
      metadata: { name },
      beforeCommit: () => this.writer.renewAndAssert(),
    });
  }

  private readSnapshot(active: VaultJournalOperation, name: "before" | "after"): SnapshotData {
    if (!active.directory) throw new MemoryVaultError("in-memory journal cannot require startup recovery", "MEMORY_VAULT_RECOVERY_FAILED");
    try {
      const value = JSON.parse(readFileSync(join(active.directory, `${name}.snapshot.json`), "utf8")) as SnapshotData;
      if (value.schemaVersion !== 1 || !Array.isArray(value.vault) || !Array.isArray(value.mirrors)) throw new Error("invalid snapshot schema");
      return value;
    } catch (error) {
      throw new MemoryVaultError(
        `invalid ${name} snapshot for ${active.record.operationId}: ${error instanceof Error ? error.message : String(error)}`,
        "MEMORY_VAULT_RECOVERY_FAILED",
      );
    }
  }

  private readOperations(): VaultJournalOperation[] {
    if (!this.root) return this.memoryRecords.map((record) => ({ record: structuredClone(record) }));
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = join(this.root!, entry.name);
        try {
          const record = JSON.parse(readFileSync(join(directory, "journal.json"), "utf8")) as VaultJournalRecord;
          if (record.schemaVersion !== 1 || record.operationId !== basename(directory)) throw new Error("invalid journal identity");
          return { record, directory };
        } catch (error) {
          throw new MemoryVaultError(
            `invalid Memory Vault journal ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
            "MEMORY_VAULT_RECOVERY_FAILED",
          );
        }
      })
      .sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt));
  }

  private removeSnapshots(active: VaultJournalOperation): void {
    if (!active.directory) return;
    this.writer.renewAndAssert();
    rmSync(join(active.directory, "before.snapshot.json"), { force: true });
    this.writer.renewAndAssert();
    rmSync(join(active.directory, "after.snapshot.json"), { force: true });
    fsyncDirectory(active.directory);
  }

  private cleanupFinishedSnapshots(): void {
    if (!this.root) return;
    for (const active of this.readOperations()) {
      if (active.record.stage === "completed" || active.record.stage === "rolled_back") this.removeSnapshots(active);
    }
  }

  private cleanupOrphanedPrepares(): void {
    if (!this.root) return;
    let changed = false;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.root, entry.name);
      if (existsSync(join(directory, "journal.json"))) continue;
      // The journal record is durably renamed before any authoritative file is
      // mutated. A directory without it can only be an interrupted prepare.
      rmSync(directory, { recursive: true, force: true });
      changed = true;
    }
    if (changed) fsyncDirectory(this.root);
  }

  private trim(): void {
    if (!this.root) {
      while (this.memoryRecords.length > 100) this.memoryRecords.shift();
      return;
    }
    const finished = this.readOperations()
      .filter((entry) => entry.record.stage === "completed" || entry.record.stage === "rolled_back")
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt));
    for (const entry of finished.slice(100)) {
      this.writer.renewAndAssert();
      rmSync(entry.directory!, { recursive: true, force: true });
    }
    fsyncDirectory(this.root);
  }

  private writeRecoveryStatus(operationId: string, outcome: "before" | "after"): void {
    if (!this.recoveryPath) return;
    const status: RecoveryStatus = {
      schemaVersion: 1,
      recoveredAt: this.now(),
      operationId,
      outcome,
    };
    durableAtomicWrite(this.recoveryPath, `${JSON.stringify(status, null, 2)}\n`, {
      failpoint: this.failpoint,
      failpointPrefix: "recovery_file",
      beforeCommit: () => this.writer.renewAndAssert(),
    });
  }

  private readRecoveryStatus(): RecoveryStatus | undefined {
    if (!this.recoveryPath || !existsSync(this.recoveryPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.recoveryPath, "utf8")) as RecoveryStatus;
      return value.schemaVersion === 1 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

export function createJournalSnapshot(input: {
  vault: VaultRawEntry[];
  mirrors: VaultMirrorEntry[];
  projectionState: string | null;
}): SnapshotData {
  return {
    schemaVersion: 1,
    vault: input.vault.map((entry) => ({ ...entry })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    mirrors: input.mirrors.map((entry) => ({ ...entry })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    projectionState: input.projectionState,
  };
}

function manifestFor(snapshot: SnapshotData): VaultSnapshotManifest {
  const files = snapshot.vault.map((entry) => fileManifest(entry.relativePath, entry.source));
  const mirrors = snapshot.mirrors.map((entry) => fileManifest(entry.relativePath, entry.source));
  return {
    vaultHash: createHash("sha256").update(files.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n")).digest("hex"),
    files,
    mirrors,
    projectionStateHash: snapshot.projectionState === null ? null : sha(snapshot.projectionState),
  };
}

function assertManifest(snapshot: SnapshotData, expected: VaultSnapshotManifest): void {
  const actual = manifestFor(snapshot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new MemoryVaultError("Memory Vault journal snapshot hash mismatch", "MEMORY_VAULT_RECOVERY_FAILED");
  }
}

function fileManifest(path: string, source: string) {
  return { path, sha256: sha(source), size: Buffer.byteLength(source) };
}

function sha(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

function invalidStage(active: VaultJournalOperation, next: string): MemoryVaultError {
  return new MemoryVaultError(
    `journal ${active.record.operationId} cannot transition from ${active.record.stage} to ${next}`,
    "MEMORY_VAULT_RECOVERY_FAILED",
  );
}
