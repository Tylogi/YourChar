import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace, Mode } from "../domain/types.js";
import type { WorkspaceAccess } from "../modules/types.js";
import {
  bubblewrapPath,
  sandboxArguments,
} from "../pi/sandboxed-shell-tool.js";
import type { AppDatabase } from "../storage/database.js";

export const maximumExecutionCommandCharacters = 32_768;
export const maximumExecutionTimeoutSeconds = 3_600;
export const maximumExecutionOutputBytes = 8 * 1_024 * 1_024;
export const maximumExecutionOutputPageBytes = 64 * 1_024;
export const defaultExecutionOutputPageBytes = 16 * 1_024;
export const maximumExecutionJobAttempts = 3;

const defaultExecutionTimeoutSeconds = 300;
const outputChunkBytes = 4 * 1_024;
const maximumListLimit = 100;
const maximumActiveJobs = 8;
const maximumActiveJobsPerSession = 4;

export type ExecutionJobStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionRunStatus =
  | "running"
  | "abandoned"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionFailureReason =
  | "process_restarted"
  | "runtime_shutdown"
  | "spawn_error"
  | "exit_nonzero"
  | "timeout"
  | "interrupted"
  | "runtime_error";

export type ExecutionRunSummary = Readonly<{
  attempt: number;
  status: ExecutionRunStatus;
  workspaceAccess: WorkspaceAccess;
  networkEnabled: boolean;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode?: number;
  timedOut: boolean;
  failureReason?: ExecutionFailureReason;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type ExecutionJobSummary = Readonly<{
  id: string;
  parentSessionId: string;
  status: ExecutionJobStatus;
  revision: number;
  commandSha256: string;
  commandCharacters: number;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  grants: Readonly<{
    workspaceAccess: WorkspaceAccess;
    networkEnabled: boolean;
  }>;
  timeoutSeconds: number;
  maxOutputBytes: number;
  currentAttempt: number;
  maxAttempts: number;
  run?: ExecutionRunSummary;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type ExecutionJobDetail = ExecutionJobSummary & Readonly<{
  runs: readonly ExecutionRunSummary[];
}>;

export type ExecutionOutputChunk = Readonly<{
  sequence: number;
  stream: "stdout" | "stderr";
  text: string;
  bytes: number;
}>;

export type ExecutionOutputPage = Readonly<{
  jobId: string;
  attempt: number;
  cursor: number;
  nextCursor: number;
  returnedBytes: number;
  totalBytes: number;
  outputTruncated: boolean;
  eof: boolean;
  chunks: readonly ExecutionOutputChunk[];
}>;

export type StartExecutionJobInput = Readonly<{
  parentSessionId: string;
  command: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  workspaceKey: string;
  workspaceDir: string;
  workspaceAccess: WorkspaceAccess;
  networkEnabled: boolean;
  timeoutSeconds?: number;
  /** Host-owned idempotency key used by durable orchestrators. */
  admissionKey?: string;
}>;

export type RetryExecutionJobInput = Readonly<{
  parentSessionId: string;
  jobId: string;
  workspaceKey: string;
  workspaceDir: string;
  workspaceAccess: WorkspaceAccess;
  networkEnabled: boolean;
}>;

export type ExecutionJobTerminalListener = (job: ExecutionJobSummary) => void;

type ExecutionJobRow = {
  id: string;
  parent_session_id: string;
  status: string;
  revision: number;
  command_text: string;
  command_sha256: string;
  command_characters: number;
  mode: string;
  conversation_space: string;
  character_id: string | null;
  secret_owner_character_id: string | null;
  workspace_key: string;
  workspace_dir: string;
  workspace_access: string;
  network_enabled: number;
  timeout_seconds: number;
  max_output_bytes: number;
  current_attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  admission_key: string | null;
};

type ExecutionRunRow = {
  job_id: string;
  attempt: number;
  status: string;
  owner_id: string | null;
  claim_token: string | null;
  workspace_access: string;
  network_enabled: number;
  output_bytes: number;
  output_truncated: number;
  exit_code: number | null;
  timed_out: number;
  failure_reason: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
};

type OutputChunkRow = {
  sequence: number;
  stream: string;
  content: Uint8Array;
  bytes: number;
};

type ActiveExecution = {
  jobId: string;
  parentSessionId: string;
  attempt: number;
  claimToken: string;
  child: ChildProcess;
  timeout?: NodeJS.Timeout;
  retainedBytes: number;
  nextSequence: number;
  outputTruncated: boolean;
  decoders: Readonly<{
    stdout: StringDecoder;
    stderr: StringDecoder;
  }>;
  stopReason?: Extract<ExecutionFailureReason, "timeout" | "interrupted" | "runtime_error">;
  settled: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

export class ExecutionJobNotFoundError extends Error {
  readonly code = "EXECUTION_JOB_NOT_FOUND";

  constructor(jobId: string) {
    super(`Execution job is unavailable: ${jobId}`);
    this.name = "ExecutionJobNotFoundError";
  }
}

export class ExecutionJobStateError extends Error {
  readonly code = "EXECUTION_JOB_STATE_CONFLICT";

  constructor(jobId: string, expected: string) {
    super(`Execution job ${jobId} is no longer ${expected}`);
    this.name = "ExecutionJobStateError";
  }
}

export class ExecutionJobValidationError extends Error {
  readonly code = "EXECUTION_JOB_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionJobValidationError";
  }
}

export class ExecutionJobCapacityError extends Error {
  readonly code = "EXECUTION_JOB_CAPACITY";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionJobCapacityError";
  }
}

/**
 * Host-owned background shell execution. Commands and output remain private
 * execution artifacts; public projections expose only hashes, lifecycle, and
 * explicitly requested bounded output pages.
 */
export class ExecutionJobService {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly ownerId = `execution-runtime:${randomUUID()}`;
  private disposed = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly onTerminal?: ExecutionJobTerminalListener,
  ) {
    this.stageInterruptedJobs();
  }

  start(input: StartExecutionJobInput): ExecutionJobSummary {
    this.assertAvailable();
    validateStartInput(input);
    this.assertCapacity(input.parentSessionId);
    const id = this.idGenerator.next("execution-job");
    const now = this.clock.now().toISOString();
    const workspaceDir = realpathSync(input.workspaceDir);
    this.database.connection.prepare(`
      INSERT INTO execution_jobs(
        id, parent_session_id, status, revision, command_text, command_sha256,
        command_characters, mode, conversation_space, character_id,
        secret_owner_character_id, workspace_key, workspace_dir,
        workspace_access, network_enabled, timeout_seconds, max_output_bytes,
        current_attempt, admission_key, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?)
    `).run(
      id,
      input.parentSessionId,
      input.command,
      createHash("sha256").update(input.command).digest("hex"),
      [...input.command].length,
      input.mode,
      input.conversationSpace,
      input.characterId ?? null,
      input.secretOwnerCharacterId ?? null,
      input.workspaceKey,
      workspaceDir,
      input.workspaceAccess,
      input.networkEnabled ? 1 : 0,
      input.timeoutSeconds ?? defaultExecutionTimeoutSeconds,
      maximumExecutionOutputBytes,
      input.admissionKey ?? null,
      now,
      now,
    );
    return this.launch(id, input.workspaceAccess, input.networkEnabled);
  }

  getByAdmissionKey(
    parentSessionId: string,
    admissionKey: string,
  ): ExecutionJobSummary | undefined {
    validateParentSessionId(parentSessionId);
    validateAdmissionKey(admissionKey);
    const row = this.database.connection.prepare(`
      SELECT * FROM execution_jobs
      WHERE parent_session_id = ? AND admission_key = ?
    `).get(parentSessionId, admissionKey) as unknown as ExecutionJobRow | undefined;
    return row ? this.mapSummary(row) : undefined;
  }

  retry(input: RetryExecutionJobInput): ExecutionJobSummary {
    this.assertAvailable();
    const row = this.requireScopedRow(input.parentSessionId, input.jobId);
    if (!["idle", "failed", "cancelled"].includes(row.status)) {
      throw new ExecutionJobStateError(input.jobId, "idle, failed, or cancelled");
    }
    if (row.current_attempt >= maximumExecutionJobAttempts) {
      throw new ExecutionJobStateError(input.jobId, "within its retry limit");
    }
    if (input.workspaceKey !== row.workspace_key || realpathSync(input.workspaceDir) !== row.workspace_dir) {
      throw new ExecutionJobStateError(input.jobId, "in its original Workspace scope");
    }
    this.assertCapacity(input.parentSessionId);
    const workspaceAccess = narrowerWorkspaceAccess(
      row.workspace_access as WorkspaceAccess,
      input.workspaceAccess,
    );
    const networkEnabled = Boolean(row.network_enabled) && input.networkEnabled;
    return this.launch(input.jobId, workspaceAccess, networkEnabled);
  }

  list(parentSessionId: string, limit = 20): readonly ExecutionJobSummary[] {
    validateParentSessionId(parentSessionId);
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumListLimit) {
      throw new ExecutionJobValidationError("limit must be an integer between 1 and 100");
    }
    const rows = this.database.connection.prepare(`
      SELECT * FROM execution_jobs
      WHERE parent_session_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(parentSessionId, limit) as unknown as ExecutionJobRow[];
    return Object.freeze(rows.map((row) => this.mapSummary(row)));
  }

  get(parentSessionId: string, jobId: string): ExecutionJobDetail | undefined {
    validateParentSessionId(parentSessionId);
    const row = this.findScopedRow(parentSessionId, jobId);
    if (!row) return undefined;
    const runs = this.database.connection.prepare(`
      SELECT * FROM execution_job_runs
      WHERE job_id = ? ORDER BY attempt ASC
    `).all(jobId) as unknown as ExecutionRunRow[];
    return Object.freeze({
      ...this.mapSummary(row),
      runs: Object.freeze(runs.map(mapRunSummary)),
    });
  }

  output(
    parentSessionId: string,
    jobId: string,
    options: { attempt?: number; cursor?: number; limitBytes?: number } = {},
  ): ExecutionOutputPage {
    const job = this.requireScopedRow(parentSessionId, jobId);
    const attempt = options.attempt ?? job.current_attempt;
    const cursor = options.cursor ?? 0;
    const limitBytes = options.limitBytes ?? defaultExecutionOutputPageBytes;
    if (!Number.isInteger(attempt) || attempt < 0 || attempt > maximumExecutionJobAttempts) {
      throw new ExecutionJobValidationError("attempt must be an integer between 0 and 3");
    }
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > maximumExecutionOutputBytes) {
      throw new ExecutionJobValidationError("cursor must be a non-negative integer");
    }
    if (
      !Number.isInteger(limitBytes) ||
      limitBytes < outputChunkBytes ||
      limitBytes > maximumExecutionOutputPageBytes
    ) {
      throw new ExecutionJobValidationError(
        `limitBytes must be an integer between ${outputChunkBytes} and ${maximumExecutionOutputPageBytes}`,
      );
    }
    if (attempt === 0) {
      return Object.freeze({
        jobId,
        attempt,
        cursor,
        nextCursor: cursor,
        returnedBytes: 0,
        totalBytes: 0,
        outputTruncated: false,
        eof: job.status !== "running" && job.status !== "queued",
        chunks: Object.freeze([]),
      });
    }
    const run = this.findRunRow(jobId, attempt);
    if (!run) throw new ExecutionJobStateError(jobId, `recorded attempt ${attempt}`);
    const rows = this.database.connection.prepare(`
      SELECT sequence, stream, content, bytes
      FROM execution_job_output_chunks
      WHERE job_id = ? AND attempt = ? AND sequence >= ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(jobId, attempt, cursor, limitBytes + 1) as unknown as OutputChunkRow[];
    const selected: ExecutionOutputChunk[] = [];
    let returnedBytes = 0;
    let nextCursor = cursor;
    for (const row of rows) {
      if (returnedBytes + Number(row.bytes) > limitBytes) break;
      const content = Buffer.from(row.content);
      selected.push(Object.freeze({
        sequence: Number(row.sequence),
        stream: row.stream as "stdout" | "stderr",
        text: content.toString("utf8"),
        bytes: Number(row.bytes),
      }));
      returnedBytes += Number(row.bytes);
      nextCursor = Number(row.sequence) + 1;
    }
    const nextStored = this.database.connection.prepare(`
      SELECT 1 FROM execution_job_output_chunks
      WHERE job_id = ? AND attempt = ? AND sequence >= ? LIMIT 1
    `).get(jobId, attempt, nextCursor);
    return Object.freeze({
      jobId,
      attempt,
      cursor,
      nextCursor,
      returnedBytes,
      totalBytes: Number(run.output_bytes),
      outputTruncated: Boolean(run.output_truncated),
      eof: !nextStored && run.status !== "running",
      chunks: Object.freeze(selected),
    });
  }

  async interrupt(parentSessionId: string, jobId: string): Promise<ExecutionJobSummary> {
    const row = this.requireScopedRow(parentSessionId, jobId);
    if (["completed", "failed", "cancelled"].includes(row.status)) {
      return this.mapSummary(row);
    }
    const active = this.active.get(jobId);
    if (active && active.parentSessionId === parentSessionId) {
      active.stopReason = "interrupted";
      terminate(active.child);
      await active.completion;
      return this.requireSummary(parentSessionId, jobId);
    }
    const now = this.clock.now().toISOString();
    const update = this.database.connection.prepare(`
      UPDATE execution_jobs
      SET status = 'cancelled', revision = revision + 1,
          finished_at = ?, updated_at = ?
      WHERE id = ? AND parent_session_id = ? AND status IN ('queued', 'idle')
    `).run(now, now, jobId, parentSessionId);
    if (Number(update.changes) !== 1) {
      throw new ExecutionJobStateError(jobId, "interruptible");
    }
    const summary = this.requireSummary(parentSessionId, jobId);
    this.notifyTerminal(summary);
    return summary;
  }

  hasActiveJob(parentSessionId?: string): boolean {
    if (parentSessionId === undefined) return this.active.size > 0;
    return [...this.active.values()].some((entry) => entry.parentSessionId === parentSessionId);
  }

  get isBusy(): boolean {
    return this.active.size > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const execution of [...this.active.values()]) {
      this.abandon(execution, "runtime_shutdown");
    }
  }

  private launch(
    jobId: string,
    workspaceAccess: WorkspaceAccess,
    networkEnabled: boolean,
  ): ExecutionJobSummary {
    const before = this.requireRow(jobId);
    if (!["queued", "idle", "failed", "cancelled"].includes(before.status)) {
      throw new ExecutionJobStateError(jobId, "available to run");
    }
    const attempt = before.current_attempt + 1;
    if (attempt > maximumExecutionJobAttempts) {
      throw new ExecutionJobStateError(jobId, "within its retry limit");
    }
    const claimToken = this.idGenerator.next("execution-claim");
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO execution_job_runs(
          job_id, attempt, status, owner_id, claim_token, workspace_access,
          network_enabled, output_bytes, output_truncated, exit_code, timed_out,
          failure_reason, started_at, finished_at, updated_at
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, 0, 0, NULL, 0, NULL, ?, NULL, ?)
      `).run(
        jobId,
        attempt,
        this.ownerId,
        claimToken,
        workspaceAccess,
        networkEnabled ? 1 : 0,
        now,
        now,
      );
      const update = this.database.connection.prepare(`
        UPDATE execution_jobs
        SET status = 'running', revision = revision + 1,
            current_attempt = ?, started_at = COALESCE(started_at, ?),
            finished_at = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND status IN ('queued', 'idle', 'failed', 'cancelled')
      `).run(attempt, now, now, jobId, before.revision);
      if (Number(update.changes) !== 1) {
        throw new ExecutionJobStateError(jobId, "available to run");
      }
    });

    let child: ChildProcess;
    try {
      child = spawn(
        bubblewrapPath,
        sandboxArguments({
          workspaceDir: before.workspace_dir,
          workspaceAccess,
          networkEnabled,
        }, before.command_text, networkEnabled),
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        },
      );
    } catch {
      const summary = this.finalizeClaim(jobId, attempt, claimToken, null, "spawn_error");
      if (summary) this.notifyTerminal(summary);
      return this.requireSummary(before.parent_session_id, jobId);
    }

    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveExecution = {
      jobId,
      parentSessionId: before.parent_session_id,
      attempt,
      claimToken,
      child,
      retainedBytes: 0,
      nextSequence: 0,
      outputTruncated: false,
      decoders: Object.freeze({
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      }),
      settled: false,
      completion,
      resolveCompletion,
    };
    active.timeout = setTimeout(() => {
      active.stopReason = "timeout";
      terminate(child);
    }, before.timeout_seconds * 1_000);
    active.timeout.unref?.();
    this.active.set(jobId, active);

    child.stdout?.on("data", (chunk: Buffer) => this.captureOutput(active, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.captureOutput(active, "stderr", chunk));
    child.once("error", () => this.settle(active, null, "spawn_error"));
    child.once("close", (exitCode) => this.settle(active, exitCode, active.stopReason));
    return this.requireSummary(before.parent_session_id, jobId);
  }

  private captureOutput(
    active: ActiveExecution,
    stream: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    if (this.disposed || active.settled || !chunk.length) return;
    try {
      this.captureDecodedOutput(active, stream, active.decoders[stream].write(chunk));
    } catch {
      active.stopReason = "runtime_error";
      terminate(active.child);
    }
  }

  private captureDecodedOutput(
    active: ActiveExecution,
    stream: "stdout" | "stderr",
    text: string,
  ): void {
    if (!text) return;
    const job = this.requireRow(active.jobId);
    const remaining = Math.max(0, job.max_output_bytes - active.retainedBytes);
    const encoded = Buffer.from(text, "utf8");
    const selectedBytes = utf8PrefixLength(encoded, Math.min(remaining, encoded.length));
    if (selectedBytes > 0) {
      this.persistOutput(active, stream, encoded.subarray(0, selectedBytes));
    }
    if (selectedBytes < encoded.length) this.markOutputTruncated(active);
  }

  private persistOutput(
    active: ActiveExecution,
    stream: "stdout" | "stderr",
    source: Buffer,
  ): void {
    let offset = 0;
    this.database.transaction(() => {
      while (offset < source.length) {
        const desired = Math.min(outputChunkBytes, source.length - offset);
        const take = utf8PrefixLength(source.subarray(offset), desired);
        if (take <= 0) throw new Error("execution output chunk could not make progress");
        const content = Buffer.from(source.subarray(offset, offset + take));
        const sequence = active.nextSequence;
        this.database.connection.prepare(`
          INSERT INTO execution_job_output_chunks(
            job_id, attempt, sequence, stream, content, bytes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          active.jobId,
          active.attempt,
          sequence,
          stream,
          content,
          content.length,
          this.clock.now().toISOString(),
        );
        active.nextSequence += 1;
        active.retainedBytes += take;
        offset += take;
      }
      const update = this.database.connection.prepare(`
        UPDATE execution_job_runs
        SET output_bytes = ?, updated_at = ?
        WHERE job_id = ? AND attempt = ? AND status = 'running' AND claim_token = ?
      `).run(
        active.retainedBytes,
        this.clock.now().toISOString(),
        active.jobId,
        active.attempt,
        active.claimToken,
      );
      if (Number(update.changes) !== 1) throw new Error("execution output claim was lost");
    });
  }

  private markOutputTruncated(active: ActiveExecution): void {
    if (active.outputTruncated) return;
    active.outputTruncated = true;
    this.database.connection.prepare(`
      UPDATE execution_job_runs
      SET output_truncated = 1, updated_at = ?
      WHERE job_id = ? AND attempt = ? AND status = 'running' AND claim_token = ?
    `).run(
      this.clock.now().toISOString(),
      active.jobId,
      active.attempt,
      active.claimToken,
    );
  }

  private settle(
    active: ActiveExecution,
    exitCode: number | null,
    reason?: Extract<ExecutionFailureReason, "timeout" | "interrupted" | "spawn_error" | "runtime_error">,
  ): void {
    if (active.settled) return;
    if (!this.disposed) {
      try {
        this.captureDecodedOutput(active, "stdout", active.decoders.stdout.end());
        this.captureDecodedOutput(active, "stderr", active.decoders.stderr.end());
      } catch {
        reason = "runtime_error";
      }
    }
    active.settled = true;
    if (active.timeout) clearTimeout(active.timeout);
    this.active.delete(active.jobId);
    if (!this.disposed) {
      const failureReason = reason ?? (exitCode === 0 ? undefined : "exit_nonzero");
      const summary = this.finalizeClaim(
        active.jobId,
        active.attempt,
        active.claimToken,
        exitCode,
        failureReason,
      );
      if (summary) this.notifyTerminal(summary);
    }
    active.resolveCompletion();
  }

  private finalizeClaim(
    jobId: string,
    attempt: number,
    claimToken: string,
    exitCode: number | null,
    failureReason?: Extract<
      ExecutionFailureReason,
      "spawn_error" | "exit_nonzero" | "timeout" | "interrupted" | "runtime_error"
    >,
  ): ExecutionJobSummary | undefined {
    const now = this.clock.now().toISOString();
    const runStatus: ExecutionRunStatus = failureReason === undefined
      ? "completed"
      : failureReason === "interrupted" ? "cancelled" : "failed";
    const jobStatus: ExecutionJobStatus = runStatus === "cancelled" ? "cancelled" : runStatus;
    const changed = this.database.transaction(() => {
      const runUpdate = this.database.connection.prepare(`
        UPDATE execution_job_runs
        SET status = ?, owner_id = NULL, claim_token = NULL,
            exit_code = ?, timed_out = ?, failure_reason = ?,
            finished_at = ?, updated_at = ?
        WHERE job_id = ? AND attempt = ? AND status = 'running' AND claim_token = ?
      `).run(
        runStatus,
        exitCode,
        failureReason === "timeout" ? 1 : 0,
        failureReason ?? null,
        now,
        now,
        jobId,
        attempt,
        claimToken,
      );
      const jobUpdate = this.database.connection.prepare(`
        UPDATE execution_jobs
        SET status = ?, revision = revision + 1, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_attempt = ?
      `).run(jobStatus, now, now, jobId, attempt);
      const runChanged = Number(runUpdate.changes) === 1;
      const jobChanged = Number(jobUpdate.changes) === 1;
      if (runChanged !== jobChanged) {
        throw new Error("execution job and run claims diverged");
      }
      return runChanged;
    });
    if (!changed) return undefined;
    return this.mapSummary(this.requireRow(jobId));
  }

  private abandon(active: ActiveExecution, reason: "runtime_shutdown"): void {
    if (active.settled) return;
    active.settled = true;
    if (active.timeout) clearTimeout(active.timeout);
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE execution_job_runs
        SET status = 'abandoned', owner_id = NULL, claim_token = NULL,
            failure_reason = ?, finished_at = ?, updated_at = ?
        WHERE job_id = ? AND attempt = ? AND status = 'running' AND claim_token = ?
      `).run(reason, now, now, active.jobId, active.attempt, active.claimToken);
      this.database.connection.prepare(`
        UPDATE execution_jobs
        SET status = 'idle', revision = revision + 1,
            finished_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_attempt = ?
      `).run(now, active.jobId, active.attempt);
    });
    this.active.delete(active.jobId);
    terminate(active.child);
    active.resolveCompletion();
  }

  private stageInterruptedJobs(): void {
    const now = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE execution_job_runs
        SET status = 'abandoned', owner_id = NULL, claim_token = NULL,
            failure_reason = 'process_restarted', finished_at = ?, updated_at = ?
        WHERE status = 'running'
      `).run(now, now);
      this.database.connection.prepare(`
        UPDATE execution_jobs
        SET status = 'idle', revision = revision + 1,
            finished_at = NULL, updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(now);
    });
  }

  private assertAvailable(): void {
    if (this.disposed) throw new ExecutionJobStateError("runtime", "available");
  }

  private assertCapacity(parentSessionId: string): void {
    if (this.active.size >= maximumActiveJobs) {
      throw new ExecutionJobCapacityError(
        `at most ${maximumActiveJobs} background execution jobs may run concurrently`,
      );
    }
    const sessionCount = [...this.active.values()]
      .filter((entry) => entry.parentSessionId === parentSessionId).length;
    if (sessionCount >= maximumActiveJobsPerSession) {
      throw new ExecutionJobCapacityError(
        `at most ${maximumActiveJobsPerSession} background execution jobs may run concurrently per session`,
      );
    }
  }

  private findScopedRow(parentSessionId: string, jobId: string): ExecutionJobRow | undefined {
    return this.database.connection.prepare(`
      SELECT * FROM execution_jobs WHERE id = ? AND parent_session_id = ?
    `).get(jobId, parentSessionId) as unknown as ExecutionJobRow | undefined;
  }

  private requireScopedRow(parentSessionId: string, jobId: string): ExecutionJobRow {
    validateParentSessionId(parentSessionId);
    const row = this.findScopedRow(parentSessionId, jobId);
    if (!row) throw new ExecutionJobNotFoundError(jobId);
    return row;
  }

  private requireRow(jobId: string): ExecutionJobRow {
    const row = this.database.connection.prepare(
      "SELECT * FROM execution_jobs WHERE id = ?",
    ).get(jobId) as unknown as ExecutionJobRow | undefined;
    if (!row) throw new ExecutionJobNotFoundError(jobId);
    return row;
  }

  private findRunRow(jobId: string, attempt: number): ExecutionRunRow | undefined {
    return this.database.connection.prepare(`
      SELECT * FROM execution_job_runs WHERE job_id = ? AND attempt = ?
    `).get(jobId, attempt) as unknown as ExecutionRunRow | undefined;
  }

  private requireSummary(parentSessionId: string, jobId: string): ExecutionJobSummary {
    return this.mapSummary(this.requireScopedRow(parentSessionId, jobId));
  }

  private mapSummary(row: ExecutionJobRow): ExecutionJobSummary {
    const run = row.current_attempt > 0
      ? this.findRunRow(row.id, row.current_attempt)
      : undefined;
    return Object.freeze({
      id: row.id,
      parentSessionId: row.parent_session_id,
      status: row.status as ExecutionJobStatus,
      revision: Number(row.revision),
      commandSha256: row.command_sha256,
      commandCharacters: Number(row.command_characters),
      mode: row.mode as Mode,
      conversationSpace: row.conversation_space as ConversationSpace,
      ...(row.character_id ? { characterId: row.character_id } : {}),
      ...(row.secret_owner_character_id
        ? { secretOwnerCharacterId: row.secret_owner_character_id }
        : {}),
      grants: Object.freeze({
        workspaceAccess: row.workspace_access as WorkspaceAccess,
        networkEnabled: Boolean(row.network_enabled),
      }),
      timeoutSeconds: Number(row.timeout_seconds),
      maxOutputBytes: Number(row.max_output_bytes),
      currentAttempt: Number(row.current_attempt),
      maxAttempts: maximumExecutionJobAttempts,
      ...(run ? { run: mapRunSummary(run) } : {}),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      updatedAt: row.updated_at,
    });
  }

  private notifyTerminal(summary: ExecutionJobSummary): void {
    try {
      this.onTerminal?.(summary);
    } catch {
      // The durable terminal row remains authoritative if observability fails.
    }
  }
}

function mapRunSummary(row: ExecutionRunRow): ExecutionRunSummary {
  return Object.freeze({
    attempt: Number(row.attempt),
    status: row.status as ExecutionRunStatus,
    workspaceAccess: row.workspace_access as WorkspaceAccess,
    networkEnabled: Boolean(row.network_enabled),
    outputBytes: Number(row.output_bytes),
    outputTruncated: Boolean(row.output_truncated),
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    timedOut: Boolean(row.timed_out),
    ...(row.failure_reason
      ? { failureReason: row.failure_reason as ExecutionFailureReason }
      : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
  });
}

function validateStartInput(input: StartExecutionJobInput): void {
  validateParentSessionId(input.parentSessionId);
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new ExecutionJobValidationError("command must not be empty");
  }
  if ([...input.command].length > maximumExecutionCommandCharacters) {
    throw new ExecutionJobValidationError(
      `command must contain at most ${maximumExecutionCommandCharacters} characters`,
    );
  }
  if (input.mode !== "sms" && input.mode !== "rp") {
    throw new ExecutionJobValidationError("mode must be sms or rp");
  }
  if (input.conversationSpace !== "normal" && input.conversationSpace !== "secret") {
    throw new ExecutionJobValidationError("conversationSpace must be normal or secret");
  }
  if (
    (input.conversationSpace === "normal" && input.secretOwnerCharacterId !== undefined) ||
    (input.conversationSpace === "secret" &&
      (!input.characterId || input.secretOwnerCharacterId !== input.characterId))
  ) {
    throw new ExecutionJobValidationError("secret execution scope must match its character owner");
  }
  if (!input.workspaceKey || [...input.workspaceKey].length > 256) {
    throw new ExecutionJobValidationError("workspaceKey must contain between 1 and 256 characters");
  }
  if (!input.workspaceDir || [...input.workspaceDir].length > 4_096) {
    throw new ExecutionJobValidationError("workspaceDir must contain between 1 and 4096 characters");
  }
  if (!["off", "read_only", "read_write"].includes(input.workspaceAccess)) {
    throw new ExecutionJobValidationError("workspaceAccess is invalid");
  }
  const timeout = input.timeoutSeconds ?? defaultExecutionTimeoutSeconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > maximumExecutionTimeoutSeconds) {
    throw new ExecutionJobValidationError(
      `timeoutSeconds must be an integer between 1 and ${maximumExecutionTimeoutSeconds}`,
    );
  }
  if (input.admissionKey !== undefined) validateAdmissionKey(input.admissionKey);
}

function validateAdmissionKey(value: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > 256) {
    throw new ExecutionJobValidationError(
      "admissionKey must contain between 1 and 256 trimmed characters",
    );
  }
}

function validateParentSessionId(parentSessionId: string): void {
  if (
    typeof parentSessionId !== "string" ||
    !parentSessionId.trim() ||
    parentSessionId !== parentSessionId.trim() ||
    [...parentSessionId].length > 256
  ) {
    throw new ExecutionJobValidationError(
      "parentSessionId must contain between 1 and 256 trimmed characters",
    );
  }
}

function narrowerWorkspaceAccess(
  frozen: WorkspaceAccess,
  current: WorkspaceAccess,
): WorkspaceAccess {
  const rank: Record<WorkspaceAccess, number> = {
    off: 0,
    read_only: 1,
    read_write: 2,
  };
  return rank[frozen] <= rank[current] ? frozen : current;
}

/** Return the largest UTF-8 code-point boundary at or below limit. */
function utf8PrefixLength(buffer: Buffer, limit: number): number {
  if (limit >= buffer.length) return buffer.length;
  if (limit <= 0) return 0;
  let boundary = limit;
  while (boundary > 0 && (buffer[boundary] & 0xc0) === 0x80) boundary -= 1;
  return boundary;
}

function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // A process that already exited will settle through its close event.
    }
  }
}
