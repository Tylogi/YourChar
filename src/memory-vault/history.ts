import { createHash, randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { Clock } from "../app/clock.js";
import { durableAtomicWrite, fsyncDirectory } from "./durability.js";
import { MemoryVaultError } from "./errors.js";
import type { VaultRawEntry } from "./journal.js";
import type {
  MemoryVaultHistoryCheckpoint,
  MemoryVaultHistoryHealth,
} from "./types.js";

const HISTORY_DIRECTORY = "memory-vault-history.git";
const PURGING_DIRECTORY = "memory-vault-history.purging";
const PURGE_MARKER = "memory-vault-history-purge.json";
const HISTORY_BRANCH = "refs/heads/main";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RESTORE_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_RESTORE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RESTORE_DOCUMENTS = 50_000;
const safeIdentifier = "[A-Za-z0-9_-]+";
const canonicalVaultPaths = [
  new RegExp(`^reality/user-profile\\.md$`, "u"),
  new RegExp(`^reality/people/${safeIdentifier}\\.md$`, "u"),
  new RegExp(`^reality/memories/${safeIdentifier}\\.md$`, "u"),
  new RegExp(`^roleplay/characters/${safeIdentifier}/SOUL\\.md$`, "u"),
  new RegExp(`^roleplay/characters/${safeIdentifier}/memories/${safeIdentifier}\\.md$`, "u"),
  new RegExp(`^roleplay/scenes/${safeIdentifier}\\.md$`, "u"),
  new RegExp(`^secret/characters/${safeIdentifier}/memories/${safeIdentifier}\\.md$`, "u"),
  new RegExp(`^legacy/quarantine/${safeIdentifier}\\.md$`, "u"),
];

export type MemoryVaultHistorySnapshot = {
  checkpoint: MemoryVaultHistoryCheckpoint;
  entries: VaultRawEntry[];
};

type CheckpointInput = {
  operation: string;
  operationId: string;
  vaultHash: string;
  documentCount: number;
  committedAt: string;
  entries: VaultRawEntry[];
  allowEmpty?: boolean;
};

/**
 * Application-owned, local-only Git history for canonical Memory Vault files.
 * The bare repository is deliberately outside the Vault work tree so Obsidian
 * scanning and character Agent Git access can never discover it by traversal.
 */
export class MemoryVaultHistory {
  private readonly repositoryPath?: string;
  private readonly purgingPath?: string;
  private readonly purgeMarkerPath?: string;
  private available = false;
  private checkpointCount = 0;
  private headCommitId: string | null = null;
  private headVaultHash: string | null = null;
  private lastCheckpointAt: string | null = null;
  private lastOperation: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly options: {
      stateDir?: string;
      vaultRoot?: string;
      clock: Clock;
    },
  ) {
    if (!options.stateDir || !options.vaultRoot) return;
    this.repositoryPath = join(options.stateDir, HISTORY_DIRECTORY);
    this.purgingPath = join(options.stateDir, PURGING_DIRECTORY);
    this.purgeMarkerPath = join(options.stateDir, PURGE_MARKER);
    try {
      this.finishInterruptedPurge();
      this.ensureRepository();
      this.refreshMetadata();
      this.available = true;
    } catch (error) {
      this.recordError(error);
    }
  }

  reconcile(input: Omit<CheckpointInput, "allowEmpty">): void {
    this.checkpoint({ ...input, allowEmpty: !this.headCommitId });
  }

  checkpoint(input: CheckpointInput): MemoryVaultHistoryCheckpoint | null {
    if (!this.repositoryPath) return null;
    try {
      this.ensureReady();
      assertCheckpointInput(input);
      const entries = input.entries.map((entry) => {
        assertCanonicalPath(entry.relativePath);
        return { relativePath: entry.relativePath, source: entry.source };
      }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index - 1].relativePath === entries[index].relativePath) {
          throw new Error(`duplicate Memory Vault history path: ${entries[index].relativePath}`);
        }
      }
      const previousCommit = this.hasHead()
        ? this.git(["rev-parse", "--verify", HISTORY_BRANCH]).trim()
        : undefined;
      if (
        previousCommit &&
        this.treeMatches(previousCommit, entries) &&
        this.headVaultHash === input.vaultHash &&
        !input.allowEmpty
      ) {
        this.available = true;
        this.lastError = null;
        this.refreshMetadata();
        return null;
      }

      const subject = `Memory Vault: ${input.operation}`;
      const body = [
        `operation-id: ${input.operationId}`,
        `vault-hash: ${input.vaultHash}`,
        `document-count: ${input.documentCount}`,
      ].join("\n");
      const fastImport = fastImportCheckpoint({
        branch: HISTORY_BRANCH,
        previousCommit,
        committedAt: input.committedAt,
        message: `${subject}\n\n${body}\n`,
        entries,
      });
      this.git(["fast-import", "--quiet", "--date-format=raw"], { input: fastImport });
      const commitId = this.git(["rev-parse", "--verify", HISTORY_BRANCH]).trim();
      const checkpoint = this.readCheckpoint(commitId);
      if (
        checkpoint.operation !== input.operation ||
        checkpoint.operationId !== input.operationId ||
        checkpoint.vaultHash !== input.vaultHash ||
        checkpoint.documentCount !== input.documentCount
      ) throw new Error("created Memory Vault history checkpoint metadata does not match input");
      this.checkpointCount += 1;
      this.headCommitId = commitId;
      this.headVaultHash = input.vaultHash;
      this.lastCheckpointAt = checkpoint.committedAt;
      this.lastOperation = input.operation;
      this.lastError = null;
      this.available = true;
      return checkpoint;
    } catch (error) {
      this.recordError(error);
      return null;
    }
  }

  list(limit = 30): MemoryVaultHistoryCheckpoint[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MemoryVaultError(
        "Memory Vault history limit must be an integer from 1 to 100",
        "MEMORY_VAULT_HISTORY_INVALID_CHECKPOINT",
      );
    }
    this.ensureReadyOrThrow();
    if (!this.headCommitId) return [];
    try {
      return this.readLog(limit);
    } catch (error) {
      this.recordError(error);
      throw historyUnavailable(error);
    }
  }

  readSnapshot(commitId: string): MemoryVaultHistorySnapshot {
    this.ensureReadyOrThrow();
    assertCommitId(commitId);
    try {
      const resolved = this.git(["rev-parse", "--verify", `${commitId}^{commit}`]).trim();
      if (resolved !== commitId) throw invalidCheckpoint("checkpoint id must be a full commit id");
      const ancestor = this.gitResult(["merge-base", "--is-ancestor", commitId, HISTORY_BRANCH]);
      if (ancestor.status !== 0) {
        if (ancestor.status === 1) throw invalidCheckpoint("checkpoint is not reachable from current history");
        throw gitFailure("merge-base", ancestor);
      }
      const checkpoint = this.readLog(100).find((entry) => entry.commitId === commitId) ??
        this.readCheckpoint(commitId);
      const records = parseTreeRecords(this.gitBuffer([
        "ls-tree", "-r", "-z", "--full-tree", commitId,
      ]));
      if (records.length > MAX_RESTORE_DOCUMENTS) {
        throw invalidCheckpoint("checkpoint contains too many documents");
      }
      const entries: VaultRawEntry[] = [];
      let totalBytes = 0;
      for (const record of records) {
        const source = this.gitBuffer(["cat-file", "blob", record.objectId]);
        if (source.byteLength > MAX_RESTORE_DOCUMENT_BYTES) {
          throw invalidCheckpoint(`checkpoint document is too large: ${record.relativePath}`);
        }
        totalBytes += source.byteLength;
        if (totalBytes > MAX_RESTORE_TOTAL_BYTES) {
          throw invalidCheckpoint("checkpoint exceeds the restore size limit");
        }
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
        } catch {
          throw invalidCheckpoint(`checkpoint document is not UTF-8: ${record.relativePath}`);
        }
        entries.push({ relativePath: record.relativePath, source: decoded });
      }
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      if (entries.length !== checkpoint.documentCount) {
        throw invalidCheckpoint("checkpoint document count does not match its metadata");
      }
      this.lastError = null;
      this.available = true;
      return { checkpoint, entries };
    } catch (error) {
      if (error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_HISTORY_INVALID_CHECKPOINT") {
        throw error;
      }
      this.recordError(error);
      throw historyUnavailable(error);
    }
  }

  beginPurge(): void {
    if (!this.purgeMarkerPath) return;
    try {
      this.assertPurgeMarkerPath();
      durableAtomicWrite(this.purgeMarkerPath, `${JSON.stringify({
        schemaVersion: 1,
        operationId: `purge-intent-${randomUUID()}`,
        createdAt: this.options.clock.now().toISOString(),
      }, null, 2)}\n`);
    } catch (error) {
      this.recordError(error);
      throw historyUnavailable(error);
    }
  }

  hasPendingPurge(): boolean {
    if (!this.purgeMarkerPath || !existsSync(this.purgeMarkerPath)) return false;
    this.assertPurgeMarkerPath();
    return true;
  }

  cancelPendingPurge(): void {
    if (!this.purgeMarkerPath || !existsSync(this.purgeMarkerPath)) return;
    this.assertPurgeMarkerPath();
    rmSync(this.purgeMarkerPath, { force: true });
    if (this.options.stateDir) fsyncDirectory(this.options.stateDir);
  }

  /**
   * Hard deletion is different from a normal checkpoint: the old object store
   * is atomically detached and recursively removed before a new baseline can be
   * initialized. Initialization failures are degradations after privacy has
   * already been achieved; failures to remove the old objects are fatal.
   */
  purgeAndReinitialize(input: Omit<CheckpointInput, "allowEmpty">): void {
    if (!this.repositoryPath || !this.purgingPath || !this.options.stateDir) return;
    try {
      this.removeManagedPath(this.purgingPath);
      if (existsSync(this.repositoryPath)) {
        const status = lstatSync(this.repositoryPath);
        if (status.isDirectory() && !status.isSymbolicLink()) {
          renameSync(this.repositoryPath, this.purgingPath);
          fsyncDirectory(this.options.stateDir);
          this.removeManagedPath(this.purgingPath);
        } else {
          this.removeManagedPath(this.repositoryPath);
        }
      }
      this.cancelPendingPurge();
    } catch (error) {
      this.recordError(error);
      throw historyUnavailable(error);
    }

    this.resetMetadata();
    try {
      this.ensureRepository();
      this.available = true;
      this.checkpoint({ ...input, allowEmpty: true });
    } catch (error) {
      // The previous object store is already gone. Memory deletion must not be
      // undone merely because a new empty history repository cannot be made.
      this.recordError(error);
    }
  }

  health(liveVaultHash: string): MemoryVaultHistoryHealth {
    return {
      enabled: Boolean(this.repositoryPath),
      available: this.available,
      checkpointCount: this.checkpointCount,
      headCommitId: this.headCommitId,
      headVaultHash: this.headVaultHash,
      lastCheckpointAt: this.lastCheckpointAt,
      lastOperation: this.lastOperation,
      checkpointPending: Boolean(this.repositoryPath && this.headVaultHash !== liveVaultHash),
      lastError: this.lastError,
    };
  }

  private ensureReadyOrThrow(): void {
    if (!this.repositoryPath) {
      throw new MemoryVaultError(
        "Memory Vault history is unavailable in in-memory mode",
        "MEMORY_VAULT_HISTORY_UNAVAILABLE",
      );
    }
    try {
      this.ensureReady();
    } catch (error) {
      this.recordError(error);
      throw historyUnavailable(error);
    }
  }

  private ensureReady(): void {
    if (this.purgeMarkerPath && existsSync(this.purgeMarkerPath)) {
      throw new Error("managed Memory Vault history purge intent is pending");
    }
    if (this.purgingPath && existsSync(this.purgingPath)) {
      throw new Error("managed Memory Vault history purge is incomplete");
    }
    this.ensureRepository();
    const bare = this.git(["config", "--bool", "--get", "core.bare"]).trim();
    if (bare !== "true") throw new Error("managed Memory Vault history is not a bare repository");
    const head = this.git(["symbolic-ref", "HEAD"]).trim();
    if (head !== HISTORY_BRANCH) throw new Error("managed Memory Vault history HEAD is not main");
    const objectFormat = this.git(["rev-parse", "--show-object-format"]).trim();
    if (objectFormat !== "sha1") throw new Error("managed Memory Vault history must use SHA-1 object ids");
    for (const relativePath of ["objects/info/alternates", "objects/info/http-alternates", "shallow"]) {
      if (this.repositoryPath && existsSync(join(this.repositoryPath, relativePath))) {
        throw new Error("managed Memory Vault history cannot use alternate or shallow object storage");
      }
    }
    this.available = true;
  }

  private ensureRepository(): void {
    if (!this.repositoryPath || !this.options.stateDir) return;
    if (!existsSync(this.repositoryPath)) this.initializeRepository();
    const status = lstatSync(this.repositoryPath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("managed Memory Vault history path must be a non-symlink directory");
    }
    chmodSync(this.repositoryPath, 0o700);
  }

  private initializeRepository(): void {
    if (!this.repositoryPath || !this.options.stateDir) return;
    const temporary = join(this.options.stateDir, `${HISTORY_DIRECTORY}.initializing-${randomUUID()}`);
    mkdirSync(temporary, { recursive: false, mode: 0o700 });
    try {
      const result = rawGit(["init", "--bare", "--object-format=sha1", "--initial-branch=main", temporary]);
      if (result.status !== 0) throw gitFailure("init", result);
      chmodSync(temporary, 0o700);
      renameSync(temporary, this.repositoryPath);
      fsyncDirectory(this.options.stateDir);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private finishInterruptedPurge(): void {
    if (!this.purgingPath) return;
    this.removeManagedPath(this.purgingPath);
  }

  private removeManagedPath(path: string): void {
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    if (this.options.stateDir) fsyncDirectory(this.options.stateDir);
  }

  private assertPurgeMarkerPath(): void {
    if (!this.purgeMarkerPath || !existsSync(this.purgeMarkerPath)) return;
    const status = lstatSync(this.purgeMarkerPath);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("managed Memory Vault history purge marker must be a regular file");
    }
  }

  private hasHead(): boolean {
    const result = this.gitResult(["rev-parse", "--verify", "--quiet", HISTORY_BRANCH]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw gitFailure("rev-parse", result);
  }

  private refreshMetadata(): void {
    if (!this.hasHead()) {
      this.resetMetadata();
      return;
    }
    const count = Number(this.git(["rev-list", "--count", HISTORY_BRANCH]).trim());
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid Memory Vault history count");
    const head = this.readLog(1)[0];
    if (!head) throw new Error("Memory Vault history has no readable head checkpoint");
    this.checkpointCount = count;
    this.headCommitId = head.commitId;
    this.headVaultHash = head.vaultHash;
    this.lastCheckpointAt = head.committedAt;
    this.lastOperation = head.operation;
  }

  private treeMatches(commitId: string, entries: VaultRawEntry[]): boolean {
    const records = parseTreeRecords(this.gitBuffer([
      "ls-tree", "-r", "-z", "--full-tree", commitId,
    ]));
    if (records.length !== entries.length) return false;
    return records.every((record, index) =>
      record.relativePath === entries[index].relativePath &&
      record.objectId === gitBlobId(entries[index].source)
    );
  }

  private resetMetadata(): void {
    this.available = false;
    this.checkpointCount = 0;
    this.headCommitId = null;
    this.headVaultHash = null;
    this.lastCheckpointAt = null;
    this.lastOperation = null;
  }

  private readLog(limit: number): MemoryVaultHistoryCheckpoint[] {
    const source = this.git([
      "log",
      `--max-count=${limit}`,
      "--format=%H%x1f%cI%x1f%s%x1f%b%x1e",
      HISTORY_BRANCH,
    ]);
    return source.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map(parseCheckpoint);
  }

  private readCheckpoint(commitId: string): MemoryVaultHistoryCheckpoint {
    const source = this.git([
      "show",
      "--quiet",
      "--format=%H%x1f%cI%x1f%s%x1f%b%x1e",
      commitId,
    ]);
    const entry = source.split("\x1e").map((value) => value.trim()).find(Boolean);
    if (!entry) throw invalidCheckpoint("checkpoint metadata is missing");
    return parseCheckpoint(entry);
  }

  private git(
    arguments_: string[],
    options: { input?: Buffer } = {},
  ): string {
    const result = this.gitResult(arguments_, options);
    if (result.status !== 0) throw gitFailure(arguments_[0] ?? "command", result);
    return result.stdout.toString("utf8");
  }

  private gitBuffer(arguments_: string[]): Buffer {
    const result = this.gitResult(arguments_);
    if (result.status !== 0) throw gitFailure(arguments_[0] ?? "command", result);
    return result.stdout;
  }

  private gitResult(
    arguments_: string[],
    options: { input?: Buffer } = {},
  ): SpawnSyncReturns<Buffer> {
    if (!this.repositoryPath || !this.options.vaultRoot) {
      throw new Error("Memory Vault history is not configured");
    }
    return rawGit([
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "-c", "core.fileMode=false",
      `--git-dir=${this.repositoryPath}`,
      ...arguments_,
    ], options);
  }

  private recordError(error: unknown): void {
    this.available = false;
    this.lastError = boundedError(error);
  }
}

function rawGit(
  arguments_: string[],
  options: { input?: Buffer } = {},
): SpawnSyncReturns<Buffer> {
  return spawnSync("git", arguments_, {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_AUTHOR_NAME: "YourChar Memory Vault",
      GIT_AUTHOR_EMAIL: "memory-vault@localhost.invalid",
      GIT_COMMITTER_NAME: "YourChar Memory Vault",
      GIT_COMMITTER_EMAIL: "memory-vault@localhost.invalid",
    },
    input: options.input,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: 30_000,
    windowsHide: true,
  });
}

function fastImportCheckpoint(input: {
  branch: string;
  previousCommit?: string;
  committedAt: string;
  message: string;
  entries: VaultRawEntry[];
}): Buffer {
  const timestamp = Math.floor(Date.parse(input.committedAt) / 1_000);
  if (!Number.isSafeInteger(timestamp)) throw new Error("invalid Memory Vault history commit time");
  const message = Buffer.from(input.message, "utf8");
  const chunks: Buffer[] = [
    protocolLine("feature done"),
    protocolLine(`commit ${input.branch}`),
    protocolLine(`author YourChar Memory Vault <memory-vault@localhost.invalid> ${timestamp} +0000`),
    protocolLine(`committer YourChar Memory Vault <memory-vault@localhost.invalid> ${timestamp} +0000`),
    protocolLine(`data ${message.byteLength}`),
    message,
    Buffer.from("\n", "utf8"),
  ];
  if (input.previousCommit) chunks.push(protocolLine(`from ${input.previousCommit}`));
  chunks.push(protocolLine("deleteall"));
  for (const entry of input.entries) {
    const source = Buffer.from(entry.source, "utf8");
    chunks.push(
      protocolLine(`M 100644 inline ${entry.relativePath}`),
      protocolLine(`data ${source.byteLength}`),
      source,
      Buffer.from("\n", "utf8"),
    );
  }
  chunks.push(protocolLine("done"));
  return Buffer.concat(chunks);
}

function protocolLine(source: string): Buffer {
  return Buffer.from(`${source}\n`, "utf8");
}

function gitBlobId(source: string): string {
  const bytes = Buffer.from(source, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function parseTreeRecords(source: Buffer): Array<{ objectId: string; relativePath: string }> {
  const records = source.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = record.match(/^100644 blob ([0-9a-f]{40})\t(.+)$/u);
    if (!match) throw invalidCheckpoint("checkpoint contains a non-canonical tree entry");
    const [, objectId, relativePath] = match;
    assertCanonicalPath(relativePath);
    return { objectId, relativePath };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].relativePath === records[index].relativePath) {
      throw invalidCheckpoint("checkpoint contains duplicate tree paths");
    }
  }
  return records;
}

function assertCheckpointInput(input: CheckpointInput): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input.operation)) {
    throw new Error("invalid Memory Vault history operation");
  }
  if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(input.operationId)) {
    throw new Error("invalid Memory Vault history operation id");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.vaultHash)) {
    throw new Error("invalid Memory Vault history hash");
  }
  if (!Number.isSafeInteger(input.documentCount) || input.documentCount < 0) {
    throw new Error("invalid Memory Vault history document count");
  }
  if (!Number.isFinite(Date.parse(input.committedAt))) {
    throw new Error("invalid Memory Vault history commit time");
  }
  if (input.entries.length !== input.documentCount) {
    throw new Error("Memory Vault history entry count does not match checkpoint metadata");
  }
}

function assertCanonicalPath(relativePath: string): void {
  if (!canonicalVaultPaths.some((pattern) => pattern.test(relativePath))) {
    throw invalidCheckpoint(`non-canonical Memory Vault history path: ${relativePath}`);
  }
}

function assertCommitId(commitId: string): void {
  if (!/^[0-9a-f]{40}$/u.test(commitId)) {
    throw invalidCheckpoint("checkpoint id must be a full lowercase SHA-1 commit id");
  }
}

function parseCheckpoint(source: string): MemoryVaultHistoryCheckpoint {
  const [commitId, committedAt, subject, ...bodyParts] = source.split("\x1f");
  const subjectMatch = subject?.match(/^Memory Vault: ([a-z][a-z0-9_]{0,63})$/u);
  const fields = new Map<string, string>(
    bodyParts.join("\x1f").split(/\r?\n/u).map((line) => {
      const separator = line.indexOf(": ");
      return (separator < 0
        ? ["", ""]
        : [line.slice(0, separator), line.slice(separator + 2)]) as [string, string];
    }).filter(([key]) => Boolean(key)),
  );
  const operationId = fields.get("operation-id");
  const vaultHash = fields.get("vault-hash");
  const countSource = fields.get("document-count");
  const documentCount = Number(countSource);
  if (
    !/^[0-9a-f]{40}$/u.test(commitId ?? "") ||
    !Number.isFinite(Date.parse(committedAt ?? "")) ||
    !subjectMatch ||
    !operationId || !/^[A-Za-z0-9:_-]{1,160}$/u.test(operationId) ||
    !vaultHash || !/^[0-9a-f]{64}$/u.test(vaultHash) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(countSource ?? "") ||
    !Number.isSafeInteger(documentCount)
  ) {
    throw invalidCheckpoint("Memory Vault history commit metadata is invalid");
  }
  return {
    commitId,
    committedAt,
    operation: subjectMatch[1],
    operationId,
    vaultHash,
    documentCount,
  };
}

function gitFailure(command: string, result: SpawnSyncReturns<Buffer>): Error {
  if (result.error) return result.error;
  const detail = result.stderr.toString("utf8").trim().replace(/\s+/gu, " ").slice(0, 300);
  return new Error(`managed Git ${command} failed${result.status === null ? "" : ` (${result.status})`}${detail ? `: ${detail}` : ""}`);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 500);
}

function invalidCheckpoint(message: string): MemoryVaultError {
  return new MemoryVaultError(message, "MEMORY_VAULT_HISTORY_INVALID_CHECKPOINT");
}

function historyUnavailable(error: unknown): MemoryVaultError {
  if (error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_HISTORY_UNAVAILABLE") return error;
  return new MemoryVaultError(
    `Memory Vault history is unavailable: ${boundedError(error)}`,
    "MEMORY_VAULT_HISTORY_UNAVAILABLE",
  );
}
