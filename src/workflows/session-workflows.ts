import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace, Mode } from "../domain/types.js";
import type { SubagentRole } from "../mcp/subagent-server.js";
import type { SubagentJobGrantSnapshot } from "../modules/subagent-jobs.js";
import type { WorkspaceAccess } from "../modules/types.js";
import type { AppDatabase } from "../storage/database.js";

export const maximumWorkflowNodes = 16;
export const maximumWorkflowDependenciesPerNode = 8;
export const maximumWorkflowConcurrency = 4;
export const maximumWorkflowDurationSeconds = 86_400;
export const maximumWorkflowNodeTimeoutSeconds = 3_600;
export const maximumWorkflowTitleCharacters = 240;
export const maximumWorkflowNodeKeyCharacters = 80;
export const maximumWorkflowTaskCharacters = 4_000;
export const maximumWorkflowContextCharacters = 8_000;
export const maximumWorkflowCommandCharacters = 32_768;
export const maximumWorkflowPrivateInputBytes = 65_536;
export const maximumWorkflowTotalPrivateInputBytes = 65_536;
export const maximumWorkflowTerminalNoteCharacters = 2_000;
export const maximumWorkflowListLimit = 100;
export const maximumWorkflowEventLimit = 100;
export const maximumWorkflowReplayCount = 3;

export type SessionWorkflowStatus =
  | "planned"
  | "running"
  | "blocked"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type SessionWorkflowNodeStatus =
  | "pending"
  | "launching"
  | "running"
  | "decision_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type SessionWorkflowMutationSource = "agent" | "http" | "host" | "recovery";
export type SessionWorkflowNodeKind = "subagent" | "shell";
export type SessionWorkflowReplayDecision = "retry" | "skip" | "cancel";
export type SessionWorkflowDecisionReason =
  | "process_restarted"
  | "external_effect_ambiguous"
  | "child_missing";

export type SessionWorkflowScope = Readonly<{
  parentSessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
}>;

export type SessionWorkflowGrantCeiling = Readonly<{
  subagent: Readonly<{
    available: boolean;
    workspaceAccess: Extract<WorkspaceAccess, "off" | "read_only">;
    moduleIds: readonly string[];
    skillNames: readonly string[];
  }>;
  shell: Readonly<{
    available: boolean;
    workspaceAccess: WorkspaceAccess;
    networkEnabled: boolean;
  }>;
}>;

export type WorkflowSubagentNodeInput = Readonly<{
  key: string;
  kind: "subagent";
  dependsOn?: readonly string[];
  role: SubagentRole;
  task: string;
  context?: string;
  timeoutSeconds?: number;
  workspaceAccess?: Extract<WorkspaceAccess, "off" | "read_only">;
  moduleIds?: readonly string[];
  skillNames?: readonly string[];
}>;

export type WorkflowShellNodeInput = Readonly<{
  key: string;
  kind: "shell";
  dependsOn?: readonly string[];
  command: string;
  timeoutSeconds?: number;
  workspaceAccess?: WorkspaceAccess;
  networkEnabled?: boolean;
}>;

export type SessionWorkflowNodeInput = WorkflowSubagentNodeInput | WorkflowShellNodeInput;

export type CreateSessionWorkflowInput = Readonly<{
  title: string;
  nodes: readonly SessionWorkflowNodeInput[];
  maxConcurrency?: number;
  timeoutSeconds?: number;
}>;

export type SessionWorkflowNodeGrant =
  | Readonly<{
      kind: "subagent";
      workspaceAccess: Extract<WorkspaceAccess, "off" | "read_only">;
      moduleIds: readonly string[];
      skillNames: readonly string[];
    }>
  | Readonly<{
      kind: "shell";
      workspaceAccess: WorkspaceAccess;
      networkEnabled: boolean;
    }>;

export type SessionWorkflowResultReference = Readonly<{
  kind: "subagent_job" | "execution_job" | "workflow_decision";
  status: string;
  jobId?: string;
  childSessionId?: string;
  digest?: string;
  attempt?: number;
  outputBytes?: number;
  outputTruncated?: boolean;
  reason?: string;
}>;

export type SessionWorkflowNodeSummary = Readonly<{
  id: string;
  workflowId: string;
  key: string;
  kind: SessionWorkflowNodeKind;
  status: SessionWorkflowNodeStatus;
  revision: number;
  dependsOn: readonly string[];
  inputSha256: string;
  inputCharacters: number;
  grants: SessionWorkflowNodeGrant;
  timeoutSeconds: number;
  childJobId?: string;
  resultReference?: SessionWorkflowResultReference;
  decisionReason?: SessionWorkflowDecisionReason;
  replayCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type SessionWorkflowCounts = Readonly<{
  pending: number;
  active: number;
  decisionRequired: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  total: number;
}>;

export type SessionWorkflowSummary = Readonly<{
  id: string;
  parentSessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  title: string;
  status: SessionWorkflowStatus;
  revision: number;
  maxConcurrency: number;
  timeoutSeconds: number;
  counts: SessionWorkflowCounts;
  createdAt: string;
  startedAt?: string;
  deadlineAt?: string;
  finishedAt?: string;
  updatedAt: string;
}>;

export type SessionWorkflowEvent = Readonly<{
  id: string;
  sequence: number;
  type:
    | "workflow_created"
    | "workflow_started"
    | "workflow_status_changed"
    | "node_launch_reserved"
    | "node_attached"
    | "node_status_changed"
    | "node_replay_decided";
  source: SessionWorkflowMutationSource;
  nodeId?: string;
  createdAt: string;
}>;

export type SessionWorkflowDetail = SessionWorkflowSummary & Readonly<{
  terminalNote?: string;
  nodes: readonly SessionWorkflowNodeSummary[];
  recentEvents: readonly SessionWorkflowEvent[];
}>;

/** Private node material. Never expose it from list/detail/tool/API projections. */
export type SessionWorkflowNodeExecution = Readonly<{
  node: SessionWorkflowNodeSummary;
  admissionKey: string;
  input:
    | Readonly<{ role: SubagentRole; task: string; context?: string }>
    | Readonly<{ command: string }>;
}>;

type WorkflowRow = {
  id: string;
  parent_session_id: string;
  mode: string;
  conversation_space: string;
  character_id: string | null;
  secret_owner_character_id: string | null;
  title: string;
  status: string;
  revision: number;
  max_concurrency: number;
  timeout_seconds: number;
  deadline_at: string | null;
  cancellation_note: string | null;
  terminal_note: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

type WorkflowNodeRow = {
  id: string;
  workflow_id: string;
  parent_session_id: string;
  node_key: string;
  kind: string;
  status: string;
  revision: number;
  input_json: string;
  input_sha256: string;
  input_characters: number;
  grants_json: string;
  timeout_seconds: number;
  admission_key: string;
  child_job_id: string | null;
  result_ref_json: string | null;
  decision_reason: string | null;
  replay_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

type WorkflowEventRow = {
  id: string;
  sequence: number;
  event_type: string;
  source: string;
  node_id: string | null;
  created_at: string;
};

type NormalizedNode = Readonly<{
  key: string;
  kind: SessionWorkflowNodeKind;
  dependsOn: readonly string[];
  inputJson: string;
  inputSha256: string;
  inputCharacters: number;
  grants: SessionWorkflowNodeGrant;
  timeoutSeconds: number;
}>;

const terminalWorkflowStatuses = new Set<SessionWorkflowStatus>([
  "completed", "failed", "cancelled",
]);
const terminalNodeStatuses = new Set<SessionWorkflowNodeStatus>([
  "completed", "failed", "cancelled", "skipped",
]);

export class SessionWorkflowNotFoundError extends Error {
  readonly code = "SESSION_WORKFLOW_NOT_FOUND";
  constructor(workflowId: string) {
    super(`Workflow is unavailable: ${workflowId}`);
    this.name = "SessionWorkflowNotFoundError";
  }
}

export class SessionWorkflowConflictError extends Error {
  readonly code = "SESSION_WORKFLOW_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "SessionWorkflowConflictError";
  }
}

export class SessionWorkflowValidationError extends Error {
  readonly code = "SESSION_WORKFLOW_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "SessionWorkflowValidationError";
  }
}

/** Durable bounded-DAG projection and typed transition ledger. */
export class SessionWorkflowService {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  create(
    scope: SessionWorkflowScope,
    input: CreateSessionWorkflowInput,
    ceiling: SessionWorkflowGrantCeiling,
    source: SessionWorkflowMutationSource = "host",
  ): SessionWorkflowDetail {
    validateScope(scope);
    validateSource(source);
    const title = boundedText(input.title, "title", maximumWorkflowTitleCharacters);
    const maxConcurrency = boundedInteger(
      input.maxConcurrency ?? 2,
      "maxConcurrency",
      1,
      maximumWorkflowConcurrency,
    );
    const timeoutSeconds = boundedInteger(
      input.timeoutSeconds ?? 1_800,
      "timeoutSeconds",
      1,
      maximumWorkflowDurationSeconds,
    );
    validateGrantCeiling(ceiling);
    const nodes = normalizeNodes(input.nodes, ceiling, timeoutSeconds);
    const workflowId = this.idGenerator.next("session-workflow");
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO session_workflows(
          id, parent_session_id, mode, conversation_space, character_id,
          secret_owner_character_id, title, status, revision, max_concurrency,
          timeout_seconds, deadline_at, cancellation_note, terminal_note, created_at, started_at,
          finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)
      `).run(
        workflowId,
        scope.parentSessionId,
        scope.mode,
        scope.conversationSpace,
        scope.characterId ?? null,
        scope.secretOwnerCharacterId ?? null,
        title,
        maxConcurrency,
        timeoutSeconds,
        now,
        now,
      );
      const nodeIds = new Map<string, string>();
      for (const node of nodes) nodeIds.set(node.key, this.idGenerator.next("workflow-node"));
      const insertNode = this.database.connection.prepare(`
        INSERT INTO session_workflow_nodes(
          id, workflow_id, parent_session_id, node_key, kind, status, revision,
          input_json, input_sha256, input_characters, grants_json, timeout_seconds,
          admission_key, child_job_id, result_ref_json, decision_reason, replay_count,
          created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, NULL, NULL, ?)
      `);
      for (const node of nodes) {
        const nodeId = nodeIds.get(node.key)!;
        insertNode.run(
          nodeId,
          workflowId,
          scope.parentSessionId,
          node.key,
          node.kind,
          node.inputJson,
          node.inputSha256,
          node.inputCharacters,
          JSON.stringify(node.grants),
          node.timeoutSeconds,
          workflowAdmissionKey(workflowId, node.key),
          now,
          now,
        );
      }
      const insertDependency = this.database.connection.prepare(`
        INSERT INTO session_workflow_dependencies(
          workflow_id, parent_session_id, node_id, depends_on_node_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const node of nodes) {
        for (const dependencyKey of node.dependsOn) {
          insertDependency.run(
            workflowId,
            scope.parentSessionId,
            nodeIds.get(node.key)!,
            nodeIds.get(dependencyKey)!,
            now,
          );
        }
      }
      this.appendEvent({
        workflowId,
        parentSessionId: scope.parentSessionId,
        type: "workflow_created",
        source,
        payload: {
          title,
          maxConcurrency,
          timeoutSeconds,
          nodes: nodes.map((node) => ({
            key: node.key,
            kind: node.kind,
            dependsOn: node.dependsOn,
            inputSha256: node.inputSha256,
            inputCharacters: node.inputCharacters,
            grants: node.grants,
            timeoutSeconds: node.timeoutSeconds,
          })),
        },
        now,
      });
    });
    return this.requireDetail(scope.parentSessionId, workflowId);
  }

  list(
    parentSessionId: string,
    options: { includeTerminal?: boolean; limit?: number } = {},
  ): readonly SessionWorkflowSummary[] {
    validateId(parentSessionId, "parentSessionId");
    const limit = boundedInteger(
      options.limit ?? 20,
      "limit",
      1,
      maximumWorkflowListLimit,
    );
    const terminalClause = options.includeTerminal
      ? ""
      : "AND status NOT IN ('completed', 'failed', 'cancelled')";
    const rows = this.database.connection.prepare(`
      SELECT * FROM session_workflows
      WHERE parent_session_id = ? ${terminalClause}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(parentSessionId, limit) as unknown as WorkflowRow[];
    return Object.freeze(rows.map((row) => this.mapSummary(row)));
  }

  get(
    parentSessionId: string,
    workflowId: string,
    eventLimit = 20,
  ): SessionWorkflowDetail | undefined {
    validateId(parentSessionId, "parentSessionId");
    validateId(workflowId, "workflowId");
    boundedInteger(eventLimit, "eventLimit", 0, maximumWorkflowEventLimit);
    const row = this.findWorkflow(parentSessionId, workflowId);
    return row ? this.mapDetail(row, eventLimit) : undefined;
  }

  start(
    parentSessionId: string,
    workflowId: string,
    expectedRevision: number,
    source: SessionWorkflowMutationSource = "host",
  ): SessionWorkflowDetail {
    validateSource(source);
    boundedInteger(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const workflow = this.requireWorkflow(parentSessionId, workflowId);
    if (workflow.revision !== expectedRevision) throw revisionConflict(workflow);
    if (workflow.status !== "planned") {
      throw new SessionWorkflowConflictError(`Workflow ${workflowId} is not planned`);
    }
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const deadlineAt = new Date(
      nowDate.getTime() + Number(workflow.timeout_seconds) * 1_000,
    ).toISOString();
    this.database.transaction(() => {
      const changed = this.database.connection.prepare(`
        UPDATE session_workflows
        SET status = 'running', revision = revision + 1,
            started_at = ?, deadline_at = ?, updated_at = ?
        WHERE id = ? AND parent_session_id = ? AND status = 'planned' AND revision = ?
      `).run(now, deadlineAt, now, workflowId, parentSessionId, expectedRevision);
      if (Number(changed.changes) !== 1) throw revisionConflict(workflow);
      this.appendEvent({
        workflowId,
        parentSessionId,
        type: "workflow_started",
        source,
        payload: { deadlineAt },
        now,
      });
    });
    return this.requireDetail(parentSessionId, workflowId);
  }

  requestCancel(
    parentSessionId: string,
    workflowId: string,
    expectedRevision: number,
    note: string,
    source: SessionWorkflowMutationSource = "host",
  ): SessionWorkflowDetail {
    validateSource(source);
    const terminalNote = boundedText(
      note,
      "note",
      maximumWorkflowTerminalNoteCharacters,
    );
    const workflow = this.requireWorkflow(parentSessionId, workflowId);
    if (workflow.revision !== expectedRevision) throw revisionConflict(workflow);
    if (terminalWorkflowStatuses.has(workflow.status as SessionWorkflowStatus)) {
      return this.mapDetail(workflow, 20);
    }
    const now = this.now();
    this.database.transaction(() => {
      if (workflow.status === "planned") {
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'skipped', revision = revision + 1,
              result_ref_json = ?, finished_at = ?, updated_at = ?
          WHERE workflow_id = ? AND status IN ('pending', 'decision_required')
        `).run(
          JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: "cancelled" }),
          now,
          now,
          workflowId,
        );
        this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = 'cancelled', revision = revision + 1,
              terminal_note = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND status = 'planned' AND revision = ?
        `).run(terminalNote, now, now, workflowId, parentSessionId, expectedRevision);
      } else {
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'skipped', revision = revision + 1,
              result_ref_json = ?, finished_at = ?, updated_at = ?
          WHERE workflow_id = ? AND status IN ('pending', 'decision_required')
        `).run(
          JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: "cancelled" }),
          now,
          now,
          workflowId,
        );
        const changed = this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = 'cancelling', revision = revision + 1, updated_at = ?
              , cancellation_note = ?
          WHERE id = ? AND parent_session_id = ?
            AND status IN ('running', 'blocked') AND revision = ?
        `).run(now, terminalNote, workflowId, parentSessionId, expectedRevision);
        if (Number(changed.changes) !== 1) throw revisionConflict(workflow);
      }
      this.appendEvent({
        workflowId,
        parentSessionId,
        type: "workflow_status_changed",
        source,
        payload: {
          from: workflow.status,
          to: workflow.status === "planned" ? "cancelled" : "cancelling",
          requestedTerminalNote: terminalNote,
        },
        now,
      });
    });
    return this.requireDetail(parentSessionId, workflowId);
  }

  /** Reserve currently ready nodes without ever exceeding this workflow's budget. */
  reserveReady(
    parentSessionId: string,
    workflowId: string,
    limit = maximumWorkflowConcurrency,
    source: SessionWorkflowMutationSource = "host",
  ): readonly SessionWorkflowNodeExecution[] {
    validateSource(source);
    boundedInteger(limit, "limit", 1, maximumWorkflowConcurrency);
    return this.database.transaction(() => {
      const workflow = this.requireWorkflow(parentSessionId, workflowId);
      if (workflow.status !== "running") return Object.freeze([]);
      const active = Number((this.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM session_workflow_nodes
        WHERE workflow_id = ? AND status IN ('launching', 'running')
      `).get(workflowId) as { count: number }).count);
      const slots = Math.min(limit, Number(workflow.max_concurrency) - active);
      if (slots <= 0) return Object.freeze([]);
      const rows = this.database.connection.prepare(`
        SELECT n.* FROM session_workflow_nodes n
        WHERE n.workflow_id = ? AND n.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM session_workflow_dependencies d
            JOIN session_workflow_nodes prerequisite
              ON prerequisite.id = d.depends_on_node_id
            WHERE d.workflow_id = n.workflow_id AND d.node_id = n.id
              AND prerequisite.status NOT IN ('completed', 'skipped')
          )
        ORDER BY n.node_key ASC LIMIT ?
      `).all(workflowId, slots) as unknown as WorkflowNodeRow[];
      const now = this.now();
      const reserved: SessionWorkflowNodeExecution[] = [];
      for (const row of rows) {
        const changed = this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'launching', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'pending' AND revision = ?
        `).run(now, row.id, row.revision);
        if (Number(changed.changes) !== 1) continue;
        this.touchWorkflow(workflowId, now);
        this.appendEvent({
          workflowId,
          parentSessionId,
          type: "node_launch_reserved",
          source,
          nodeId: row.id,
          payload: { nodeKey: row.node_key, admissionKey: row.admission_key },
          now,
        });
        reserved.push(this.mapExecution(this.requireNode(row.id)));
      }
      return Object.freeze(reserved);
    });
  }

  listLaunching(parentSessionId: string, workflowId: string): readonly SessionWorkflowNodeExecution[] {
    this.requireWorkflow(parentSessionId, workflowId);
    const rows = this.database.connection.prepare(`
      SELECT * FROM session_workflow_nodes
      WHERE workflow_id = ? AND status = 'launching' ORDER BY node_key ASC
    `).all(workflowId) as unknown as WorkflowNodeRow[];
    return Object.freeze(rows.map((row) => this.mapExecution(row)));
  }

  getNodeExecution(
    parentSessionId: string,
    nodeId: string,
  ): SessionWorkflowNodeExecution {
    return this.mapExecution(this.requireScopedNode(parentSessionId, nodeId));
  }

  deferUnattachedLaunch(
    parentSessionId: string,
    nodeId: string,
  ): SessionWorkflowNodeSummary {
    const row = this.requireScopedNode(parentSessionId, nodeId);
    if (row.status !== "launching" || row.child_job_id) return this.mapNode(row);
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE session_workflow_nodes
        SET status = 'pending', revision = revision + 1, updated_at = ?
        WHERE id = ? AND status = 'launching' AND child_job_id IS NULL
      `).run(now, nodeId);
      this.touchWorkflow(row.workflow_id, now);
      this.appendEvent({
        workflowId: row.workflow_id,
        parentSessionId,
        type: "node_status_changed",
        source: "host",
        nodeId,
        payload: { from: "launching", to: "pending", reason: "capacity_deferred" },
        now,
      });
    });
    return this.mapNode(this.requireNode(nodeId));
  }

  dependencyReferences(nodeId: string): readonly SessionWorkflowResultReference[] {
    const rows = this.database.connection.prepare(`
      SELECT prerequisite.result_ref_json
      FROM session_workflow_dependencies dependency
      JOIN session_workflow_nodes prerequisite
        ON prerequisite.id = dependency.depends_on_node_id
      WHERE dependency.node_id = ?
      ORDER BY prerequisite.node_key ASC
    `).all(nodeId) as Array<{ result_ref_json: string | null }>;
    return Object.freeze(rows.flatMap((row) => row.result_ref_json
      ? [parseResultReference(row.result_ref_json)]
      : []));
  }

  attachChild(
    parentSessionId: string,
    nodeId: string,
    childJobId: string,
    source: SessionWorkflowMutationSource = "host",
  ): SessionWorkflowNodeSummary {
    validateSource(source);
    validateId(childJobId, "childJobId");
    return this.database.transaction(() => {
      const row = this.requireScopedNode(parentSessionId, nodeId);
      if (row.child_job_id && row.child_job_id !== childJobId) {
        throw new SessionWorkflowConflictError(`Workflow node ${nodeId} already has a child`);
      }
      if (row.child_job_id === childJobId && row.status === "running") return this.mapNode(row);
      if (row.status !== "launching") {
        throw new SessionWorkflowConflictError(`Workflow node ${nodeId} is not launching`);
      }
      const now = this.now();
      const changed = this.database.connection.prepare(`
        UPDATE session_workflow_nodes
        SET status = 'running', revision = revision + 1, child_job_id = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND parent_session_id = ? AND status = 'launching' AND revision = ?
      `).run(childJobId, now, now, nodeId, parentSessionId, row.revision);
      if (Number(changed.changes) !== 1) {
        throw new SessionWorkflowConflictError(`Workflow node ${nodeId} changed concurrently`);
      }
      this.touchWorkflow(row.workflow_id, now);
      this.appendEvent({
        workflowId: row.workflow_id,
        parentSessionId,
        type: "node_attached",
        source,
        nodeId,
        payload: { childJobId, kind: row.kind },
        now,
      });
      return this.mapNode(this.requireNode(nodeId));
    });
  }

  applyChildStatus(
    parentSessionId: string,
    nodeId: string,
    input: Readonly<{
      status: Extract<SessionWorkflowNodeStatus, "running" | "decision_required" | "completed" | "failed" | "cancelled">;
      resultReference?: SessionWorkflowResultReference;
      decisionReason?: SessionWorkflowDecisionReason;
    }>,
    source: SessionWorkflowMutationSource = "host",
  ): SessionWorkflowNodeSummary {
    validateSource(source);
    return this.database.transaction(() => {
      const row = this.requireScopedNode(parentSessionId, nodeId);
      if (terminalNodeStatuses.has(row.status as SessionWorkflowNodeStatus)) return this.mapNode(row);
      if (!row.child_job_id) {
        throw new SessionWorkflowConflictError(`Workflow node ${nodeId} has no child`);
      }
      if (input.status === "running") {
        if (row.status === "running") return this.mapNode(row);
        throw new SessionWorkflowConflictError(`Workflow node ${nodeId} cannot return to running`);
      }
      if (!input.resultReference) {
        throw new SessionWorkflowValidationError("terminal child status requires a result reference");
      }
      if (input.status === "decision_required" && !input.decisionReason) {
        throw new SessionWorkflowValidationError("decision-required child status requires a reason");
      }
      const now = this.now();
      const terminal = input.status !== "decision_required";
      const changed = this.database.connection.prepare(`
        UPDATE session_workflow_nodes
        SET status = ?, revision = revision + 1, result_ref_json = ?,
            decision_reason = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND parent_session_id = ?
          AND status IN ('launching', 'running', 'decision_required') AND revision = ?
      `).run(
        input.status,
        JSON.stringify(input.resultReference),
        input.decisionReason ?? null,
        terminal ? now : null,
        now,
        nodeId,
        parentSessionId,
        row.revision,
      );
      if (Number(changed.changes) !== 1) return this.mapNode(this.requireNode(nodeId));
      this.touchWorkflow(row.workflow_id, now);
      this.appendEvent({
        workflowId: row.workflow_id,
        parentSessionId,
        type: "node_status_changed",
        source,
        nodeId,
        payload: { from: row.status, to: input.status, resultReference: input.resultReference },
        now,
      });
      return this.mapNode(this.requireNode(nodeId));
    });
  }

  failUnattachedLaunch(
    parentSessionId: string,
    nodeId: string,
    reason: string,
  ): SessionWorkflowNodeSummary {
    const row = this.requireScopedNode(parentSessionId, nodeId);
    if (row.child_job_id) {
      throw new SessionWorkflowConflictError(`Workflow node ${nodeId} already has a child`);
    }
    if (row.status !== "launching") return this.mapNode(row);
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE session_workflow_nodes
        SET status = 'failed', revision = revision + 1, result_ref_json = ?,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'launching' AND child_job_id IS NULL
      `).run(
        JSON.stringify({ kind: "workflow_decision", status: "failed", reason }),
        now,
        now,
        nodeId,
      );
      this.touchWorkflow(row.workflow_id, now);
      this.appendEvent({
        workflowId: row.workflow_id,
        parentSessionId,
        type: "node_status_changed",
        source: "host",
        nodeId,
        payload: { from: "launching", to: "failed", reason },
        now,
      });
    });
    return this.mapNode(this.requireNode(nodeId));
  }

  decideReplay(
    parentSessionId: string,
    workflowId: string,
    nodeKey: string,
    decision: SessionWorkflowReplayDecision,
    note: string,
    source: Extract<SessionWorkflowMutationSource, "http" | "host"> = "host",
  ): SessionWorkflowDetail {
    const decisionNote = boundedText(note, "note", maximumWorkflowTerminalNoteCharacters);
    if (!["retry", "skip", "cancel"].includes(decision)) {
      throw new SessionWorkflowValidationError("decision must be retry, skip, or cancel");
    }
    const workflow = this.requireWorkflow(parentSessionId, workflowId);
    if (terminalWorkflowStatuses.has(workflow.status as SessionWorkflowStatus)) {
      throw new SessionWorkflowConflictError(`Workflow ${workflowId} is terminal`);
    }
    const row = this.database.connection.prepare(`
      SELECT * FROM session_workflow_nodes
      WHERE workflow_id = ? AND parent_session_id = ? AND node_key = ?
    `).get(workflowId, parentSessionId, nodeKey) as unknown as WorkflowNodeRow | undefined;
    if (!row) throw new SessionWorkflowNotFoundError(`${workflowId}/${nodeKey}`);
    if (row.status !== "decision_required") {
      throw new SessionWorkflowConflictError(`Workflow node ${nodeKey} does not require a decision`);
    }
    if (decision === "retry" && Number(row.replay_count) >= maximumWorkflowReplayCount) {
      throw new SessionWorkflowConflictError(`Workflow node ${nodeKey} exhausted its replay limit`);
    }
    if (decision === "retry") {
      const active = Number((this.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM session_workflow_nodes
        WHERE workflow_id = ? AND status IN ('launching', 'running')
      `).get(workflowId) as { count: number }).count);
      if (active >= Number(workflow.max_concurrency)) {
        throw new SessionWorkflowConflictError(
          `Workflow ${workflowId} has no concurrency slot available for replay`,
        );
      }
    }
    const now = this.now();
    this.database.transaction(() => {
      if (decision === "retry") {
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'launching', revision = revision + 1,
              result_ref_json = NULL, decision_reason = NULL,
              replay_count = replay_count + 1, finished_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'decision_required'
        `).run(now, row.id);
        this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'blocked'
        `).run(now, workflowId);
      } else if (decision === "skip") {
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'skipped', revision = revision + 1,
              result_ref_json = ?, decision_reason = NULL,
              finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'decision_required'
        `).run(
          JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: decisionNote }),
          now,
          now,
          row.id,
        );
        this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'blocked'
        `).run(now, workflowId);
      } else {
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'skipped', revision = revision + 1,
              result_ref_json = ?, decision_reason = NULL,
              finished_at = ?, updated_at = ?
          WHERE workflow_id = ? AND status IN ('pending', 'decision_required')
        `).run(
          JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: decisionNote }),
          now,
          now,
          workflowId,
        );
        this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = 'cancelling', revision = revision + 1,
              cancellation_note = ?, updated_at = ?
          WHERE id = ? AND status IN ('running', 'blocked')
        `).run(decisionNote, now, workflowId);
      }
      this.appendEvent({
        workflowId,
        parentSessionId,
        type: "node_replay_decided",
        source,
        nodeId: row.id,
        payload: { nodeKey, decision, note: decisionNote },
        now,
      });
    });
    return this.requireDetail(parentSessionId, workflowId);
  }

  markDeadlineExceeded(parentSessionId: string, workflowId: string): SessionWorkflowDetail {
    const workflow = this.requireWorkflow(parentSessionId, workflowId);
    if (terminalWorkflowStatuses.has(workflow.status as SessionWorkflowStatus)) {
      return this.mapDetail(workflow, 20);
    }
    if (workflow.status === "planned" || workflow.status === "cancelling") {
      return this.mapDetail(workflow, 20);
    }
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE session_workflow_nodes
        SET status = 'skipped', revision = revision + 1, result_ref_json = ?,
            finished_at = ?, updated_at = ?
        WHERE workflow_id = ? AND status IN ('pending', 'decision_required')
      `).run(
        JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: "deadline_exceeded" }),
        now,
        now,
        workflowId,
      );
      this.database.connection.prepare(`
        UPDATE session_workflows
        SET status = 'cancelling', revision = revision + 1,
            cancellation_note = 'Workflow deadline exceeded', updated_at = ?
        WHERE id = ? AND status IN ('running', 'blocked')
      `).run(now, workflowId);
      this.appendEvent({
        workflowId,
        parentSessionId,
        type: "workflow_status_changed",
        source: "host",
        payload: { from: workflow.status, to: "cancelling", reason: "deadline_exceeded" },
        now,
      });
    });
    return this.requireDetail(parentSessionId, workflowId);
  }

  settle(parentSessionId: string, workflowId: string): SessionWorkflowDetail {
    const initial = this.requireWorkflow(parentSessionId, workflowId);
    if (terminalWorkflowStatuses.has(initial.status as SessionWorkflowStatus) ||
        initial.status === "planned") return this.mapDetail(initial, 20);
    return this.database.transaction(() => {
      let workflow = this.requireWorkflow(parentSessionId, workflowId);
      const nodes = this.nodeRows(workflowId);
      const active = nodes.some((node) => ["launching", "running"].includes(node.status));
      const decisions = nodes.some((node) => node.status === "decision_required");
      const failed = nodes.some((node) => ["failed", "cancelled"].includes(node.status));
      const unfinished = nodes.some((node) => !terminalNodeStatuses.has(node.status as SessionWorkflowNodeStatus));
      let nextStatus = workflow.status as SessionWorkflowStatus;
      let terminalNote: string | undefined;
      if (workflow.status === "cancelling") {
        if (!active) {
          nextStatus = "cancelled";
          terminalNote = workflow.cancellation_note ?? "Workflow cancelled";
        }
      } else if (decisions) {
        nextStatus = "blocked";
      } else if (failed && !active) {
        const now = this.now();
        this.database.connection.prepare(`
          UPDATE session_workflow_nodes
          SET status = 'skipped', revision = revision + 1, result_ref_json = ?,
              finished_at = ?, updated_at = ?
          WHERE workflow_id = ? AND status = 'pending'
        `).run(
          JSON.stringify({ kind: "workflow_decision", status: "skipped", reason: "dependency_failed" }),
          now,
          now,
          workflowId,
        );
        nextStatus = "failed";
        terminalNote = "A workflow node failed";
      } else if (!unfinished) {
        nextStatus = failed ? "failed" : "completed";
        terminalNote = failed ? "A workflow node failed" : "All workflow nodes settled";
      } else if (workflow.status === "blocked") {
        nextStatus = "running";
      }
      if (nextStatus !== workflow.status) {
        const now = this.now();
        const terminal = terminalWorkflowStatuses.has(nextStatus);
        const changed = this.database.connection.prepare(`
          UPDATE session_workflows
          SET status = ?, revision = revision + 1, cancellation_note = NULL, terminal_note = ?,
              finished_at = ?, updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND revision = ?
        `).run(
          nextStatus,
          terminal ? terminalNote! : null,
          terminal ? now : null,
          now,
          workflowId,
          parentSessionId,
          workflow.revision,
        );
        if (Number(changed.changes) === 1) {
          this.appendEvent({
            workflowId,
            parentSessionId,
            type: "workflow_status_changed",
            source: "host",
            payload: { from: workflow.status, to: nextStatus },
            now,
          });
          workflow = this.requireWorkflow(parentSessionId, workflowId);
        }
      }
      return this.mapDetail(workflow, 20);
    });
  }

  listRecoverable(limit = 100): readonly SessionWorkflowDetail[] {
    boundedInteger(limit, "limit", 1, 100);
    const rows = this.database.connection.prepare(`
      SELECT * FROM session_workflows
      WHERE status IN ('running', 'blocked', 'cancelling')
      ORDER BY updated_at ASC, id ASC LIMIT ?
    `).all(limit) as unknown as WorkflowRow[];
    return Object.freeze(rows.map((row) => this.mapDetail(row, 20)));
  }

  findNodeByChild(
    kind: SessionWorkflowNodeKind,
    childJobId: string,
  ): SessionWorkflowNodeSummary | undefined {
    validateId(childJobId, "childJobId");
    const row = kind === "shell"
      ? this.database.connection.prepare(`
          SELECT node.*
          FROM execution_jobs child
          JOIN session_workflow_nodes node
            ON node.kind = 'shell'
            AND node.parent_session_id = child.parent_session_id
            AND (
              node.child_job_id = child.id
              OR (child.admission_key IS NOT NULL AND node.admission_key = child.admission_key)
            )
          WHERE child.id = ?
          LIMIT 1
        `).get(childJobId) as unknown as WorkflowNodeRow | undefined
      : this.database.connection.prepare(`
          SELECT node.*
          FROM subagent_jobs child
          JOIN session_workflow_nodes node
            ON node.kind = 'subagent'
            AND node.parent_session_id = child.parent_session_id
            AND (
              node.child_job_id = child.id
              OR (child.admission_key IS NOT NULL AND node.admission_key = child.admission_key)
            )
          WHERE child.id = ?
          LIMIT 1
        `).get(childJobId) as unknown as WorkflowNodeRow | undefined;
    return row ? this.mapNode(row) : undefined;
  }

  findWorkflowForChild(
    kind: SessionWorkflowNodeKind,
    childJobId: string,
  ): SessionWorkflowSummary | undefined {
    const node = this.findNodeByChild(kind, childJobId);
    if (!node) return undefined;
    const row = this.findWorkflow(
      this.requireNode(node.id).parent_session_id,
      node.workflowId,
    );
    return row ? this.mapSummary(row) : undefined;
  }

  private mapSummary(row: WorkflowRow): SessionWorkflowSummary {
    const counts = emptyCounts();
    for (const node of this.nodeRows(row.id)) {
      counts.total += 1;
      if (node.status === "pending") counts.pending += 1;
      else if (node.status === "launching" || node.status === "running") counts.active += 1;
      else if (node.status === "decision_required") counts.decisionRequired += 1;
      else if (node.status === "completed") counts.completed += 1;
      else if (node.status === "failed") counts.failed += 1;
      else if (node.status === "cancelled") counts.cancelled += 1;
      else if (node.status === "skipped") counts.skipped += 1;
    }
    return Object.freeze({
      id: row.id,
      parentSessionId: row.parent_session_id,
      mode: row.mode as Mode,
      conversationSpace: row.conversation_space as ConversationSpace,
      ...(row.character_id ? { characterId: row.character_id } : {}),
      ...(row.secret_owner_character_id
        ? { secretOwnerCharacterId: row.secret_owner_character_id }
        : {}),
      title: row.title,
      status: row.status as SessionWorkflowStatus,
      revision: Number(row.revision),
      maxConcurrency: Number(row.max_concurrency),
      timeoutSeconds: Number(row.timeout_seconds),
      counts: Object.freeze(counts),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.deadline_at ? { deadlineAt: row.deadline_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      updatedAt: row.updated_at,
    });
  }

  private mapDetail(row: WorkflowRow, eventLimit: number): SessionWorkflowDetail {
    const nodes = this.nodeRows(row.id).map((node) => this.mapNode(node));
    const eventRows = eventLimit === 0 ? [] : this.database.connection.prepare(`
      SELECT id, sequence, event_type, source, node_id, created_at
      FROM session_workflow_events WHERE workflow_id = ?
      ORDER BY sequence DESC LIMIT ?
    `).all(row.id, eventLimit) as unknown as WorkflowEventRow[];
    const recentEvents = eventRows.reverse().map((event) => Object.freeze({
      id: event.id,
      sequence: Number(event.sequence),
      type: event.event_type as SessionWorkflowEvent["type"],
      source: event.source as SessionWorkflowMutationSource,
      ...(event.node_id ? { nodeId: event.node_id } : {}),
      createdAt: event.created_at,
    }));
    return Object.freeze({
      ...this.mapSummary(row),
      ...(row.terminal_note ? { terminalNote: row.terminal_note } : {}),
      nodes: Object.freeze(nodes),
      recentEvents: Object.freeze(recentEvents),
    });
  }

  private mapNode(row: WorkflowNodeRow): SessionWorkflowNodeSummary {
    return Object.freeze({
      id: row.id,
      workflowId: row.workflow_id,
      key: row.node_key,
      kind: row.kind as SessionWorkflowNodeKind,
      status: row.status as SessionWorkflowNodeStatus,
      revision: Number(row.revision),
      dependsOn: Object.freeze(this.dependencyKeys(row.id)),
      inputSha256: row.input_sha256,
      inputCharacters: Number(row.input_characters),
      grants: parseGrant(row.grants_json),
      timeoutSeconds: Number(row.timeout_seconds),
      ...(row.child_job_id ? { childJobId: row.child_job_id } : {}),
      ...(row.result_ref_json
        ? { resultReference: parseResultReference(row.result_ref_json) }
        : {}),
      ...(row.decision_reason
        ? { decisionReason: row.decision_reason as SessionWorkflowDecisionReason }
        : {}),
      replayCount: Number(row.replay_count),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      updatedAt: row.updated_at,
    });
  }

  private mapExecution(row: WorkflowNodeRow): SessionWorkflowNodeExecution {
    return Object.freeze({
      node: this.mapNode(row),
      admissionKey: row.admission_key,
      input: Object.freeze(JSON.parse(row.input_json) as SessionWorkflowNodeExecution["input"]),
    });
  }

  private findWorkflow(parentSessionId: string, workflowId: string): WorkflowRow | undefined {
    return this.database.connection.prepare(`
      SELECT * FROM session_workflows WHERE id = ? AND parent_session_id = ?
    `).get(workflowId, parentSessionId) as unknown as WorkflowRow | undefined;
  }

  private requireWorkflow(parentSessionId: string, workflowId: string): WorkflowRow {
    validateId(parentSessionId, "parentSessionId");
    validateId(workflowId, "workflowId");
    const row = this.findWorkflow(parentSessionId, workflowId);
    if (!row) throw new SessionWorkflowNotFoundError(workflowId);
    return row;
  }

  private requireDetail(parentSessionId: string, workflowId: string): SessionWorkflowDetail {
    return this.mapDetail(this.requireWorkflow(parentSessionId, workflowId), 20);
  }

  private requireNode(nodeId: string): WorkflowNodeRow {
    const row = this.database.connection.prepare(`
      SELECT * FROM session_workflow_nodes WHERE id = ?
    `).get(nodeId) as unknown as WorkflowNodeRow | undefined;
    if (!row) throw new SessionWorkflowNotFoundError(nodeId);
    return row;
  }

  private requireScopedNode(parentSessionId: string, nodeId: string): WorkflowNodeRow {
    validateId(parentSessionId, "parentSessionId");
    validateId(nodeId, "nodeId");
    const row = this.database.connection.prepare(`
      SELECT * FROM session_workflow_nodes WHERE id = ? AND parent_session_id = ?
    `).get(nodeId, parentSessionId) as unknown as WorkflowNodeRow | undefined;
    if (!row) throw new SessionWorkflowNotFoundError(nodeId);
    return row;
  }

  private nodeRows(workflowId: string): WorkflowNodeRow[] {
    return this.database.connection.prepare(`
      SELECT * FROM session_workflow_nodes WHERE workflow_id = ? ORDER BY node_key ASC
    `).all(workflowId) as unknown as WorkflowNodeRow[];
  }

  private dependencyKeys(nodeId: string): string[] {
    return (this.database.connection.prepare(`
      SELECT prerequisite.node_key
      FROM session_workflow_dependencies dependency
      JOIN session_workflow_nodes prerequisite
        ON prerequisite.id = dependency.depends_on_node_id
      WHERE dependency.node_id = ? ORDER BY prerequisite.node_key ASC
    `).all(nodeId) as Array<{ node_key: string }>).map((row) => row.node_key);
  }

  private touchWorkflow(workflowId: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE session_workflows SET revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(now, workflowId);
  }

  private appendEvent(input: Readonly<{
    workflowId: string;
    parentSessionId: string;
    type: SessionWorkflowEvent["type"];
    source: SessionWorkflowMutationSource;
    nodeId?: string;
    payload: Readonly<Record<string, unknown>>;
    now: string;
  }>): void {
    const sequence = Number((this.database.connection.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM session_workflow_events WHERE workflow_id = ?
    `).get(input.workflowId) as { sequence: number }).sequence);
    this.database.connection.prepare(`
      INSERT INTO session_workflow_events(
        id, workflow_id, parent_session_id, sequence, event_type, source,
        node_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idGenerator.next("workflow-event"),
      input.workflowId,
      input.parentSessionId,
      sequence,
      input.type,
      input.source,
      input.nodeId ?? null,
      JSON.stringify(input.payload),
      input.now,
    );
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function normalizeNodes(
  input: readonly SessionWorkflowNodeInput[],
  ceiling: SessionWorkflowGrantCeiling,
  workflowTimeoutSeconds: number,
): readonly NormalizedNode[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > maximumWorkflowNodes) {
    throw new SessionWorkflowValidationError(
      `nodes must contain between 1 and ${maximumWorkflowNodes} entries`,
    );
  }
  const keys = new Set<string>();
  const normalized = input.map((node): NormalizedNode => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new SessionWorkflowValidationError("each workflow node must be an object");
    }
    const key = boundedText(node.key, "node key", maximumWorkflowNodeKeyCharacters);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key)) {
      throw new SessionWorkflowValidationError(
        "node key must start with an alphanumeric character and contain only letters, digits, dot, underscore, or dash",
      );
    }
    if (keys.has(key)) throw new SessionWorkflowValidationError(`duplicate node key: ${key}`);
    keys.add(key);
    const dependsOn = normalizeStringList(
      node.dependsOn ?? [],
      "dependsOn",
      maximumWorkflowDependenciesPerNode,
      maximumWorkflowNodeKeyCharacters,
    );
    const timeoutSeconds = boundedInteger(
      node.timeoutSeconds ?? Math.min(1_800, workflowTimeoutSeconds),
      "node timeoutSeconds",
      1,
      Math.min(maximumWorkflowNodeTimeoutSeconds, workflowTimeoutSeconds),
    );
    let privateInput: SessionWorkflowNodeExecution["input"];
    let grants: SessionWorkflowNodeGrant;
    if (node.kind === "subagent") {
      if (!ceiling.subagent.available) {
        throw new SessionWorkflowValidationError(`Subagent execution is unavailable for node ${key}`);
      }
      if (!["worker", "researcher", "planner", "reviewer"].includes(node.role)) {
        throw new SessionWorkflowValidationError(`invalid Subagent role for node ${key}`);
      }
      const task = boundedText(node.task, `task for ${key}`, maximumWorkflowTaskCharacters);
      const context = node.context === undefined
        ? undefined
        : boundedText(node.context, `context for ${key}`, maximumWorkflowContextCharacters, true);
      const requestedWorkspace = node.workspaceAccess ?? ceiling.subagent.workspaceAccess;
      if (requestedWorkspace === "read_only" && ceiling.subagent.workspaceAccess === "off") {
        throw new SessionWorkflowValidationError(`node ${key} requests unavailable Workspace access`);
      }
      const moduleIds = normalizeRequestedSubset(
        node.moduleIds ?? [], ceiling.subagent.moduleIds, `moduleIds for ${key}`, 32, 128,
      );
      const skillNames = normalizeRequestedSubset(
        node.skillNames ?? [], ceiling.subagent.skillNames, `skillNames for ${key}`, 64, 200,
      );
      privateInput = Object.freeze({
        role: node.role,
        task,
        ...(context === undefined ? {} : { context }),
      });
      grants = Object.freeze({
        kind: "subagent" as const,
        workspaceAccess: requestedWorkspace,
        moduleIds,
        skillNames,
      });
    } else if (node.kind === "shell") {
      if (!ceiling.shell.available) {
        throw new SessionWorkflowValidationError(`shell execution is unavailable for node ${key}`);
      }
      const command = boundedText(
        node.command,
        `command for ${key}`,
        maximumWorkflowCommandCharacters,
      );
      const requestedWorkspace = node.workspaceAccess ?? "off";
      if (workspaceRank(requestedWorkspace) > workspaceRank(ceiling.shell.workspaceAccess)) {
        throw new SessionWorkflowValidationError(`node ${key} requests unavailable Workspace access`);
      }
      const networkEnabled = node.networkEnabled ?? false;
      if (networkEnabled && !ceiling.shell.networkEnabled) {
        throw new SessionWorkflowValidationError(`node ${key} requests unavailable network access`);
      }
      privateInput = Object.freeze({ command });
      grants = Object.freeze({
        kind: "shell" as const,
        workspaceAccess: requestedWorkspace,
        networkEnabled,
      });
    } else {
      throw new SessionWorkflowValidationError(`invalid kind for node ${key}`);
    }
    const inputJson = JSON.stringify(privateInput);
    const inputBytes = Buffer.byteLength(inputJson, "utf8");
    if (inputBytes > maximumWorkflowPrivateInputBytes) {
      throw new SessionWorkflowValidationError(`private input for node ${key} is too large`);
    }
    return Object.freeze({
      key,
      kind: node.kind,
      dependsOn,
      inputJson,
      inputSha256: createHash("sha256").update(inputJson).digest("hex"),
      inputCharacters: [...inputJson].length,
      grants,
      timeoutSeconds,
    });
  });
  const totalBytes = normalized.reduce((total, node) =>
    total + Buffer.byteLength(node.inputJson, "utf8"), 0);
  if (totalBytes > maximumWorkflowTotalPrivateInputBytes) {
    throw new SessionWorkflowValidationError(
      `workflow private inputs must total at most ${maximumWorkflowTotalPrivateInputBytes} bytes`,
    );
  }
  for (const node of normalized) {
    for (const dependency of node.dependsOn) {
      if (!keys.has(dependency)) {
        throw new SessionWorkflowValidationError(
          `node ${node.key} depends on unknown node ${dependency}`,
        );
      }
      if (dependency === node.key) {
        throw new SessionWorkflowValidationError(`node ${node.key} cannot depend on itself`);
      }
    }
  }
  assertAcyclic(normalized);
  return Object.freeze(normalized);
}

function assertAcyclic(nodes: readonly NormalizedNode[]): void {
  const dependencies = new Map(nodes.map((node) => [node.key, node.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new SessionWorkflowValidationError(`workflow dependency cycle includes ${key}`);
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const node of nodes) visit(node.key);
}

function validateScope(scope: SessionWorkflowScope): void {
  validateId(scope.parentSessionId, "parentSessionId");
  if (scope.mode !== "sms" && scope.mode !== "rp") {
    throw new SessionWorkflowValidationError("mode must be sms or rp");
  }
  if (scope.conversationSpace !== "normal" && scope.conversationSpace !== "secret") {
    throw new SessionWorkflowValidationError("conversationSpace must be normal or secret");
  }
  if (scope.conversationSpace === "secret") {
    if (scope.mode !== "sms" || !scope.characterId ||
        scope.secretOwnerCharacterId !== scope.characterId) {
      throw new SessionWorkflowValidationError("secret workflow scope must match its SMS character");
    }
  } else if (scope.secretOwnerCharacterId !== undefined) {
    throw new SessionWorkflowValidationError("normal workflows cannot declare a secret owner");
  }
}

function validateGrantCeiling(ceiling: SessionWorkflowGrantCeiling): void {
  if (!ceiling || typeof ceiling !== "object") {
    throw new SessionWorkflowValidationError("workflow grant ceiling is required");
  }
  if (!["off", "read_only"].includes(ceiling.subagent.workspaceAccess)) {
    throw new SessionWorkflowValidationError("Subagent Workspace grant ceiling is invalid");
  }
  if (!["off", "read_only", "read_write"].includes(ceiling.shell.workspaceAccess)) {
    throw new SessionWorkflowValidationError("shell Workspace grant ceiling is invalid");
  }
  if (typeof ceiling.subagent.available !== "boolean" ||
      typeof ceiling.shell.available !== "boolean") {
    throw new SessionWorkflowValidationError("workflow capability availability is invalid");
  }
}

function normalizeRequestedSubset(
  requested: readonly string[],
  available: readonly string[],
  label: string,
  maximumItems: number,
  maximumCharacters: number,
): readonly string[] {
  const values = normalizeStringList(requested, label, maximumItems, maximumCharacters);
  const allowed = new Set(available);
  const unavailable = values.find((value) => !allowed.has(value));
  if (unavailable) {
    throw new SessionWorkflowValidationError(`${label} contains unavailable value ${unavailable}`);
  }
  return Object.freeze(values);
}

function normalizeStringList(
  value: readonly string[],
  label: string,
  maximumItems: number,
  maximumCharacters: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new SessionWorkflowValidationError(`${label} must contain at most ${maximumItems} entries`);
  }
  const normalized = value.map((entry) => boundedText(entry, label, maximumCharacters));
  if (new Set(normalized).size !== normalized.length) {
    throw new SessionWorkflowValidationError(`${label} must not contain duplicates`);
  }
  return Object.freeze(normalized);
}

function boundedText(
  value: unknown,
  label: string,
  maximumCharacters: number,
  allowWhitespace = false,
): string {
  if (typeof value !== "string" || (!allowWhitespace && !value.trim()) ||
      value !== value.trim() || [...value].length > maximumCharacters) {
    throw new SessionWorkflowValidationError(
      `${label} must contain 1-${maximumCharacters} trimmed characters`,
    );
  }
  if (allowWhitespace && value.length === 0) return value;
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new SessionWorkflowValidationError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function validateId(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      [...value].length > 256) {
    throw new SessionWorkflowValidationError(
      `${label} must contain 1-256 trimmed characters`,
    );
  }
}

function validateSource(source: SessionWorkflowMutationSource): void {
  if (!["agent", "http", "host", "recovery"].includes(source)) {
    throw new SessionWorkflowValidationError("workflow mutation source is invalid");
  }
}

function workspaceRank(value: WorkspaceAccess): number {
  return value === "off" ? 0 : value === "read_only" ? 1 : 2;
}

function workflowAdmissionKey(workflowId: string, nodeKey: string): string {
  return `workflow-node:${createHash("sha256").update(`${workflowId}\0${nodeKey}`).digest("hex")}`;
}

function parseGrant(value: string): SessionWorkflowNodeGrant {
  const parsed = JSON.parse(value) as SessionWorkflowNodeGrant;
  if (parsed.kind === "subagent") {
    return Object.freeze({
      ...parsed,
      moduleIds: Object.freeze([...parsed.moduleIds]),
      skillNames: Object.freeze([...parsed.skillNames]),
    });
  }
  return Object.freeze({ ...parsed });
}

function parseResultReference(value: string): SessionWorkflowResultReference {
  return Object.freeze(JSON.parse(value) as SessionWorkflowResultReference);
}

function emptyCounts(): {
  pending: number;
  active: number;
  decisionRequired: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  total: number;
} {
  return {
    pending: 0,
    active: 0,
    decisionRequired: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    total: 0,
  };
}

function revisionConflict(workflow: WorkflowRow): SessionWorkflowConflictError {
  return new SessionWorkflowConflictError(
    `Workflow ${workflow.id} revision changed; current revision is ${workflow.revision}`,
  );
}

/** Construct the exact frozen child grant consumed by PiSessionRuntime. */
export function subagentGrantSnapshot(
  grant: Extract<SessionWorkflowNodeGrant, { kind: "subagent" }>,
): SubagentJobGrantSnapshot {
  return Object.freeze({
    workspaceAccess: grant.workspaceAccess,
    moduleIds: Object.freeze([...grant.moduleIds]),
    skillNames: Object.freeze([...grant.skillNames]),
    toolNames: Object.freeze([]),
  });
}
