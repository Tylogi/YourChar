import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace, Mode } from "../domain/types.js";
import type { SubagentFailureDiagnostic, SubagentRole } from "../mcp/subagent-server.js";
import type { AppDatabase } from "../storage/database.js";
import {
  maximumSubagentSettings,
  minimumSubagentSettings,
} from "./subagent-settings.js";
import type { WorkspaceAccess } from "./types.js";

const maximumParentSessionIdCharacters = 256;
const maximumTaskCharacters = 4_000;
const maximumContextCharacters = 8_000;
const maximumResultCharacters = maximumSubagentSettings.maxResultCharacters;
const maximumListLimit = 100;
export const maximumSubagentFollowupCharacters = 4_000;
export const maximumSubagentFollowupTurns = 8;
export const maximumSubagentTranscriptBytes = 4 * 1_024 * 1_024;
export const maximumSubagentRunAttempts = 3;
const maximumSubagentTranscriptMessages = 2_048;
const maximumSubagentDeliveryAttempts = 8;
const maximumSubagentToolCallsPerModelCall = 16;
const maximumSubagentToolArgumentsBytes = 65_536;
const maximumSubagentToolJournalResultBytes = maximumSubagentTranscriptBytes;
const maximumSubagentRunLeaseGraceMs = 30_000;
// Matches Node's largest supported timer after the MCP deadline reserves the
// same 30-second envelope. Production settings remain capped at 60 minutes;
// this wider ceiling preserves the existing host/test timeout override seam.
const maximumSubagentRunDurationMs = 2_147_483_647;
const maximumSubagentRunTimeoutMs =
  maximumSubagentRunDurationMs - maximumSubagentRunLeaseGraceMs;
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
const automaticallyReplayableSubagentTools = new Set([
  "list_workspace",
  "read",
  "read_document",
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
  recovery?: SubagentJobRecoveryProjection;
  result?: Readonly<Omit<SubagentJobCompletion, "output">>;
  failure?: Readonly<SubagentFailureDiagnostic>;
  recoveryCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type SubagentJobRecoveryProjection = Readonly<{
  state: "automatic_pending" | "decision_required" | "unavailable";
  reason:
    | "safe_checkpoint"
    | "external_effect_ambiguous"
    | "checkpoint_invalid"
    | "attempts_exhausted"
    | "budget_exhausted";
  generation: number;
  attemptCount: number;
  recoverableToolCalls: number;
  ambiguousToolCalls: number;
}>;

export type SubagentJobRecoveryCursor = Readonly<{
  updatedAt: string;
  jobId: string;
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
  timezone?: string;
  budgets: SubagentJobBudgetSnapshot;
  grants: SubagentJobGrantSnapshot;
  /** Background admission requests one durable parent notification for this run. */
  notifyParent?: boolean;
  /** Host-owned idempotency key used by durable orchestrators. */
  admissionKey?: string;
}>;

/** Private execution material. Never return this shape from list/detail APIs. */
export type SubagentJobFollowupExecution = Readonly<{
  job: SubagentJobSummary;
  task: string;
  context?: string;
  prompt: string;
  transcript: readonly unknown[];
}>;

/** Private recovery material. Never return this shape from list/detail APIs. */
export type SubagentJobRecoveryExecution = Readonly<{
  job: SubagentJobSummary;
  task: string;
  context?: string;
  followupPrompt?: string;
  transcript?: readonly unknown[];
  timezone: string;
  mode: "prompt" | "continue" | "finalize";
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

export type SubagentJobRunUsage = Readonly<{
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  resultCharacters: number;
}>;

export type SubagentJobRunProgress = Readonly<
  Omit<SubagentJobRunUsage, "resultCharacters">
>;

/** Fenced ownership of one durable initial or follow-up run. */
export type SubagentJobRunClaim = Readonly<{
  job: SubagentJobSummary;
  generation: number;
  attempt: number;
  ownerId: string;
  claimToken: string;
  leaseExpiresAt: string;
  baseline: SubagentJobRunUsage;
}>;

export type SubagentToolReplayPolicy = "automatic" | "explicit";

export type SubagentToolCallStart = Readonly<{
  toolCallId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}>;

export type SubagentToolCallResult = SubagentToolCallStart & Readonly<{
  content: readonly unknown[];
  details?: unknown;
  usage?: unknown;
  isError: boolean;
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
  timezone: string;
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

type SubagentJobRunRow = {
  job_id: string;
  generation: number;
  status: string;
  attempt_count: number;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  result_characters: number;
  checkpoint_at: string | null;
  owner_id: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  attempt_started_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type SubagentToolCallRow = {
  job_id: string;
  generation: number;
  attempt: number;
  model_call: number;
  tool_call_id: string;
  tool_name: string;
  replay_policy: string;
  status: string;
  arguments_sha256: string;
  arguments_bytes: number;
  result_json: string | null;
  result_sha256: string | null;
  result_bytes: number | null;
  is_error: number | null;
  result_reason: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
};

type RecoveryTranscriptToolCall = Readonly<{
  id: string;
  name: string;
}>;

type SubagentRecoveryAssessment = Readonly<{
  projection: SubagentJobRecoveryProjection;
  transcript?: readonly unknown[];
  mode?: SubagentJobRecoveryExecution["mode"];
}>;

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
    this.stageExpiredJobsForRecovery();
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
          mode, conversation_space, character_id, secret_owner_character_id, timezone,
          budgets_json, grants_json, result_json, failure_json, recovery_count,
          admission_key, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, NULL, ?)
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
        normalizeSubagentTimezone(input.timezone),
        JSON.stringify(input.budgets),
        JSON.stringify(normalizeGrants(input.grants)),
        input.admissionKey ?? null,
        createdAt,
        createdAt,
      );
      this.insertQueuedRun(id, 1, createdAt);
      if (input.notifyParent === true) {
        this.insertWaitingDelivery(id, 1, createdAt);
      }
    });
    return this.requireSummary(id);
  }

  getByAdmissionKey(
    parentSessionId: string,
    admissionKey: string,
  ): SubagentJobSummary | undefined {
    validateParentSessionId(parentSessionId);
    validateAdmissionKey(admissionKey);
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ? AND admission_key = ?
    `).get(parentSessionId, admissionKey) as unknown as SubagentJobRow | undefined;
    return row ? mapSummary(row) : undefined;
  }

  start(jobId: string, grants: SubagentJobGrantSnapshot): SubagentJobSummary {
    return this.claimRun(
      jobId,
      grants,
      `direct:${this.idGenerator.next("subagent-run-owner")}`,
    ).job;
  }

  claimRun(
    jobId: string,
    grants: SubagentJobGrantSnapshot,
    ownerId: string,
  ): SubagentJobRunClaim {
    const normalizedGrants = normalizeGrants(grants);
    validateRunOwnerId(ownerId);
    const now = this.clock.now();
    const updatedAt = now.toISOString();
    return this.database.transaction(() => {
      const row = this.requireRow(jobId);
      if (row.status !== "queued") throw new SubagentJobStateError(jobId, "queued");
      const previousGrants = parseGrants(row.grants_json);
      const generation = currentRunGeneration(row);
      const run = this.requireRunRow(jobId, generation);
      const toolsCanInitialize = generation === 1 && Number(run.attempt_count) === 0 &&
        previousGrants.toolNames.length === 0;
      if (
        !isGrantScopeSubset(normalizedGrants, previousGrants) ||
        (!toolsCanInitialize && !toolNamesAreSubset(normalizedGrants, previousGrants))
      ) {
        throw new SubagentJobStateError(jobId, "a run grant no wider than its durable grant");
      }
      const budgets = parseBudgets(row.budgets_json);
      assertRunCanStart(jobId, run, budgets);
      const claimToken = this.idGenerator.next("subagent-run-claim");
      const remainingDurationMs = Math.max(1, budgets.timeoutMs - Number(run.duration_ms));
      const leaseExpiresAt = new Date(
        now.getTime() + remainingDurationMs + maximumSubagentRunLeaseGraceMs,
      ).toISOString();
      const jobResult = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'running', revision = revision + 1, grants_json = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status = 'queued' AND revision = ?
      `).run(
        JSON.stringify(normalizedGrants),
        updatedAt,
        updatedAt,
        jobId,
        row.revision,
      );
      const runResult = this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = 'running', attempt_count = attempt_count + 1,
            owner_id = ?, claim_token = ?, lease_expires_at = ?,
            attempt_started_at = ?, finished_at = NULL, updated_at = ?
        WHERE job_id = ? AND generation = ? AND status IN ('queued', 'idle')
          AND attempt_count < ?
      `).run(
        ownerId,
        claimToken,
        leaseExpiresAt,
        updatedAt,
        updatedAt,
        jobId,
        generation,
        maximumSubagentRunAttempts,
      );
      if (Number(jobResult.changes) !== 1 || Number(runResult.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "an available durable run attempt");
      }
      return Object.freeze({
        job: mapSummary(this.requireRow(jobId)),
        generation,
        attempt: Number(run.attempt_count) + 1,
        ownerId,
        claimToken,
        leaseExpiresAt,
        baseline: mapRunUsage(run),
      });
    });
  }

  checkpointRun(
    claim: SubagentJobRunClaim,
    progress: SubagentJobRunProgress,
    transcript: readonly unknown[],
  ): SubagentJobRunUsage {
    validateRunProgress(progress);
    const transcriptJson = boundedTranscriptJson(transcript);
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const job = this.requireRow(claim.job.id);
      const run = this.requireClaimedRun(job, claim);
      return this.persistRunCheckpoint(
        job,
        run,
        claim,
        progress,
        transcriptJson,
        updatedAt,
      );
    });
  }

  /** Persist a tool intent and its assistant-message checkpoint before execution. */
  recordToolCallStart(
    claim: SubagentJobRunClaim,
    toolCall: SubagentToolCallStart,
    progress: SubagentJobRunProgress,
    transcript: readonly unknown[],
  ): void {
    validateRunProgress(progress);
    const normalized = normalizeToolCallStart(toolCall);
    const argumentsJson = boundedToolArgumentsJson(normalized.input);
    const argumentsBytes = Buffer.byteLength(argumentsJson, "utf8");
    const argumentsSha256 = createHash("sha256").update(argumentsJson).digest("hex");
    const transcriptJson = boundedTranscriptJson(transcript);
    if (transcriptJson === null) {
      throw new SubagentJobStateError(
        claim.job.id,
        "a bounded transcript checkpoint before tool execution",
      );
    }
    const updatedAt = this.clock.now().toISOString();
    this.database.transaction(() => {
      const job = this.requireRow(claim.job.id);
      const run = this.requireClaimedRun(job, claim);
      if (!parseGrants(job.grants_json).toolNames.includes(normalized.toolName)) {
        throw new SubagentJobStateError(claim.job.id, "a tool inside the frozen run grant");
      }
      const attemptToolCalls = Number((this.database.connection.prepare(`
        SELECT COUNT(*) + 1 AS count FROM subagent_job_tool_calls
        WHERE job_id = ? AND generation = ? AND attempt = ?
      `).get(claim.job.id, claim.generation, claim.attempt) as { count: number }).count);
      const usage = monotonicRunUsage(
        run,
        claimedRunUsage(
          claim,
          { ...progress, toolCalls: Math.max(progress.toolCalls, attemptToolCalls) },
          run.result_characters,
        ),
      );
      assertRunUsageWithinBudgets(claim.job.id, usage, parseBudgets(job.budgets_json));
      const callsInModelRequest = Number((this.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM subagent_job_tool_calls
        WHERE job_id = ? AND generation = ? AND model_call = ?
      `).get(claim.job.id, claim.generation, usage.modelCalls) as { count: number }).count);
      if (callsInModelRequest >= maximumSubagentToolCallsPerModelCall) {
        throw new SubagentJobStateError(
          claim.job.id,
          `fewer than ${maximumSubagentToolCallsPerModelCall + 1} tool calls per model request`,
        );
      }
      const insert = this.database.connection.prepare(`
        INSERT INTO subagent_job_tool_calls(
          job_id, generation, attempt, model_call, tool_call_id, tool_name, replay_policy,
          status, arguments_sha256, arguments_bytes, result_json, result_sha256,
          result_bytes, is_error, result_reason, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?)
        ON CONFLICT(job_id, generation, attempt, tool_call_id) DO NOTHING
      `).run(
        claim.job.id,
        claim.generation,
        claim.attempt,
        usage.modelCalls,
        normalized.toolCallId,
        normalized.toolName,
        subagentToolReplayPolicy(normalized.toolName),
        argumentsSha256,
        argumentsBytes,
        updatedAt,
        updatedAt,
      );
      if (Number(insert.changes) !== 1) {
        throw new SubagentJobStateError(
          claim.job.id,
          `a new fenced tool call ${normalized.toolCallId}`,
        );
      }
      this.persistRunCheckpoint(
        job,
        run,
        claim,
        {
          ...progress,
          toolCalls: Math.max(progress.toolCalls, attemptToolCalls),
        },
        transcriptJson,
        updatedAt,
      );
    });
  }

  /** Commit the exact private tool result before Pi publishes it to the transcript. */
  recordToolCallResult(
    claim: SubagentJobRunClaim,
    toolCall: SubagentToolCallResult,
  ): void {
    const normalized = normalizeToolCallResult(toolCall);
    const argumentsJson = boundedToolArgumentsJson(normalized.input);
    const argumentsSha256 = createHash("sha256").update(argumentsJson).digest("hex");
    const serialized = serializeToolResult(normalized);
    const updatedAt = this.clock.now().toISOString();
    this.database.transaction(() => {
      const job = this.requireRow(claim.job.id);
      this.requireClaimedRun(job, claim);
      const row = this.requireToolCallRow(claim, normalized.toolCallId);
      if (row.tool_name !== normalized.toolName || row.arguments_sha256 !== argumentsSha256) {
        throw new SubagentJobStateError(claim.job.id, "the journaled tool call identity");
      }
      const storedBytes = Number((this.database.connection.prepare(`
        SELECT COALESCE(SUM(result_bytes), 0) AS bytes
        FROM subagent_job_tool_calls
        WHERE job_id = ? AND generation = ? AND status = 'committed'
          AND NOT (attempt = ? AND tool_call_id = ?)
      `).get(
        claim.job.id,
        claim.generation,
        claim.attempt,
        normalized.toolCallId,
      ) as { bytes: number }).bytes);
      const disposition = serialized.kind === "unavailable"
        ? { status: "result_unavailable", reason: "not_json" } as const
        : serialized.bytes > maximumSubagentToolJournalResultBytes
          ? { status: "result_unavailable", reason: "too_large" } as const
          : storedBytes + serialized.bytes > maximumSubagentToolJournalResultBytes
            ? { status: "result_unavailable", reason: "run_limit" } as const
            : { status: "committed", reason: null } as const;
      if (row.status !== "started") {
        if (toolResultMatches(row, normalized, serialized, disposition)) return;
        throw new SubagentJobStateError(claim.job.id, "one immutable tool result commit");
      }
      const result = this.database.connection.prepare(`
        UPDATE subagent_job_tool_calls
        SET status = ?, result_json = ?, result_sha256 = ?, result_bytes = ?,
            is_error = ?, result_reason = ?, finished_at = ?, updated_at = ?
        WHERE job_id = ? AND generation = ? AND attempt = ? AND tool_call_id = ?
          AND status = 'started' AND tool_name = ? AND arguments_sha256 = ?
      `).run(
        disposition.status,
        disposition.status === "committed" && serialized.kind === "json"
          ? serialized.json
          : null,
        serialized.kind === "json" ? serialized.sha256 : null,
        serialized.kind === "json" ? serialized.bytes : null,
        normalized.isError ? 1 : 0,
        disposition.reason,
        updatedAt,
        updatedAt,
        claim.job.id,
        claim.generation,
        claim.attempt,
        normalized.toolCallId,
        normalized.toolName,
        argumentsSha256,
      );
      if (Number(result.changes) !== 1) {
        throw new SubagentJobStateError(claim.job.id, "the active tool result intent");
      }
    });
  }

  complete(
    jobId: string,
    completion: SubagentJobCompletion,
    transcript?: readonly unknown[],
    claim?: SubagentJobRunClaim,
  ): SubagentJobDetail {
    validateCompletion(completion);
    const transcriptJson = boundedTranscriptJson(transcript);
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const current = this.requireRow(jobId);
      if (current.status !== "running") throw new SubagentJobStateError(jobId, "running");
      const run = claim
        ? this.requireClaimedRun(current, claim)
        : this.requireRunRow(jobId, currentRunGeneration(current));
      const outputCharacters = [...completion.output].length;
      const usage = claim
        ? monotonicRunUsage(
            run,
            claimedRunUsage(
              claim,
              completion,
              safeUsageSum(claim.baseline.resultCharacters, outputCharacters),
            ),
          )
        : forcedTerminalRunUsage(run, completion, outputCharacters);
      const budgets = parseBudgets(current.budgets_json);
      assertCompletionMatchesBudgets(jobId, completion, outputCharacters, budgets);
      assertRunUsageWithinBudgets(jobId, usage, budgets);
      const jobResult = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'completed', revision = revision + 1, result_json = ?,
            failure_json = NULL, transcript_json = ?, pending_input_text = NULL,
            pending_input_sha256 = NULL, pending_input_characters = 0,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND revision = ?
      `).run(
        JSON.stringify(completion),
        transcriptJson,
        updatedAt,
        updatedAt,
        jobId,
        current.revision,
      );
      const runResult = this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = 'completed', model_calls = ?, tool_calls = ?, input_tokens = ?,
            output_tokens = ?, duration_ms = ?, result_characters = ?,
            checkpoint_at = ?, owner_id = NULL, claim_token = NULL,
            lease_expires_at = NULL, attempt_started_at = NULL,
            finished_at = ?, updated_at = ?
        WHERE job_id = ? AND generation = ? AND status = 'running'
          AND (? IS NULL OR (attempt_count = ? AND owner_id = ? AND claim_token = ?))
      `).run(
        usage.modelCalls,
        usage.toolCalls,
        usage.inputTokens,
        usage.outputTokens,
        usage.durationMs,
        usage.resultCharacters,
        transcriptJson === null ? null : updatedAt,
        updatedAt,
        updatedAt,
        jobId,
        Number(run.generation),
        claim?.claimToken ?? null,
        claim?.attempt ?? null,
        claim?.ownerId ?? null,
        claim?.claimToken ?? null,
      );
      if (Number(jobResult.changes) !== 1 || Number(runResult.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "the active durable run");
      }
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
    timezone?: string,
  ): SubagentJobFollowupExecution {
    validateParentSessionId(parentSessionId);
    const normalizedPrompt = validateFollowupPrompt(prompt);
    const normalizedGrants = normalizeGrants(grants);
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ? AND id = ?
    `).get(parentSessionId, jobId) as SubagentJobRow | undefined;
    if (!row) throw new SubagentJobNotFoundError(jobId);
    const normalizedTimezone = normalizeSubagentTimezone(timezone ?? row.timezone);
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
            failure_json = NULL, grants_json = ?, timezone = ?,
            finished_at = NULL, updated_at = ?
        WHERE parent_session_id = ? AND id = ? AND status = 'completed'
          AND revision = ? AND transcript_json IS NOT NULL
          AND followup_count < ?
      `).run(
        normalizedPrompt,
        createHash("sha256").update(normalizedPrompt).digest("hex"),
        [...normalizedPrompt].length,
        JSON.stringify(normalizedGrants),
        normalizedTimezone,
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
      const next = this.requireRow(jobId);
      this.insertQueuedRun(jobId, currentRunGeneration(next), updatedAt);
      this.insertWaitingDelivery(jobId, generation, updatedAt);
      return next;
    });
    return Object.freeze({
      job: mapSummary(queued),
      task: queued.task_text,
      ...(queued.context_text === null ? {} : { context: queued.context_text }),
      prompt: normalizedPrompt,
      transcript,
    });
  }

  fail(
    jobId: string,
    failure: SubagentFailureDiagnostic,
    claim?: SubagentJobRunClaim,
  ): SubagentJobSummary {
    validateFailure(failure);
    const status: SubagentJobStatus = failure.failureKind === "cancelled"
      ? "cancelled"
      : "failed";
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const current = this.requireRow(jobId);
      if (isTerminal(requiredStatus(current.status))) return mapSummary(current);
      if (current.status !== "queued" && current.status !== "running" && current.status !== "idle") {
        throw new SubagentJobStateError(jobId, "queued, running, or awaiting recovery");
      }
      const run = claim
        ? this.requireClaimedRun(current, claim)
        : this.requireRunRow(jobId, currentRunGeneration(current));
      const measuredUsage = claim
        ? monotonicRunUsage(
            run,
            claimedRunUsage(claim, failure, claim.baseline.resultCharacters),
          )
        : forcedTerminalRunUsage(run, failure, 0);
      const usage = clampRunUsageToBudgets(measuredUsage, parseBudgets(current.budgets_json));
      const jobResult = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = ?, revision = revision + 1, failure_json = ?,
            result_json = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'idle') AND revision = ?
      `).run(
        status,
        JSON.stringify(failure),
        updatedAt,
        updatedAt,
        jobId,
        current.revision,
      );
      const runResult = this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = ?, model_calls = ?, tool_calls = ?, input_tokens = ?,
            output_tokens = ?, duration_ms = ?, result_characters = ?,
            owner_id = NULL, claim_token = NULL, lease_expires_at = NULL,
            attempt_started_at = NULL, finished_at = ?, updated_at = ?
        WHERE job_id = ? AND generation = ? AND status IN ('queued', 'running', 'idle')
          AND (? IS NULL OR (
            status = 'running' AND attempt_count = ? AND owner_id = ? AND claim_token = ?
          ))
      `).run(
        status,
        usage.modelCalls,
        usage.toolCalls,
        usage.inputTokens,
        usage.outputTokens,
        usage.durationMs,
        usage.resultCharacters,
        updatedAt,
        updatedAt,
        jobId,
        Number(run.generation),
        claim?.claimToken ?? null,
        claim?.attempt ?? null,
        claim?.ownerId ?? null,
        claim?.claimToken ?? null,
      );
      if (Number(jobResult.changes) !== 1 || Number(runResult.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "the active durable run");
      }
      const row = this.requireRow(jobId);
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
    `).all(parentSessionId, limit) as unknown as SubagentJobRow[])
      .map((row) => this.mapSummary(row));
  }

  get(parentSessionId: string, jobId: string): SubagentJobDetail | undefined {
    validateParentSessionId(parentSessionId);
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE parent_session_id = ? AND id = ?
    `).get(parentSessionId, jobId) as SubagentJobRow | undefined;
    return row ? this.mapDetail(row) : undefined;
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

  /**
   * Release an in-process owner during orderly shutdown. The fenced claim is
   * invalidated before cancellation reaches Pi, so late callbacks cannot turn
   * recoverable work into a terminal failure.
   */
  releaseForRecovery(jobId: string): SubagentJobSummary {
    const updatedAt = this.clock.now().toISOString();
    this.database.transaction(() => {
      const row = this.requireRow(jobId);
      if (isTerminal(requiredStatus(row.status)) || row.status === "idle") return;
      const generation = currentRunGeneration(row);
      this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = 'idle', owner_id = NULL, claim_token = NULL,
            lease_expires_at = NULL, attempt_started_at = NULL,
            finished_at = NULL, updated_at = ?
        WHERE job_id = ? AND generation = ? AND status IN ('queued', 'running')
      `).run(updatedAt, jobId, generation);
      const result = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'idle', revision = revision + 1,
            recovery_count = recovery_count + 1,
            finished_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running') AND revision = ?
      `).run(updatedAt, jobId, row.revision);
      if (Number(result.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "a releasable durable run");
      }
    });
    return this.mapSummary(this.requireRow(jobId));
  }

  /** Stage unowned queued work and expired fenced claims for deterministic recovery. */
  stageExpiredJobsForRecovery(includeQueued = true): number {
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = 'idle', owner_id = NULL, claim_token = NULL,
            lease_expires_at = NULL, attempt_started_at = NULL,
            finished_at = NULL, updated_at = ?
        WHERE (
          (status = 'queued' AND ? = 1)
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        ) AND EXISTS (
          SELECT 1 FROM subagent_jobs j
          WHERE j.id = subagent_job_runs.job_id
            AND subagent_job_runs.generation = j.followup_count + 1
            AND j.status IN ('queued', 'running')
        )
      `).run(updatedAt, includeQueued ? 1 : 0, updatedAt);
      const result = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'idle', revision = revision + 1,
            recovery_count = recovery_count + 1,
            result_json = NULL, failure_json = NULL,
            finished_at = NULL, updated_at = ?
        WHERE status IN ('queued', 'running') AND EXISTS (
          SELECT 1 FROM subagent_job_runs r
          WHERE r.job_id = subagent_jobs.id
            AND r.generation = subagent_jobs.followup_count + 1
            AND r.status = 'idle'
        )
      `).run(updatedAt);
      return Number(result.changes);
    });
  }

  /** Safe projections for the runtime recovery pump; no private bodies leave the service. */
  listRecoveryCandidates(
    limit = 100,
    after?: SubagentJobRecoveryCursor,
  ): SubagentJobSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Subagent recovery limit must be an integer from 1 to 100");
    }
    if (after && (
      !after.updatedAt.trim() || [...after.updatedAt].length > 128 ||
      !after.jobId.trim() || [...after.jobId].length > 256
    )) {
      throw new TypeError("Subagent recovery cursor is invalid");
    }
    this.stageExpiredJobsForRecovery(false);
    return (this.database.connection.prepare(`
      SELECT * FROM subagent_jobs
      WHERE status = 'idle' AND (
        ? IS NULL OR updated_at > ? OR (updated_at = ? AND id > ?)
      )
      ORDER BY updated_at, id
      LIMIT ?
    `).all(
      after?.updatedAt ?? null,
      after?.updatedAt ?? null,
      after?.updatedAt ?? null,
      after?.jobId ?? null,
      limit,
    ) as unknown as SubagentJobRow[]).map((row) => this.mapSummary(row));
  }

  /** Earliest live fence that a later recovery scan may safely reclaim. */
  nextRecoveryLeaseExpiresAt(): string | undefined {
    const row = this.database.connection.prepare(`
      SELECT MIN(r.lease_expires_at) AS lease_expires_at
      FROM subagent_job_runs r
      JOIN subagent_jobs j ON j.id = r.job_id
      WHERE j.status = 'running' AND r.status = 'running'
        AND r.generation = j.followup_count + 1
        AND r.lease_expires_at IS NOT NULL
        AND r.lease_expires_at > ?
    `).get(this.clock.now().toISOString()) as { lease_expires_at: string | null };
    return row.lease_expires_at ?? undefined;
  }

  /**
   * Atomically reconcile a staged checkpoint and queue its next fenced attempt.
   * `allowExplicitReplay` is reserved for a trusted, explicit host decision.
   */
  prepareRecovery(
    parentSessionId: string,
    jobId: string,
    allowExplicitReplay = false,
  ): SubagentJobRecoveryExecution {
    validateParentSessionId(parentSessionId);
    const updatedAt = this.clock.now().toISOString();
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT * FROM subagent_jobs
        WHERE parent_session_id = ? AND id = ?
      `).get(parentSessionId, jobId) as SubagentJobRow | undefined;
      if (!row) throw new SubagentJobNotFoundError(jobId);
      if (row.status !== "idle") throw new SubagentJobStateError(jobId, "awaiting recovery");
      const assessment = this.assessRecovery(row, allowExplicitReplay);
      if (assessment.projection.state === "decision_required" && !allowExplicitReplay) {
        throw new SubagentJobStateError(jobId, "an explicit external-effect retry decision");
      }
      if (assessment.projection.state === "unavailable" || !assessment.mode) {
        throw new SubagentJobStateError(jobId, "a valid recoverable checkpoint and remaining budget");
      }
      const transcriptJson = assessment.transcript === undefined
        ? null
        : boundedTranscriptJson(assessment.transcript);
      if (assessment.transcript !== undefined && transcriptJson === null) {
        throw new SubagentJobStateError(jobId, "a bounded reconciled recovery transcript");
      }
      const generation = currentRunGeneration(row);
      const runResult = this.database.connection.prepare(`
        UPDATE subagent_job_runs
        SET status = 'queued', updated_at = ?
        WHERE job_id = ? AND generation = ? AND status = 'idle'
      `).run(updatedAt, jobId, generation);
      const jobResult = this.database.connection.prepare(`
        UPDATE subagent_jobs
        SET status = 'queued', revision = revision + 1,
            transcript_json = ?, updated_at = ?
        WHERE parent_session_id = ? AND id = ? AND status = 'idle' AND revision = ?
      `).run(transcriptJson, updatedAt, parentSessionId, jobId, row.revision);
      if (Number(runResult.changes) !== 1 || Number(jobResult.changes) !== 1) {
        throw new SubagentJobStateError(jobId, "the staged durable recovery");
      }
      const queued = this.requireRow(jobId);
      return Object.freeze({
        job: mapSummary(queued),
        task: queued.task_text,
        ...(queued.context_text === null ? {} : { context: queued.context_text }),
        ...(queued.pending_input_text === null
          ? {}
          : { followupPrompt: queued.pending_input_text }),
        ...(assessment.transcript === undefined
          ? {}
          : { transcript: assessment.transcript }),
        timezone: normalizeSubagentTimezone(queued.timezone),
        mode: assessment.mode,
      });
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

  private requireRunRow(jobId: string, generation: number): SubagentJobRunRow {
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_job_runs WHERE job_id = ? AND generation = ?
    `).get(jobId, generation) as SubagentJobRunRow | undefined;
    if (!row) throw new SubagentJobStateError(jobId, `durable run generation ${generation}`);
    return row;
  }

  private requireToolCallRow(
    claim: SubagentJobRunClaim,
    toolCallId: string,
  ): SubagentToolCallRow {
    const row = this.database.connection.prepare(`
      SELECT * FROM subagent_job_tool_calls
      WHERE job_id = ? AND generation = ? AND attempt = ? AND tool_call_id = ?
    `).get(
      claim.job.id,
      claim.generation,
      claim.attempt,
      toolCallId,
    ) as SubagentToolCallRow | undefined;
    if (!row) {
      throw new SubagentJobStateError(claim.job.id, `journaled tool call ${toolCallId}`);
    }
    return row;
  }

  private requireClaimedRun(
    job: SubagentJobRow,
    claim: SubagentJobRunClaim,
  ): SubagentJobRunRow {
    if (claim.job.id !== job.id || claim.generation !== currentRunGeneration(job)) {
      throw new SubagentJobStateError(job.id, "the current durable run claim");
    }
    const row = this.requireRunRow(job.id, claim.generation);
    if (
      row.status !== "running" ||
      Number(row.attempt_count) !== claim.attempt ||
      row.owner_id !== claim.ownerId ||
      row.claim_token !== claim.claimToken
    ) {
      throw new SubagentJobStateError(job.id, "the active fenced run claim");
    }
    return row;
  }

  private persistRunCheckpoint(
    job: SubagentJobRow,
    run: SubagentJobRunRow,
    claim: SubagentJobRunClaim,
    progress: SubagentJobRunProgress,
    transcriptJson: string | null,
    updatedAt: string,
  ): SubagentJobRunUsage {
    const usage = monotonicRunUsage(
      run,
      claimedRunUsage(claim, progress, run.result_characters),
    );
    assertRunUsageWithinBudgets(claim.job.id, usage, parseBudgets(job.budgets_json));
    const result = this.database.connection.prepare(`
      UPDATE subagent_job_runs
      SET model_calls = ?, tool_calls = ?, input_tokens = ?, output_tokens = ?,
          duration_ms = ?, checkpoint_at = ?, updated_at = ?
      WHERE job_id = ? AND generation = ? AND status = 'running'
        AND attempt_count = ? AND owner_id = ? AND claim_token = ?
    `).run(
      usage.modelCalls,
      usage.toolCalls,
      usage.inputTokens,
      usage.outputTokens,
      usage.durationMs,
      updatedAt,
      updatedAt,
      claim.job.id,
      claim.generation,
      claim.attempt,
      claim.ownerId,
      claim.claimToken,
    );
    if (Number(result.changes) !== 1) {
      throw new SubagentJobStateError(claim.job.id, "the active fenced run claim");
    }
    this.database.connection.prepare(`
      UPDATE subagent_jobs SET transcript_json = ?
      WHERE id = ? AND status = 'running'
    `).run(transcriptJson, claim.job.id);
    return usage;
  }

  private insertQueuedRun(jobId: string, generation: number, createdAt: string): void {
    this.database.connection.prepare(`
      INSERT INTO subagent_job_runs(
        job_id, generation, status, attempt_count,
        model_calls, tool_calls, input_tokens, output_tokens, duration_ms,
        result_characters, checkpoint_at, owner_id, claim_token, lease_expires_at,
        attempt_started_at, created_at, updated_at, finished_at
      ) VALUES (?, ?, 'queued', 0, 0, 0, 0, 0, 0, 0,
        NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(jobId, generation, createdAt, createdAt);
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

  private assessRecovery(
    row: SubagentJobRow,
    allowExplicitReplay: boolean,
  ): SubagentRecoveryAssessment {
    const generation = currentRunGeneration(row);
    const run = this.requireRunRow(row.id, generation);
    const toolCalls = this.database.connection.prepare(`
      SELECT * FROM subagent_job_tool_calls
      WHERE job_id = ? AND generation = ?
      ORDER BY model_call, attempt, started_at, tool_call_id
    `).all(row.id, generation) as unknown as SubagentToolCallRow[];
    return assessRecoveryCheckpoint(
      row,
      run,
      toolCalls,
      allowExplicitReplay,
      this.clock.now().getTime(),
    );
  }

  private mapSummary(row: SubagentJobRow): SubagentJobSummary {
    return mapSummary(
      row,
      row.status === "idle" ? this.assessRecovery(row, false).projection : undefined,
    );
  }

  private mapDetail(row: SubagentJobRow): SubagentJobDetail {
    return mapDetail(
      row,
      row.status === "idle" ? this.assessRecovery(row, false).projection : undefined,
    );
  }

  private getSummaryById(jobId: string): SubagentJobSummary | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM subagent_jobs WHERE id = ?",
    ).get(jobId) as SubagentJobRow | undefined;
    return row ? this.mapSummary(row) : undefined;
  }
}

function mapSummary(
  row: SubagentJobRow,
  recovery?: SubagentJobRecoveryProjection,
): SubagentJobSummary {
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
    ...(recovery ? { recovery } : {}),
    ...(result ? { result } : {}),
    ...(failure ? { failure } : {}),
    recoveryCount: Number(row.recovery_count),
    createdAt: String(row.created_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    updatedAt: String(row.updated_at),
  });
}

function mapDetail(
  row: SubagentJobRow,
  recovery?: SubagentJobRecoveryProjection,
): SubagentJobDetail {
  const summary = mapSummary(row, recovery);
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

function currentRunGeneration(row: SubagentJobRow): number {
  return requiredBoundedInteger(
    Number(row.followup_count) + 1,
    "run generation",
    1,
    maximumSubagentFollowupTurns + 1,
  );
}

function assessRecoveryCheckpoint(
  job: SubagentJobRow,
  run: SubagentJobRunRow,
  journal: readonly SubagentToolCallRow[],
  allowExplicitReplay: boolean,
  nowMs: number,
): SubagentRecoveryAssessment {
  const generation = currentRunGeneration(job);
  const attemptCount = requiredBoundedInteger(
    run.attempt_count,
    "run attempt count",
    0,
    maximumSubagentRunAttempts,
  );
  const projection = (
    state: SubagentJobRecoveryProjection["state"],
    reason: SubagentJobRecoveryProjection["reason"],
    recoverableToolCalls: number,
    ambiguousToolCalls: number,
  ): SubagentJobRecoveryProjection => Object.freeze({
    state,
    reason,
    generation,
    attemptCount,
    recoverableToolCalls,
    ambiguousToolCalls,
  });
  if (run.status !== "idle") {
    return Object.freeze({
      projection: projection("unavailable", "checkpoint_invalid", 0, 0),
    });
  }

  let transcript: readonly unknown[] | undefined;
  try {
    transcript = parseTranscript(job.transcript_json);
  } catch {
    return Object.freeze({
      projection: projection("unavailable", "checkpoint_invalid", 0, 0),
    });
  }
  const inventory = recoveryTranscriptInventory(transcript ?? []);
  if (!inventory.valid || (transcript === undefined && journal.length > 0)) {
    return Object.freeze({
      projection: projection("unavailable", "checkpoint_invalid", 0, 0),
    });
  }
  const journalByToolCallId = new Map<string, SubagentToolCallRow>();
  for (const row of journal) {
    const knownCall = inventory.callsById.get(row.tool_call_id);
    if (!knownCall && !inventory.resultIds.has(row.tool_call_id)) {
      return Object.freeze({
        projection: projection("unavailable", "checkpoint_invalid", 0, 0),
      });
    }
    if (knownCall && knownCall.name !== row.tool_name) {
      return Object.freeze({
        projection: projection("unavailable", "checkpoint_invalid", 0, 0),
      });
    }
    const existing = journalByToolCallId.get(row.tool_call_id);
    if (!existing || row.attempt > existing.attempt) {
      journalByToolCallId.set(row.tool_call_id, row);
    }
  }

  const additions: unknown[] = [];
  let recoverableToolCalls = 0;
  let ambiguousToolCalls = 0;
  for (const call of inventory.calls) {
    if (inventory.resultIds.has(call.id)) continue;
    const row = journalByToolCallId.get(call.id);
    if (row?.status === "committed") {
      const result = recoveryCommittedToolResult(row, nowMs);
      if (!result) {
        return Object.freeze({
          projection: projection(
            "unavailable",
            "checkpoint_invalid",
            recoverableToolCalls,
            ambiguousToolCalls,
          ),
        });
      }
      recoverableToolCalls += 1;
      additions.push(result);
      continue;
    }
    const replayPolicy = row
      ? requiredToolReplayPolicy(row.replay_policy)
      : subagentToolReplayPolicy(call.name);
    if (replayPolicy === "automatic") {
      recoverableToolCalls += 1;
      additions.push(recoveryInterruptedToolResult(call, false, nowMs));
      continue;
    }
    ambiguousToolCalls += 1;
    if (allowExplicitReplay) {
      additions.push(recoveryInterruptedToolResult(call, true, nowMs));
    }
  }

  const recoveryState = ambiguousToolCalls > 0
    ? projection(
        "decision_required",
        "external_effect_ambiguous",
        recoverableToolCalls,
        ambiguousToolCalls,
      )
    : projection("automatic_pending", "safe_checkpoint", recoverableToolCalls, 0);
  const budgets = parseBudgets(job.budgets_json);
  const usage = mapRunUsage(run);
  if (attemptCount >= maximumSubagentRunAttempts) {
    return Object.freeze({
      projection: projection(
        "unavailable",
        "attempts_exhausted",
        recoverableToolCalls,
        ambiguousToolCalls,
      ),
    });
  }
  if (usage.modelCalls >= budgets.maxWorkModelCalls + 1 || usage.durationMs >= budgets.timeoutMs) {
    return Object.freeze({
      projection: projection(
        "unavailable",
        "budget_exhausted",
        recoverableToolCalls,
        ambiguousToolCalls,
      ),
    });
  }
  if (ambiguousToolCalls > 0 && !allowExplicitReplay) {
    return Object.freeze({ projection: recoveryState });
  }

  const reconciled = transcript === undefined
    ? undefined
    : [...transcript, ...additions];
  const normalized = stripRetryableTerminalAssistant(reconciled);
  const mode = recoveryExecutionMode(job, run, normalized);
  if (!mode || (normalized !== undefined && boundedTranscriptJson(normalized) === null)) {
    return Object.freeze({
      projection: projection(
        "unavailable",
        "checkpoint_invalid",
        recoverableToolCalls,
        ambiguousToolCalls,
      ),
    });
  }
  return Object.freeze({
    projection: recoveryState,
    ...(normalized === undefined ? {} : { transcript: Object.freeze(normalized) }),
    mode,
  });
}

function recoveryTranscriptInventory(transcript: readonly unknown[]): Readonly<{
  valid: boolean;
  calls: readonly RecoveryTranscriptToolCall[];
  callsById: ReadonlyMap<string, RecoveryTranscriptToolCall>;
  resultIds: ReadonlySet<string>;
}> {
  const calls: RecoveryTranscriptToolCall[] = [];
  const callsById = new Map<string, RecoveryTranscriptToolCall>();
  const resultIds = new Set<string>();
  let valid = true;
  for (const message of transcript) {
    if (!isPlainRecord(message)) {
      valid = false;
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isPlainRecord(block) || block.type !== "toolCall") continue;
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        if (!validRecoveryToolIdentity(id, 512) || !validRecoveryToolIdentity(name, 128) ||
            callsById.has(id)) {
          valid = false;
          continue;
        }
        const call = Object.freeze({ id, name });
        calls.push(call);
        callsById.set(id, call);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      if (!validRecoveryToolIdentity(id, 512) || resultIds.has(id)) {
        valid = false;
        continue;
      }
      resultIds.add(id);
    }
  }
  for (const resultId of resultIds) {
    if (!callsById.has(resultId)) valid = false;
  }
  return Object.freeze({
    valid,
    calls: Object.freeze(calls),
    callsById,
    resultIds,
  });
}

function recoveryCommittedToolResult(
  row: SubagentToolCallRow,
  fallbackTimestamp: number,
): Readonly<Record<string, unknown>> | undefined {
  if (row.result_json === null || row.result_sha256 === null || row.result_bytes === null ||
      row.is_error === null) return undefined;
  if (Buffer.byteLength(row.result_json, "utf8") !== Number(row.result_bytes) ||
      createHash("sha256").update(row.result_json).digest("hex") !== row.result_sha256) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(row.result_json);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(value) || !Array.isArray(value.content) ||
      typeof value.isError !== "boolean" || value.isError !== (row.is_error === 1)) {
    return undefined;
  }
  return Object.freeze({
    role: "toolResult",
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    content: value.content,
    ...(value.details === undefined ? {} : { details: value.details }),
    ...(value.usage === undefined ? {} : { usage: value.usage }),
    isError: value.isError,
    timestamp: recoveryTimestamp(row.finished_at, fallbackTimestamp),
  });
}

function recoveryInterruptedToolResult(
  call: RecoveryTranscriptToolCall,
  explicitlyAuthorized: boolean,
  timestamp: number,
): Readonly<Record<string, unknown>> {
  const text = explicitlyAuthorized
    ? "The prior external tool call was interrupted with an unknown outcome. The user explicitly authorized a retry; issue a new call only if it is still required."
    : "The prior local read was interrupted before its result checkpoint. It is safe to issue the read again if it is still required.";
  return Object.freeze({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: Object.freeze([{ type: "text", text }]),
    isError: true,
    timestamp,
  });
}

function stripRetryableTerminalAssistant(
  transcript: readonly unknown[] | undefined,
): unknown[] | undefined {
  if (transcript === undefined) return undefined;
  const output = [...transcript];
  const last = output.at(-1);
  if (isPlainRecord(last) && last.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted") &&
      !assistantRecordHasToolCall(last)) {
    output.pop();
  }
  return output;
}

function recoveryExecutionMode(
  job: SubagentJobRow,
  run: SubagentJobRunRow,
  transcript: readonly unknown[] | undefined,
): SubagentJobRecoveryExecution["mode"] | undefined {
  if (!transcript || transcript.length === 0 || Number(run.attempt_count) === 0) {
    return "prompt";
  }
  const last = transcript.at(-1);
  if (!isPlainRecord(last)) return undefined;
  if (
    job.pending_input_text !== null &&
    Number(run.model_calls) === 0 &&
    last.role === "assistant"
  ) {
    return "prompt";
  }
  if (last.role === "user" || last.role === "toolResult") return "continue";
  if (last.role === "assistant" && !assistantRecordHasToolCall(last)) return "finalize";
  return undefined;
}

function assistantRecordHasToolCall(message: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(message.content) && message.content.some((block) =>
    isPlainRecord(block) && block.type === "toolCall"
  );
}

function requiredToolReplayPolicy(value: string): SubagentToolReplayPolicy {
  if (value !== "automatic" && value !== "explicit") {
    throw new TypeError("Subagent tool replay policy is invalid");
  }
  return value;
}

function validRecoveryToolIdentity(value: string, maximumCharacters: number): boolean {
  return Boolean(value.trim()) && value === value.trim() && [...value].length <= maximumCharacters;
}

function recoveryTimestamp(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapRunUsage(row: SubagentJobRunRow): SubagentJobRunUsage {
  return Object.freeze({
    modelCalls: requiredBoundedInteger(row.model_calls, "run model calls", 0, 65),
    toolCalls: requiredBoundedInteger(row.tool_calls, "run tool calls", 0, 1_040),
    inputTokens: requiredBoundedInteger(
      row.input_tokens,
      "run input tokens",
      0,
      272_629_760,
    ),
    outputTokens: requiredBoundedInteger(
      row.output_tokens,
      "run output tokens",
      0,
      4_259_840,
    ),
    durationMs: requiredBoundedInteger(
      row.duration_ms,
      "run duration",
      0,
      maximumSubagentRunDurationMs,
    ),
    resultCharacters: requiredBoundedInteger(
      row.result_characters,
      "run result characters",
      0,
      maximumResultCharacters,
    ),
  });
}

function claimedRunUsage(
  claim: SubagentJobRunClaim,
  progress: SubagentJobRunProgress,
  resultCharacters: number,
): SubagentJobRunUsage {
  return Object.freeze({
    modelCalls: safeUsageSum(claim.baseline.modelCalls, progress.modelCalls),
    toolCalls: safeUsageSum(claim.baseline.toolCalls, progress.toolCalls),
    inputTokens: safeUsageSum(claim.baseline.inputTokens, progress.inputTokens),
    outputTokens: safeUsageSum(claim.baseline.outputTokens, progress.outputTokens),
    durationMs: safeUsageSum(claim.baseline.durationMs, progress.durationMs),
    resultCharacters,
  });
}

function forcedTerminalRunUsage(
  row: SubagentJobRunRow,
  progress: SubagentJobRunProgress,
  additionalResultCharacters: number,
): SubagentJobRunUsage {
  const current = mapRunUsage(row);
  return monotonicRunUsage(row, {
    ...progress,
    resultCharacters: safeUsageSum(current.resultCharacters, additionalResultCharacters),
  });
}

function monotonicRunUsage(
  row: SubagentJobRunRow,
  candidate: SubagentJobRunUsage,
): SubagentJobRunUsage {
  const current = mapRunUsage(row);
  return Object.freeze({
    modelCalls: Math.max(current.modelCalls, candidate.modelCalls),
    toolCalls: Math.max(current.toolCalls, candidate.toolCalls),
    inputTokens: Math.max(current.inputTokens, candidate.inputTokens),
    outputTokens: Math.max(current.outputTokens, candidate.outputTokens),
    durationMs: Math.max(current.durationMs, candidate.durationMs),
    resultCharacters: Math.max(current.resultCharacters, candidate.resultCharacters),
  });
}

function safeUsageSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Subagent run usage exceeds the safe integer range");
  }
  return result;
}

function validateRunProgress(progress: SubagentJobRunProgress): void {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    throw new TypeError("Subagent run progress must be an object");
  }
  for (const key of [
    "modelCalls",
    "toolCalls",
    "inputTokens",
    "outputTokens",
    "durationMs",
  ] as const) {
    if (!Number.isSafeInteger(progress[key]) || progress[key] < 0) {
      throw new TypeError(`Subagent run progress ${key} must be a non-negative safe integer`);
    }
  }
}

function assertRunCanStart(
  jobId: string,
  row: SubagentJobRunRow,
  budgets: SubagentJobBudgetSnapshot,
): void {
  if (row.status !== "queued" && row.status !== "idle") {
    throw new SubagentJobStateError(jobId, "a queued durable run");
  }
  if (Number(row.attempt_count) >= maximumSubagentRunAttempts) {
    throw new SubagentJobStateError(jobId, "a remaining durable run attempt");
  }
  const usage = mapRunUsage(row);
  if (usage.modelCalls >= budgets.maxWorkModelCalls + 1 ||
      usage.durationMs >= budgets.timeoutMs) {
    throw new SubagentJobStateError(jobId, "remaining frozen model and time budget");
  }
}

function assertCompletionMatchesBudgets(
  jobId: string,
  completion: SubagentJobCompletion,
  outputCharacters: number,
  budgets: SubagentJobBudgetSnapshot,
): void {
  if (
    completion.maxResultCharacters !== budgets.maxResultCharacters ||
    outputCharacters > budgets.maxResultCharacters
  ) {
    throw new SubagentJobStateError(jobId, "the frozen result-size budget");
  }
}

function assertRunUsageWithinBudgets(
  jobId: string,
  usage: SubagentJobRunUsage,
  budgets: SubagentJobBudgetSnapshot,
): void {
  const maximumModelCalls = budgets.maxWorkModelCalls + 1;
  if (
    usage.modelCalls > maximumModelCalls ||
    usage.toolCalls > maximumModelCalls * maximumSubagentToolCallsPerModelCall ||
    usage.inputTokens > maximumModelCalls * maximumSubagentTranscriptBytes ||
    usage.outputTokens > maximumModelCalls * budgets.maxOutputTokens ||
    usage.durationMs > budgets.timeoutMs + maximumSubagentRunLeaseGraceMs ||
    usage.resultCharacters > budgets.maxResultCharacters
  ) {
    throw new SubagentJobStateError(jobId, "the frozen cumulative run budget");
  }
}

function clampRunUsageToBudgets(
  usage: SubagentJobRunUsage,
  budgets: SubagentJobBudgetSnapshot,
): SubagentJobRunUsage {
  const maximumModelCalls = budgets.maxWorkModelCalls + 1;
  return Object.freeze({
    modelCalls: Math.min(usage.modelCalls, maximumModelCalls),
    toolCalls: Math.min(
      usage.toolCalls,
      maximumModelCalls * maximumSubagentToolCallsPerModelCall,
    ),
    inputTokens: Math.min(
      usage.inputTokens,
      maximumModelCalls * maximumSubagentTranscriptBytes,
    ),
    outputTokens: Math.min(usage.outputTokens, maximumModelCalls * budgets.maxOutputTokens),
    durationMs: Math.min(
      usage.durationMs,
      budgets.timeoutMs + maximumSubagentRunLeaseGraceMs,
    ),
    resultCharacters: Math.min(usage.resultCharacters, budgets.maxResultCharacters),
  });
}

export function subagentToolReplayPolicy(toolName: string): SubagentToolReplayPolicy {
  validateToolIdentity("tool name", toolName, 128);
  return automaticallyReplayableSubagentTools.has(toolName) ? "automatic" : "explicit";
}

function normalizeToolCallStart(input: SubagentToolCallStart): SubagentToolCallStart {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Subagent tool call start must be an object");
  }
  validateToolIdentity("tool call ID", input.toolCallId, 512);
  validateToolIdentity("tool name", input.toolName, 128);
  if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) {
    throw new TypeError("Subagent tool call input must be an object");
  }
  return Object.freeze({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.input,
  });
}

function normalizeToolCallResult(input: SubagentToolCallResult): SubagentToolCallResult {
  const start = normalizeToolCallStart(input);
  if (!Array.isArray(input.content)) {
    throw new TypeError("Subagent tool result content must be an array");
  }
  if (typeof input.isError !== "boolean") {
    throw new TypeError("Subagent tool result isError must be a boolean");
  }
  return Object.freeze({
    ...start,
    content: input.content,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    isError: input.isError,
  });
}

function boundedToolArgumentsJson(input: Readonly<Record<string, unknown>>): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    throw new TypeError("Subagent tool call input must be JSON serializable");
  }
  if (json === undefined || Buffer.byteLength(json, "utf8") > maximumSubagentToolArgumentsBytes) {
    throw new TypeError(
      `Subagent tool call input must fit within ${maximumSubagentToolArgumentsBytes} bytes`,
    );
  }
  return json;
}

type SerializedToolResult =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "json"; json: string; sha256: string; bytes: number }>;

type ToolResultDisposition = Readonly<{
  status: "committed" | "result_unavailable";
  reason: "not_json" | "too_large" | "run_limit" | null;
}>;

function serializeToolResult(input: SubagentToolCallResult): SerializedToolResult {
  let json: string | undefined;
  try {
    json = JSON.stringify({
      content: input.content,
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      isError: input.isError,
    });
  } catch {
    return Object.freeze({ kind: "unavailable" });
  }
  if (json === undefined) return Object.freeze({ kind: "unavailable" });
  return Object.freeze({
    kind: "json",
    json,
    sha256: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json, "utf8"),
  });
}

function toolResultMatches(
  row: SubagentToolCallRow,
  result: SubagentToolCallResult,
  serialized: SerializedToolResult,
  disposition: ToolResultDisposition,
): boolean {
  return row.status === disposition.status &&
    row.result_reason === disposition.reason &&
    row.result_sha256 === (serialized.kind === "json" ? serialized.sha256 : null) &&
    row.result_bytes === (serialized.kind === "json" ? serialized.bytes : null) &&
    row.is_error === (result.isError ? 1 : 0);
}

function validateToolIdentity(label: string, value: string, maximumCharacters: number): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > maximumCharacters) {
    throw new TypeError(`Subagent ${label} is invalid`);
  }
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
  return isGrantScopeSubset(candidate, previous) && toolNamesAreSubset(candidate, previous);
}

function isGrantScopeSubset(
  candidate: SubagentJobGrantSnapshot,
  previous: SubagentJobGrantSnapshot,
): boolean {
  if (candidate.workspaceAccess === "read_only" && previous.workspaceAccess === "off") {
    return false;
  }
  const previousModules = new Set(previous.moduleIds);
  const previousSkills = new Set(previous.skillNames);
  return candidate.moduleIds.every((value) => previousModules.has(value)) &&
    candidate.skillNames.every((value) => previousSkills.has(value));
}

function toolNamesAreSubset(
  candidate: SubagentJobGrantSnapshot,
  previous: SubagentJobGrantSnapshot,
): boolean {
  const previousTools = new Set(previous.toolNames);
  return candidate.toolNames.every((value) => previousTools.has(value));
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
  normalizeSubagentTimezone(input.timezone);
  if (input.notifyParent !== undefined && typeof input.notifyParent !== "boolean") {
    throw new TypeError("Subagent notifyParent must be a boolean");
  }
  if (input.admissionKey !== undefined) validateAdmissionKey(input.admissionKey);
  parseBudgets(JSON.stringify(input.budgets));
  normalizeGrants(input.grants);
}

function validateAdmissionKey(value: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > 256) {
    throw new TypeError("Subagent admissionKey must contain 1-256 trimmed characters");
  }
}

function normalizeSubagentTimezone(value: string | undefined): string {
  const timezone = value ?? "Asia/Shanghai";
  if (typeof timezone !== "string" || !timezone.trim() || timezone !== timezone.trim() ||
      [...timezone].length > 200) {
    throw new TypeError("Subagent job timezone must contain 1-200 trimmed characters");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("Subagent job timezone must be a valid IANA timezone");
  }
  return timezone;
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
  const ranges = {
    maxConcurrentTasks: [
      minimumSubagentSettings.maxConcurrentTasks,
      maximumSubagentSettings.maxConcurrentTasks,
    ],
    maxWorkModelCalls: [
      minimumSubagentSettings.maxWorkModelCalls,
      maximumSubagentSettings.maxWorkModelCalls,
    ],
    maxOutputTokens: [
      minimumSubagentSettings.maxOutputTokens,
      maximumSubagentSettings.maxOutputTokens,
    ],
    maxResultCharacters: [
      minimumSubagentSettings.maxResultCharacters,
      maximumSubagentSettings.maxResultCharacters,
    ],
    timeoutSeconds: [
      minimumSubagentSettings.timeoutSeconds,
      maximumSubagentSettings.timeoutSeconds,
    ],
    timeoutMs: [1, maximumSubagentRunTimeoutMs],
  } as const satisfies Record<keyof SubagentJobBudgetSnapshot, readonly [number, number]>;
  for (const [key, [minimum, maximum]] of Object.entries(ranges) as Array<
    [keyof SubagentJobBudgetSnapshot, readonly [number, number]]
  >) {
    if (!Number.isSafeInteger(value[key]) ||
        Number(value[key]) < minimum || Number(value[key]) > maximum) {
      throw new TypeError(`Subagent job budget ${key} is invalid`);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(ranges).map((key) => [key, Number(value[key])]),
  ) as unknown as SubagentJobBudgetSnapshot);
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

function validateRunOwnerId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > 256) {
    throw new TypeError("Subagent run owner ID is invalid");
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
