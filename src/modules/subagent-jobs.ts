import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace, Mode } from "../domain/types.js";
import type { SubagentFailureDiagnostic, SubagentRole } from "../mcp/subagent-server.js";
import type { AppDatabase } from "../storage/database.js";
import type { WorkspaceAccess } from "./types.js";

const maximumParentSessionIdCharacters = 256;
const maximumTaskCharacters = 4_000;
const maximumContextCharacters = 8_000;
const maximumResultCharacters = 200_000;
const maximumListLimit = 100;
export const maximumSubagentFollowupCharacters = 4_000;
export const maximumSubagentFollowupTurns = 8;
export const maximumSubagentTranscriptBytes = 4 * 1_024 * 1_024;
const maximumSubagentTranscriptMessages = 2_048;
const maximumSubagentDeliveryAttempts = 8;
const jobRoles = new Set<SubagentRole>(["worker", "researcher", "planner", "reviewer"]);
const jobStatuses = new Set<SubagentJobStatus>([
  "queued",
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
const deliveryStatuses = new Set<SubagentJobDeliveryStatus>([
  "waiting",
  "pending",
  "delivered",
  "discarded",
]);

export type SubagentJobStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

export type SubagentJobBudgetSnapshot = Readonly<{
  maxConcurrentTasks: number;
  maxWorkModelCalls: number;
  maxOutputTokens: number;
  maxResultCharacters: number;
  timeoutSeconds: number;
  timeoutMs: number;
}>;

export type SubagentJobGrantSnapshot = Readonly<{
  /** A child can only retain or reduce the parent's Workspace grant. */
  workspaceAccess: Extract<WorkspaceAccess, "off" | "read_only">;
  /** Explicit MCP module subset admitted for this job. */
  moduleIds: readonly string[];
  /** Skill names are inventory only; their bounded files remain read-only. */
  skillNames: readonly string[];
  /** Exact tools mounted when the job transitions to running. */
  toolNames: readonly string[];
}>;

export type SubagentJobCompletion = Readonly<{
  output: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  truncated: boolean;
  forcedFinalization: boolean;
  maxResultCharacters: number;
}>;

export type SubagentJobSummary = Readonly<{
  id: string;
  parentSessionId: string;
  childSessionId: string;
  role: SubagentRole;
  status: SubagentJobStatus;
  revision: number;
  taskSha256: string;
  taskCharacters: number;
  contextCharacters: number;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  budgets: SubagentJobBudgetSnapshot;
  grants: SubagentJobGrantSnapshot;
  continuation: Readonly<{
    transcriptStored: boolean;
    available: boolean;
    followupCount: number;
    maxFollowupTurns: number;
    pendingInputCharacters: number;
  }>;
  result?: Readonly<Omit<SubagentJobCompletion, "output">>;
  failure?: Readonly<SubagentFailureDiagnostic>;
  recoveryCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type SubagentJobDetail = SubagentJobSummary & Readonly<{
  /** The delegated task and supporting context remain write-only to this API. */
  output?: string;
}>;

export type CreateSubagentJobInput = Readonly<{
  parentSessionId: string;
  role: SubagentRole;
  task: string;
  context?: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  budgets: SubagentJobBudgetSnapshot;
  grants: SubagentJobGrantSnapshot;
  /** Background admission requests one durable parent notification for this run. */
  notifyParent?: boolean;
}>;

/** Private execution material. Never return this shape from list/detail APIs. */
export type SubagentJobFollowupExecution = Readonly<{
  job: SubagentJobSummary;
  task: string;
  context?: string;
  prompt: string;
  transcript: readonly unknown[];
}>;

export type SubagentJobDeliveryStatus = "waiting" | "pending" | "delivered" | "discarded";

/** Safe delivery projection. Result and prompt bodies remain in the owning job row. */
export type SubagentJobDelivery = Readonly<{
  id: string;
  jobId: string;
  parentSessionId: string;
  childSessionId: string;
  generation: number;
  status: SubagentJobDeliveryStatus;
  outcomeStatus?: Extract<SubagentJobStatus, "completed" | "failed" | "cancelled">;
  jobRevision?: number;
  followupCount: number;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  attempts: number;
  createdAt: string;
  deliveredAt?: string;
  discardedAt?: string;
  updatedAt: string;
}>;

export type SubagentJobDeliveryCursor = Readonly<{
  createdAt: string;
  jobId: string;
  generation: number;
}>;

type SubagentJobRow = {
  id: string;
  parent_session_id: string;
  child_session_id: string;
  role: string;
  status: string;
  revision: number;
  task_text: string;
  context_text: string | null;
  task_sha256: string;
  task_characters: number;
  context_characters: number;
  mode: string;
  conversation_space: string;
  character_id: string | null;
  secret_owner_character_id: string | null;
  budgets_json: string;
  grants_json: string;
  result_json: string | null;
  failure_json: string | null;
  transcript_json: string | null;
  pending_input_text: string | null;
  pending_input_sha256: string | null;
  pending_input_characters: number;
  followup_count: number;
  recovery_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

type SubagentJobDeliveryRow = {
  job_id: string;
  parent_session_id: string;
  child_session_id: string;
  generation: number;
  delivery_status: string;
  outcome_status: string | null;
  job_revision: number | null;
  followup_count: number;
  mode: string;
  conversation_space: string;
  character_id: string | null;
  secret_owner_character_id: string | null;
  attempts: number;
  delivery_created_at: string;
  delivered_at: string | null;
  discarded_at: string | null;
  delivery_updated_at: string;
};

export class SubagentJobNotFoundError extends Error {
  readonly code = "SUBAGENT_JOB_NOT_FOUND";

  constructor(jobId: string) {
    super(`Subagent job is unavailable: ${jobId}`);
    this.name = "SubagentJobNotFoundError";
  }
}

export class SubagentJobStateError extends Error {
  readonly code = "SUBAGENT_JOB_STATE_CONFLICT";

  constructor(jobId: string, expected: string) {
    super(`Subagent job ${jobId} is no longer ${expected}`);
    this.name = "SubagentJobStateError";
  }
}

/**
 * Durable, host-owned ledger for blocking, background, and continued Subagent turns.
 * Raw task/context live only in this private table so ordinary audits and list
 * views can identify work without reproducing delegated prompts. Transcript and
 * pending follow-up bodies are likewise private execution material.
 */
export class SubagentJobService {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {
    this.recoverInterruptedJobs();
  }

  create(input: CreateSubagentJobInput): SubagentJobSummary {
    validateCreateInput(input);
    const id = this.idGenerator.next("subagent-job");
    const childSessionId = `subagent:${input.parentSessionId}:${id}`;
    const createdAt = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO subagent_jobs(
          id, parent_session_id, child_session_id, role, status, revision,
          task_text, context_text, task_sha256, task_characters, context_characters,
          mode, conversation_space, character_id, secret_owner_character_id,
          budgets_json, grants_json, result_json, failure_json, recovery_count,
          created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, NULL, NULL, ?)
      `).run(
        id,
        input.parentSessionId,
        childSessionId,
        input.role,
        input.task,
        input.context ?? null,
        createHash("sha256").update(input.task).digest("hex"),
        [...input.task].length,
        [...(input.context ?? "")].length,
        input.mode,
        input.conversationSpace,
        input.characterId ?? null,
        input.secretOwnerCharacterId ?? null,
        JSON.stringify(input.budgets),
        JSON.stringify(normalizeGrants(input.grants)),
        createdAt,
        createdAt,
      );
      if (input.notifyParent === true) {
        this.insertWaitingDelivery(id, 1, createdAt);
      }
    });
    return this.requireSummary(id);
  }

  start(jobId: string, grants: SubagentJobGrantSnapshot): SubagentJobSummary {
    const updatedAt = this.clock.now().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE subagent_jobs
      SET status = 'running', revision = revision + 1, grants_json = ?,
          started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(JSON.stringify(normalizeGrants(grants)), updatedAt, updatedAt, jobId);
    if (Number(result.changes) !== 1) throw new SubagentJobStateError(jobId, "queued");
    return this.requireSummary(jobId);
  }

  complete(
    jobId: string,
    completion: SubagentJobCompletion,
    transcript?: readonly unknown[],
  ): SubagentJobDetail {
    validateCompletion(completion);
    const transcriptJson = boundedTranscriptJson(transcript);
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'completed', revision = revision + 1, result_json = ?,
            failure_json = NULL, transcript_json = ?, pending_input_text = NULL,
            pending_input_sha256 = NULL, pending_input_characters = 0,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(completion), transcriptJson, updatedAt, updatedAt, jobId);
      if (Number(result.changes) !== 1) throw new SubagentJobStateError(jobId, "running");
      const row = this.requireRow(jobId);
      this.readyWaitingDelivery(row, updatedAt);
      return mapDetail(row);
    });
  }

  queueFollowup(
    parentSessionId: string,
    jobId: string,
    prompt: string,
    grants: SubagentJobGrantSnapshot,
  ): SubagentJobFollowupExecution {
    validateParentSessionId(parentSessionId);
    const normalizedPrompt = validateFollowupPrompt(prompt);
    const normalizedGrants = normalizeGrants(grants);
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ? AND id = ?
    `).get(parentSessionId, jobId) as SubagentJobRow | undefined;
    if (!row) throw new SubagentJobNotFoundError(jobId);
    const transcript = parseTranscript(row.transcript_json);
    if (!isGrantSubset(normalizedGrants, parseGrants(row.grants_json))) {
      throw new SubagentJobStateError(jobId, "a continuation grant no wider than its prior grant");
    }
    if (
      row.status !== "completed" ||
      !transcript ||
      !Number.isSafeInteger(row.followup_count) ||
      row.followup_count >= maximumSubagentFollowupTurns
    ) {
      throw new SubagentJobStateError(
        jobId,
        `completed with a stored transcript and fewer than ${maximumSubagentFollowupTurns} follow-ups`,
      );
    }
    const updatedAt = this.clock.now().toISOString();
    const queued = this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'queued', revision = revision + 1,
            pending_input_text = ?, pending_input_sha256 = ?, pending_input_characters = ?,
            followup_count = followup_count + 1, result_json = NULL,
            failure_json = NULL, grants_json = ?, finished_at = NULL, updated_at = ?
        WHERE parent_session_id = ? AND id = ? AND status = 'completed'
          AND revision = ? AND transcript_json IS NOT NULL
          AND followup_count < ?
      `).run(
        normalizedPrompt,
        createHash("sha256").update(normalizedPrompt).digest("hex"),
        [...normalizedPrompt].length,
        JSON.stringify(normalizedGrants),
        updatedAt,
        parentSessionId,
        jobId,
        row.revision,
        maximumSubagentFollowupTurns,
      );
      if (Number(result.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "an available continuation slot");
      }
      this.database.connection.prepare(`
        UPDATE subagent_job_deliveries
        SET status = 'discarded', discarded_at = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('waiting', 'pending')
      `).run(updatedAt, updatedAt, jobId);
      const generation = Number((this.database.connection.prepare(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM subagent_job_deliveries WHERE job_id = ?
      `).get(jobId) as { generation: number }).generation);
      this.insertWaitingDelivery(jobId, generation, updatedAt);
      return this.requireRow(jobId);
    });
    return Object.freeze({
      job: mapSummary(queued),
      task: queued.task_text,
      ...(queued.context_text === null ? {} : { context: queued.context_text }),
      prompt: normalizedPrompt,
      transcript,
    });
  }

  fail(jobId: string, failure: SubagentFailureDiagnostic): SubagentJobSummary {
    validateFailure(failure);
    const status: SubagentJobStatus = failure.failureKind === "cancelled"
      ? "cancelled"
      : "failed";
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = ?, revision = revision + 1, failure_json = ?,
            result_json = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(status, JSON.stringify(failure), updatedAt, updatedAt, jobId);
      const row = this.requireRow(jobId);
      if (Number(result.changes) !== 1 && !isTerminal(requiredStatus(row.status))) {
        throw new SubagentJobStateError(jobId, "queued or running");
      }
      this.readyWaitingDelivery(row, updatedAt);
      return mapSummary(row);
    });
  }

  list(parentSessionId: string, limit = 20): SubagentJobSummary[] {
    validateParentSessionId(parentSessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumListLimit) {
      throw new TypeError(`Subagent job limit must be an integer from 1 to ${maximumListLimit}`);
    }
    return (this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(parentSessionId, limit) as unknown as SubagentJobRow[]).map(mapSummary);
  }

  get(parentSessionId: string, jobId: string): SubagentJobDetail | undefined {
    validateParentSessionId(parentSessionId);
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ? AND id = ?
    `).get(parentSessionId, jobId) as SubagentJobRow | undefined;
    return row ? mapDetail(row) : undefined;
  }

  listPendingDeliveries(
    jobId?: string,
    limit = 100,
    after?: SubagentJobDeliveryCursor,
  ): SubagentJobDelivery[] {
    if (jobId !== undefined && (!jobId.trim() || [...jobId].length > 256)) {
      throw new TypeError("Subagent job id must contain 1-256 characters");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Subagent delivery limit must be an integer from 1 to 100");
    }
    if (after) {
      if (!after.createdAt.trim() || [...after.createdAt].length > 128) {
        throw new TypeError("Subagent delivery cursor timestamp must contain 1-128 characters");
      }
      if (!after.jobId.trim() || [...after.jobId].length > 256) {
        throw new TypeError("Subagent delivery cursor job id must contain 1-256 characters");
      }
      if (!Number.isSafeInteger(after.generation) || after.generation < 1 ||
          after.generation > 9) {
        throw new TypeError("Subagent delivery cursor generation must be an integer from 1 to 9");
      }
    }
    const afterCreatedAt = after?.createdAt ?? null;
    const afterJobId = after?.jobId ?? null;
    const afterGeneration = after?.generation ?? null;
    const rows = this.database.connection.prepare(`
      SELECT d.job_id, j.parent_session_id, j.child_session_id,
        d.generation, d.status AS delivery_status, d.outcome_status,
        d.job_revision, j.followup_count, j.mode, j.conversation_space,
        j.character_id, j.secret_owner_character_id, d.attempts,
        d.created_at AS delivery_created_at, d.delivered_at, d.discarded_at,
        d.updated_at AS delivery_updated_at
      FROM subagent_job_deliveries d
      JOIN subagent_jobs j ON j.id = d.job_id
      WHERE d.status = 'pending' AND (? IS NULL OR d.job_id = ?)
        AND (
          ? IS NULL OR d.created_at > ? OR (
            d.created_at = ? AND (
              d.job_id > ? OR (d.job_id = ? AND d.generation > ?)
            )
          )
        )
      ORDER BY d.created_at, d.job_id, d.generation
      LIMIT ?
    `).all(
      jobId ?? null,
      jobId ?? null,
      afterCreatedAt,
      afterCreatedAt,
      afterCreatedAt,
      afterJobId,
      afterJobId,
      afterGeneration,
      limit,
    ) as unknown as SubagentJobDeliveryRow[];
    return rows.map(mapDelivery);
  }

  getDelivery(jobId: string, generation: number): SubagentJobDelivery | undefined {
    const row = this.deliveryRow(jobId, generation);
    return row ? mapDelivery(row) : undefined;
  }

  markDeliveryDelivered(jobId: string, generation: number, deliveredAt: string): boolean {
    const result = this.database.connection.prepare(`
      UPDATE subagent_job_deliveries
      SET status = 'delivered', delivered_at = ?, updated_at = ?
      WHERE job_id = ? AND generation = ? AND status = 'pending'
    `).run(deliveredAt, deliveredAt, jobId, generation);
    return Number(result.changes) === 1;
  }

  discardDelivery(jobId: string, generation: number): boolean {
    const discardedAt = this.clock.now().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE subagent_job_deliveries
      SET status = 'discarded', discarded_at = ?, updated_at = ?
      WHERE job_id = ? AND generation = ? AND status IN ('waiting', 'pending')
    `).run(discardedAt, discardedAt, jobId, generation);
    return Number(result.changes) === 1;
  }

  recordDeliveryFailure(jobId: string, generation: number): SubagentJobDelivery | undefined {
    const updatedAt = this.clock.now().toISOString();
    this.database.connection.prepare(`
      UPDATE subagent_job_deliveries
      SET attempts = MIN(attempts + 1, ?), updated_at = ?
      WHERE job_id = ? AND generation = ? AND status = 'pending'
    `).run(maximumSubagentDeliveryAttempts, updatedAt, jobId, generation);
    return this.getDelivery(jobId, generation);
  }

  deleteForParentSession(parentSessionId: string): number {
    return Number(this.database.connection.prepare(
      "DELETE FROM subagent_jobs WHERE parent_session_id = ?",
    ).run(parentSessionId).changes);
  }

  /** Fail closed on startup; terminal notifications remain recoverable. */
  private recoverInterruptedJobs(): void {
    const updatedAt = this.clock.now().toISOString();
    const failure: SubagentFailureDiagnostic = {
      failureKind: "interrupted",
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      forcedFinalization: false,
      retryable: true,
    };
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'failed', revision = revision + 1, failure_json = ?,
            result_json = NULL, recovery_count = recovery_count + 1,
            finished_at = ?, updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(JSON.stringify(failure), updatedAt, updatedAt);
      this.database.connection.prepare(`
        UPDATE subagent_job_deliveries
        SET status = 'pending', outcome_status = (
              SELECT status FROM subagent_jobs WHERE id = subagent_job_deliveries.job_id
            ),
            job_revision = (
              SELECT revision FROM subagent_jobs WHERE id = subagent_job_deliveries.job_id
            ),
            updated_at = ?
        WHERE status = 'waiting' AND EXISTS (
          SELECT 1 FROM subagent_jobs
          WHERE id = subagent_job_deliveries.job_id
            AND status IN ('completed', 'failed', 'cancelled')
        )
      `).run(updatedAt);
    });
  }

  private requireSummary(jobId: string): SubagentJobSummary {
    const job = this.getSummaryById(jobId);
    if (!job) throw new SubagentJobNotFoundError(jobId);
    return job;
  }

  private requireDetail(jobId: string): SubagentJobDetail {
    return mapDetail(this.requireRow(jobId));
  }

  private requireRow(jobId: string): SubagentJobRow {
    const row = this.database.connection.prepare(
      "SELECT * FROM subagent_jobs WHERE id = ?",
    ).get(jobId) as SubagentJobRow | undefined;
    if (!row) throw new SubagentJobNotFoundError(jobId);
    return row;
  }

  private insertWaitingDelivery(jobId: string, generation: number, createdAt: string): void {
    this.database.connection.prepare(`
      INSERT INTO subagent_job_deliveries(
        job_id, generation, status, outcome_status, job_revision, attempts,
        created_at, delivered_at, discarded_at, updated_at
      ) VALUES (?, ?, 'waiting', NULL, NULL, 0, ?, NULL, NULL, ?)
    `).run(jobId, generation, createdAt, createdAt);
  }

  private readyWaitingDelivery(row: SubagentJobRow, updatedAt: string): void {
    const status = requiredStatus(row.status);
    if (!isTerminal(status)) return;
    this.database.connection.prepare(`
      UPDATE subagent_job_deliveries
      SET status = 'pending', outcome_status = ?, job_revision = ?, updated_at = ?
      WHERE job_id = ? AND status = 'waiting'
    `).run(status, Number(row.revision), updatedAt, row.id);
  }

  private deliveryRow(jobId: string, generation: number): SubagentJobDeliveryRow | undefined {
    if (!jobId.trim() || [...jobId].length > 256) {
      throw new TypeError("Subagent job id must contain 1-256 characters");
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 9) {
      throw new TypeError("Subagent delivery generation must be an integer from 1 to 9");
    }
    return this.database.connection.prepare(`
      SELECT d.job_id, j.parent_session_id, j.child_session_id,
        d.generation, d.status AS delivery_status, d.outcome_status,
        d.job_revision, j.followup_count, j.mode, j.conversation_space,
        j.character_id, j.secret_owner_character_id, d.attempts,
        d.created_at AS delivery_created_at, d.delivered_at, d.discarded_at,
        d.updated_at AS delivery_updated_at
      FROM subagent_job_deliveries d
      JOIN subagent_jobs j ON j.id = d.job_id
      WHERE d.job_id = ? AND d.generation = ?
    `).get(jobId, generation) as SubagentJobDeliveryRow | undefined;
  }

  private getSummaryById(jobId: string): SubagentJobSummary | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM subagent_jobs WHERE id = ?",
    ).get(jobId) as SubagentJobRow | undefined;
    return row ? mapSummary(row) : undefined;
  }
}

function mapSummary(row: SubagentJobRow): SubagentJobSummary {
  const status = requiredStatus(row.status);
  const followupCount = requiredBoundedInteger(
    row.followup_count,
    "followup_count",
    0,
    maximumSubagentFollowupTurns,
  );
  const pendingInputCharacters = requiredBoundedInteger(
    row.pending_input_characters,
    "pending_input_characters",
    0,
    maximumSubagentFollowupCharacters,
  );
  const transcriptStored = row.transcript_json !== null;
  const completion = parseCompletion(row.result_json);
  const result = completion
    ? Object.freeze({
        modelCalls: completion.modelCalls,
        toolCalls: completion.toolCalls,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: completion.durationMs,
        truncated: completion.truncated,
        forcedFinalization: completion.forcedFinalization,
        maxResultCharacters: completion.maxResultCharacters,
      })
    : undefined;
  const failure = parseFailure(row.failure_json);
  return Object.freeze({
    id: String(row.id),
    parentSessionId: String(row.parent_session_id),
    childSessionId: String(row.child_session_id),
    role: requiredRole(row.role),
    status,
    revision: Number(row.revision),
    taskSha256: String(row.task_sha256),
    taskCharacters: Number(row.task_characters),
    contextCharacters: Number(row.context_characters),
    mode: requiredMode(row.mode),
    conversationSpace: requiredConversationSpace(row.conversation_space),
    ...(row.character_id ? { characterId: String(row.character_id) } : {}),
    ...(row.secret_owner_character_id
      ? { secretOwnerCharacterId: String(row.secret_owner_character_id) }
      : {}),
    budgets: parseBudgets(row.budgets_json),
    grants: parseGrants(row.grants_json),
    continuation: Object.freeze({
      transcriptStored,
      available:
        status === "completed" &&
        transcriptStored &&
        followupCount < maximumSubagentFollowupTurns,
      followupCount,
      maxFollowupTurns: maximumSubagentFollowupTurns,
      pendingInputCharacters,
    }),
    ...(result ? { result } : {}),
    ...(failure ? { failure } : {}),
    recoveryCount: Number(row.recovery_count),
    createdAt: String(row.created_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    updatedAt: String(row.updated_at),
  });
}

function mapDetail(row: SubagentJobRow): SubagentJobDetail {
  const summary = mapSummary(row);
  const completion = parseCompletion(row.result_json);
  return Object.freeze({
    ...summary,
    ...(completion ? { output: completion.output } : {}),
  });
}

function mapDelivery(row: SubagentJobDeliveryRow): SubagentJobDelivery {
  const generation = requiredBoundedInteger(row.generation, "delivery generation", 1, 9);
  const status = requiredDeliveryStatus(row.delivery_status);
  const outcomeStatus = row.outcome_status === null
    ? undefined
    : requiredTerminalStatus(row.outcome_status);
  const jobRevision = row.job_revision === null
    ? undefined
    : requiredBoundedInteger(row.job_revision, "delivery job revision", 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    id: `${row.job_id}:${generation}`,
    jobId: String(row.job_id),
    parentSessionId: String(row.parent_session_id),
    childSessionId: String(row.child_session_id),
    generation,
    status,
    ...(outcomeStatus ? { outcomeStatus } : {}),
    ...(jobRevision === undefined ? {} : { jobRevision }),
    followupCount: requiredBoundedInteger(
      row.followup_count,
      "followup_count",
      0,
      maximumSubagentFollowupTurns,
    ),
    mode: requiredMode(row.mode),
    conversationSpace: requiredConversationSpace(row.conversation_space),
    ...(row.character_id ? { characterId: String(row.character_id) } : {}),
    ...(row.secret_owner_character_id
      ? { secretOwnerCharacterId: String(row.secret_owner_character_id) }
      : {}),
    attempts: requiredBoundedInteger(
      row.attempts,
      "delivery attempts",
      0,
      maximumSubagentDeliveryAttempts,
    ),
    createdAt: String(row.delivery_created_at),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
    ...(row.discarded_at ? { discardedAt: String(row.discarded_at) } : {}),
    updatedAt: String(row.delivery_updated_at),
  });
}

function normalizeGrants(input: SubagentJobGrantSnapshot): SubagentJobGrantSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Subagent job grants must be an object");
  }
  if (input.workspaceAccess !== "off" && input.workspaceAccess !== "read_only") {
    throw new TypeError("Subagent job Workspace access must be off or read_only");
  }
  return Object.freeze({
    workspaceAccess: input.workspaceAccess,
    moduleIds: boundedUniqueStrings(input.moduleIds, "moduleIds", 32, 128),
    skillNames: boundedUniqueStrings(input.skillNames, "skillNames", 64, 200),
    toolNames: boundedUniqueStrings(input.toolNames, "toolNames", 128, 128),
  });
}

function isGrantSubset(
  candidate: SubagentJobGrantSnapshot,
  previous: SubagentJobGrantSnapshot,
): boolean {
  if (candidate.workspaceAccess === "read_only" && previous.workspaceAccess === "off") {
    return false;
  }
  const previousModules = new Set(previous.moduleIds);
  const previousSkills = new Set(previous.skillNames);
  const previousTools = new Set(previous.toolNames);
  return candidate.moduleIds.every((value) => previousModules.has(value)) &&
    candidate.skillNames.every((value) => previousSkills.has(value)) &&
    candidate.toolNames.every((value) => previousTools.has(value));
}

function validateCreateInput(input: CreateSubagentJobInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Subagent job input must be an object");
  }
  validateParentSessionId(input.parentSessionId);
  requiredRole(input.role);
  requiredMode(input.mode);
  requiredConversationSpace(input.conversationSpace);
  if (typeof input.task !== "string" || !input.task.trim() ||
      [...input.task].length > maximumTaskCharacters) {
    throw new TypeError(`Subagent job task must contain 1-${maximumTaskCharacters} characters`);
  }
  if (input.context !== undefined &&
      (typeof input.context !== "string" || [...input.context].length > maximumContextCharacters)) {
    throw new TypeError(`Subagent job context must contain at most ${maximumContextCharacters} characters`);
  }
  if (input.conversationSpace === "secret") {
    if (!input.characterId || input.secretOwnerCharacterId !== input.characterId) {
      throw new TypeError("Secret Subagent jobs require their parent character as owner");
    }
  } else if (input.secretOwnerCharacterId !== undefined) {
    throw new TypeError("Normal Subagent jobs cannot declare a secret owner");
  }
  if (input.notifyParent !== undefined && typeof input.notifyParent !== "boolean") {
    throw new TypeError("Subagent notifyParent must be a boolean");
  }
  parseBudgets(JSON.stringify(input.budgets));
  normalizeGrants(input.grants);
}

function validateCompletion(input: SubagentJobCompletion): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Subagent job completion must be an object");
  }
  if (typeof input.output !== "string" || !input.output.trim() ||
      [...input.output].length > maximumResultCharacters) {
    throw new TypeError(`Subagent job output must contain 1-${maximumResultCharacters} characters`);
  }
  for (const key of ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "durationMs"] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError(`Subagent job ${key} must be a non-negative safe integer`);
    }
  }
  if (typeof input.truncated !== "boolean" || typeof input.forcedFinalization !== "boolean") {
    throw new TypeError("Subagent job completion flags must be boolean");
  }
  if (!Number.isSafeInteger(input.maxResultCharacters) ||
      input.maxResultCharacters < 1 || input.maxResultCharacters > maximumResultCharacters) {
    throw new TypeError("Subagent job maxResultCharacters is invalid");
  }
}

function validateFailure(input: SubagentFailureDiagnostic): void {
  parseFailure(JSON.stringify(input));
}

function parseBudgets(json: string): SubagentJobBudgetSnapshot {
  const value = parseRecord(json, "budgets");
  const keys = [
    "maxConcurrentTasks",
    "maxWorkModelCalls",
    "maxOutputTokens",
    "maxResultCharacters",
    "timeoutSeconds",
    "timeoutMs",
  ] as const;
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) {
      throw new TypeError(`Subagent job budget ${key} is invalid`);
    }
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, Number(value[key])])) as
    unknown as SubagentJobBudgetSnapshot);
}

function parseGrants(json: string): SubagentJobGrantSnapshot {
  return normalizeGrants(parseRecord(json, "grants") as unknown as SubagentJobGrantSnapshot);
}

function parseCompletion(json: string | null): SubagentJobCompletion | undefined {
  if (json === null) return undefined;
  const value = parseRecord(json, "result") as unknown as SubagentJobCompletion;
  validateCompletion(value);
  return Object.freeze({ ...value });
}

function parseFailure(json: string | null): Readonly<SubagentFailureDiagnostic> | undefined {
  if (json === null) return undefined;
  const value = parseRecord(json, "failure");
  const allowedKinds = new Set([
    "capacity",
    "cancelled",
    "timeout",
    "model_budget",
    "finalization_failed",
    "model_unavailable",
    "empty_result",
    "output_guard",
    "runtime_error",
    "interrupted",
  ]);
  if (!allowedKinds.has(String(value.failureKind))) {
    throw new TypeError("Subagent job failure kind is invalid");
  }
  for (const key of ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "durationMs"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw new TypeError(`Subagent job failure ${key} is invalid`);
    }
  }
  if (typeof value.forcedFinalization !== "boolean" || typeof value.retryable !== "boolean") {
    throw new TypeError("Subagent job failure flags are invalid");
  }
  return Object.freeze({
    failureKind: value.failureKind as SubagentFailureDiagnostic["failureKind"],
    modelCalls: Number(value.modelCalls),
    toolCalls: Number(value.toolCalls),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    durationMs: Number(value.durationMs),
    forcedFinalization: value.forcedFinalization,
    retryable: value.retryable,
  });
}

function boundedTranscriptJson(transcript: readonly unknown[] | undefined): string | null {
  if (transcript === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(transcript);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json, "utf8") > maximumSubagentTranscriptBytes) return null;
  try {
    parseTranscript(json);
  } catch {
    return null;
  }
  return json;
}

function parseTranscript(json: string | null): readonly unknown[] | undefined {
  if (json === null) return undefined;
  if (Buffer.byteLength(json, "utf8") > maximumSubagentTranscriptBytes) {
    throw new TypeError("Subagent job transcript exceeds its private storage limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TypeError("Subagent job transcript JSON is invalid");
  }
  if (!Array.isArray(value) || value.length > maximumSubagentTranscriptMessages) {
    throw new TypeError("Subagent job transcript has an invalid message count");
  }
  const roles = new Set([
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ]);
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        !roles.has(String((message as Record<string, unknown>).role))) {
      throw new TypeError("Subagent job transcript contains an invalid message");
    }
  }
  return Object.freeze(value.map((message) => Object.freeze(message)));
}

function validateFollowupPrompt(value: string): string {
  if (typeof value !== "string" || !value.trim() ||
      [...value].length > maximumSubagentFollowupCharacters) {
    throw new TypeError(
      `Subagent follow-up must contain 1-${maximumSubagentFollowupCharacters} characters`,
    );
  }
  return value;
}

function requiredBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`Subagent job ${field} is invalid`);
  }
  return normalized;
}

function parseRecord(json: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TypeError(`Subagent job ${field} JSON is invalid`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Subagent job ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedUniqueStrings(
  value: readonly string[],
  field: string,
  maximumEntries: number,
  maximumCharacters: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new TypeError(`Subagent job ${field} exceeds ${maximumEntries} entries`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry !== entry.trim() ||
        [...entry].length > maximumCharacters) {
      throw new TypeError(`Subagent job ${field} contains an invalid value`);
    }
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`Subagent job ${field} must contain unique values`);
  }
  return Object.freeze([...normalized]);
}

function validateParentSessionId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > maximumParentSessionIdCharacters) {
    throw new TypeError("Subagent job parent session ID is invalid");
  }
}

function requiredRole(value: string): SubagentRole {
  if (!jobRoles.has(value as SubagentRole)) throw new TypeError("Subagent job role is invalid");
  return value as SubagentRole;
}

function requiredStatus(value: string): SubagentJobStatus {
  if (!jobStatuses.has(value as SubagentJobStatus)) {
    throw new TypeError("Subagent job status is invalid");
  }
  return value as SubagentJobStatus;
}

function requiredTerminalStatus(
  value: string,
): Extract<SubagentJobStatus, "completed" | "failed" | "cancelled"> {
  const status = requiredStatus(value);
  if (!isTerminal(status)) throw new TypeError("Subagent delivery outcome status is invalid");
  return status;
}

function requiredDeliveryStatus(value: string): SubagentJobDeliveryStatus {
  if (!deliveryStatuses.has(value as SubagentJobDeliveryStatus)) {
    throw new TypeError("Subagent delivery status is invalid");
  }
  return value as SubagentJobDeliveryStatus;
}

function requiredMode(value: string): Mode {
  if (value !== "sms" && value !== "rp") throw new TypeError("Subagent job mode is invalid");
  return value;
}

function requiredConversationSpace(value: string): ConversationSpace {
  if (value !== "normal" && value !== "secret") {
    throw new TypeError("Subagent job conversation space is invalid");
  }
  return value;
}

function isTerminal(
  status: SubagentJobStatus,
): status is Extract<SubagentJobStatus, "completed" | "failed" | "cancelled"> {
  return status === "completed" || status === "failed" || status === "cancelled";
}
