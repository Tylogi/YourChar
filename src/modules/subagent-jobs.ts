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
const jobRoles = new Set<SubagentRole>(["worker", "researcher", "planner", "reviewer"]);
const jobStatuses = new Set<SubagentJobStatus>([
  "queued",
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
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
  recovery_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
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
 * Durable, host-owned ledger around the legacy blocking Subagent runner.
 * Raw task/context live only in this private table so ordinary audits and list
 * views can identify work without reproducing delegated prompts.
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

  complete(jobId: string, completion: SubagentJobCompletion): SubagentJobDetail {
    validateCompletion(completion);
    const updatedAt = this.clock.now().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE subagent_jobs
      SET status = 'completed', revision = revision + 1, result_json = ?,
          failure_json = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(JSON.stringify(completion), updatedAt, updatedAt, jobId);
    if (Number(result.changes) !== 1) throw new SubagentJobStateError(jobId, "running");
    return this.requireDetail(jobId);
  }

  fail(jobId: string, failure: SubagentFailureDiagnostic): SubagentJobSummary {
    validateFailure(failure);
    const status: SubagentJobStatus = failure.failureKind === "cancelled"
      ? "cancelled"
      : "failed";
    const updatedAt = this.clock.now().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE subagent_jobs
      SET status = ?, revision = revision + 1, failure_json = ?,
          result_json = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(status, JSON.stringify(failure), updatedAt, updatedAt, jobId);
    if (Number(result.changes) !== 1) {
      const current = this.getSummaryById(jobId);
      if (current && isTerminal(current.status)) return current;
      throw new SubagentJobStateError(jobId, "queued or running");
    }
    return this.requireSummary(jobId);
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

  deleteForParentSession(parentSessionId: string): number {
    return Number(this.database.connection.prepare(
      "DELETE FROM subagent_jobs WHERE parent_session_id = ?",
    ).run(parentSessionId).changes);
  }

  /** Fail closed on startup; automatic continuation arrives in a later P2 slice. */
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
    this.database.connection.prepare(`
      UPDATE subagent_jobs
      SET status = 'failed', revision = revision + 1, failure_json = ?,
          result_json = NULL, recovery_count = recovery_count + 1,
          finished_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(JSON.stringify(failure), updatedAt, updatedAt);
  }

  private requireSummary(jobId: string): SubagentJobSummary {
    const job = this.getSummaryById(jobId);
    if (!job) throw new SubagentJobNotFoundError(jobId);
    return job;
  }

  private requireDetail(jobId: string): SubagentJobDetail {
    const row = this.database.connection.prepare(
      "SELECT * FROM subagent_jobs WHERE id = ?",
    ).get(jobId) as SubagentJobRow | undefined;
    if (!row) throw new SubagentJobNotFoundError(jobId);
    return mapDetail(row);
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

function isTerminal(status: SubagentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
