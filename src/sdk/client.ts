import {
  YourCharAbortError,
  YourCharApiError,
  YourCharAuthenticationError,
  YourCharConflictError,
  YourCharNotFoundError,
  YourCharProtocolError,
  YourCharTransportError,
  YourCharValidationError,
} from "./errors.js";
import { parseSessionEventStream } from "./sse.js";
import type {
  AgentMessage,
  AgentPermissions,
  AgentPermissionsPatch,
  CreateSessionGoalInput,
  CreateSessionWorkflowInput,
  DirectConversationSession,
  ExecutionJobDetail,
  ExecutionJobSummary,
  ExecutionOutputPage,
  ExecutionOutputQuery,
  GoalDependenciesRequest,
  GoalDetailOptions,
  GoalListOptions,
  GoalTodoCreateRequest,
  GoalTodoTransitionRequest,
  GoalTodoUpdateRequest,
  GoalTransitionRequest,
  JsonRecord,
  MessageHistoryPage,
  MessageHistoryQuery,
  MessageRequest,
  SessionListOptions,
  SessionMessageResponse,
  SessionScopeQuery,
  SessionStreamEvent,
  SessionSummary,
  StartExecutionJobRequest,
  StartSubagentJobRequest,
  SubagentFollowupRequest,
  SubagentJobDetail,
  SubagentJobSummary,
  UpdateSessionGoalInput,
  WorkflowActionRequest,
  WorkflowDecisionRequest,
  WorkflowDetailOptions,
  WorkflowListOptions,
  WorkspaceFileEntry,
  WorkspaceFileList,
  WorkspaceFilePreview,
  WorkspaceFileQuery,
  WorkspaceMutationOptions,
  WorkspaceUploadRequest,
  YourCharClientOptions,
  YourCharFetch,
  YourCharRequestOptions,
  SessionGoalDetail,
  SessionGoalSummary,
  SessionWorkflowDetail,
  SessionWorkflowSummary,
} from "./types.js";

const apiRoot = "/api/headless/v1";
const apiVersion = "1";

type JsonMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type QueryValue = string | number | boolean | undefined;

type InternalRequestOptions = YourCharRequestOptions & Readonly<{
  method?: JsonMethod;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  accept?: string;
}>;

export class YourCharClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: YourCharFetch;

  constructor(options: YourCharClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = requiredToken(options.token);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async health(signal?: AbortSignal): Promise<Readonly<{ status: "ok" }>> {
    return this.request("GET", "/health", { signal });
  }

  /** Low-level, version-checked JSON access for v1 routes not yet wrapped below. */
  async request<T>(
    method: JsonMethod,
    path: string,
    options: Omit<InternalRequestOptions, "method" | "rawBody" | "contentType" | "accept"> = {},
  ): Promise<T> {
    const response = await this.#response(path, { ...options, method, accept: "application/json" });
    return readJsonResponse<T>(response);
  }

  async listSessions(options: SessionListOptions = {}): Promise<SessionSummary[]> {
    const payload = await this.request<{ sessions: SessionSummary[] }>("GET", "/sessions", {
      signal: options.signal,
      query: {
        includeArchived: options.includeArchived ? 1 : undefined,
        conversationSpace: options.conversationSpace,
        characterId: options.characterId,
      },
    });
    return payload.sessions;
  }

  async openDirectConversation(
    characterId: string,
    conversationSpace: "normal" | "secret" = "normal",
    options: YourCharRequestOptions = {},
  ): Promise<DirectConversationSession> {
    const payload = await this.request<{ session: DirectConversationSession }>(
      "POST",
      "/direct-conversations",
      { ...options, body: { characterId, conversationSpace } },
    );
    return payload.session;
  }

  async listMessages(
    sessionId: string,
    options: SessionScopeQuery & Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<AgentMessage[]> {
    return this.request("GET", `${sessionPath(sessionId)}/messages`, {
      signal: options.signal,
      query: scopeQuery(options),
    });
  }

  async getMessageHistory(
    sessionId: string,
    options: MessageHistoryQuery = {},
  ): Promise<MessageHistoryPage> {
    return this.request("GET", `${sessionPath(sessionId)}/messages`, {
      signal: options.signal,
      query: {
        ...scopeQuery(options),
        paged: 1,
        limit: options.limit,
        before: options.before,
        after: options.after,
        around: options.around,
      },
    });
  }

  async *iterateMessageHistory(
    sessionId: string,
    options: Omit<MessageHistoryQuery, "after" | "around"> = {},
  ): AsyncGenerator<MessageHistoryPage, void, void> {
    let before = options.before;
    for (;;) {
      const page = await this.getMessageHistory(sessionId, { ...options, before });
      yield page;
      if (!page.page.hasEarlier || !page.page.first) return;
      if (page.page.first === before) {
        throw new YourCharProtocolError("message-history cursor did not advance");
      }
      before = page.page.first;
    }
  }

  async sendMessage(
    sessionId: string,
    message: MessageRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionMessageResponse> {
    return this.request("POST", `${sessionPath(sessionId)}/messages`, {
      ...options,
      body: message,
    });
  }

  async *streamMessage(
    sessionId: string,
    message: MessageRequest,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): AsyncGenerator<SessionStreamEvent, void, void> {
    const response = await this.#response(`${sessionPath(sessionId)}/messages/stream`, {
      method: "POST",
      body: message,
      signal: options.signal,
      accept: "text/event-stream",
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/event-stream") || !response.body) {
      throw new YourCharProtocolError("headless stream response is not an event stream");
    }
    yield* parseSessionEventStream(response.body, options.signal);
  }

  async cancelMessage(
    sessionId: string,
    options: YourCharRequestOptions = {},
  ): Promise<boolean> {
    const payload = await this.request<{ cancelled: boolean }>(
      "POST",
      `${sessionPath(sessionId)}/messages/cancel`,
      { ...options, body: {} },
    );
    return payload.cancelled;
  }

  async retryMessage(
    sessionId: string,
    options: YourCharRequestOptions = {},
  ): Promise<SessionMessageResponse> {
    return this.request("POST", `${sessionPath(sessionId)}/messages/retry`, {
      ...options,
      body: {},
    });
  }

  async archiveSession(sessionId: string, options: YourCharRequestOptions = {}): Promise<JsonRecord> {
    return this.request("POST", `${sessionPath(sessionId)}/archive`, { ...options, body: {} });
  }

  async restoreSession(sessionId: string, options: YourCharRequestOptions = {}): Promise<JsonRecord> {
    return this.request("POST", `${sessionPath(sessionId)}/restore`, { ...options, body: {} });
  }

  async renameSession(
    sessionId: string,
    title: string,
    scope: SessionScopeQuery = {},
    options: YourCharRequestOptions = {},
  ): Promise<JsonRecord> {
    return this.request("PATCH", sessionPath(sessionId), {
      ...options,
      body: { title, ...scope },
    });
  }

  async deleteSession(
    sessionId: string,
    confirmation: string,
    scope: SessionScopeQuery = {},
    options: YourCharRequestOptions = {},
  ): Promise<JsonRecord> {
    return this.request("DELETE", sessionPath(sessionId), {
      ...options,
      body: { confirmation, ...scope },
    });
  }

  async listExecutionJobs(
    sessionId: string,
    options: Readonly<{ limit?: number; signal?: AbortSignal }> = {},
  ): Promise<ExecutionJobSummary[]> {
    const payload = await this.request<{ jobs: ExecutionJobSummary[] }>(
      "GET",
      `${sessionPath(sessionId)}/execution-jobs`,
      { signal: options.signal, query: { limit: options.limit } },
    );
    return payload.jobs;
  }

  async getExecutionJob(
    sessionId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionJobDetail> {
    const payload = await this.request<{ job: ExecutionJobDetail }>(
      "GET",
      `${sessionPath(sessionId)}/execution-jobs/${segment(jobId)}`,
      { signal },
    );
    return payload.job;
  }

  async startExecutionJob(
    sessionId: string,
    input: StartExecutionJobRequest,
    options: YourCharRequestOptions = {},
  ): Promise<ExecutionJobSummary> {
    const payload = await this.request<{ job: ExecutionJobSummary }>(
      "POST",
      `${sessionPath(sessionId)}/execution-jobs`,
      { ...options, body: input },
    );
    return payload.job;
  }

  async interruptExecutionJob(
    sessionId: string,
    jobId: string,
    options: YourCharRequestOptions = {},
  ): Promise<ExecutionJobSummary> {
    return this.executionJobAction(sessionId, jobId, "interrupt", options);
  }

  async retryExecutionJob(
    sessionId: string,
    jobId: string,
    options: YourCharRequestOptions = {},
  ): Promise<ExecutionJobSummary> {
    return this.executionJobAction(sessionId, jobId, "retry", options);
  }

  async getExecutionOutput(
    sessionId: string,
    jobId: string,
    options: ExecutionOutputQuery = {},
  ): Promise<ExecutionOutputPage> {
    const payload = await this.request<{ output: ExecutionOutputPage }>(
      "GET",
      `${sessionPath(sessionId)}/execution-jobs/${segment(jobId)}/output`,
      {
        signal: options.signal,
        query: {
          attempt: options.attempt,
          cursor: options.cursor,
          limitBytes: options.limitBytes,
        },
      },
    );
    return payload.output;
  }

  async *iterateExecutionOutput(
    sessionId: string,
    jobId: string,
    options: ExecutionOutputQuery = {},
  ): AsyncGenerator<ExecutionOutputPage, void, void> {
    let cursor = options.cursor ?? 0;
    for (;;) {
      const page = await this.getExecutionOutput(sessionId, jobId, { ...options, cursor });
      yield page;
      if (page.eof) return;
      if (page.nextCursor <= cursor) {
        throw new YourCharProtocolError("execution-output cursor did not advance");
      }
      cursor = page.nextCursor;
    }
  }

  async listSubagentJobs(
    sessionId: string,
    options: Readonly<{ limit?: number; signal?: AbortSignal }> = {},
  ): Promise<SubagentJobSummary[]> {
    const payload = await this.request<{ jobs: SubagentJobSummary[] }>(
      "GET",
      `${sessionPath(sessionId)}/subagent-jobs`,
      { signal: options.signal, query: { limit: options.limit } },
    );
    return payload.jobs;
  }

  async getSubagentJob(
    sessionId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<SubagentJobDetail> {
    const payload = await this.request<{ job: SubagentJobDetail }>(
      "GET",
      `${sessionPath(sessionId)}/subagent-jobs/${segment(jobId)}`,
      { signal },
    );
    return payload.job;
  }

  async startSubagentJob(
    sessionId: string,
    input: StartSubagentJobRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SubagentJobSummary> {
    const payload = await this.request<{ job: SubagentJobSummary }>(
      "POST",
      `${sessionPath(sessionId)}/subagent-jobs`,
      { ...options, body: input },
    );
    return payload.job;
  }

  async sendSubagentMessage(
    sessionId: string,
    jobId: string,
    input: SubagentFollowupRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SubagentJobSummary> {
    const payload = await this.request<{ job: SubagentJobSummary }>(
      "POST",
      `${sessionPath(sessionId)}/subagent-jobs/${segment(jobId)}/messages`,
      { ...options, body: input },
    );
    return payload.job;
  }

  async interruptSubagentJob(
    sessionId: string,
    jobId: string,
    options: YourCharRequestOptions = {},
  ): Promise<SubagentJobSummary> {
    return this.subagentJobAction(sessionId, jobId, "interrupt", options);
  }

  async retrySubagentJob(
    sessionId: string,
    jobId: string,
    options: YourCharRequestOptions = {},
  ): Promise<SubagentJobSummary> {
    return this.subagentJobAction(sessionId, jobId, "retry", options);
  }

  async listGoals(sessionId: string, options: GoalListOptions = {}): Promise<SessionGoalSummary[]> {
    const payload = await this.request<{ goals: SessionGoalSummary[] }>(
      "GET",
      `${sessionPath(sessionId)}/goals`,
      {
        signal: options.signal,
        query: { limit: options.limit, includeTerminal: options.includeTerminal },
      },
    );
    return payload.goals;
  }

  async getGoal(
    sessionId: string,
    goalId: string,
    options: GoalDetailOptions = {},
  ): Promise<SessionGoalDetail> {
    const payload = await this.request<{ goal: SessionGoalDetail }>(
      "GET",
      `${sessionPath(sessionId)}/goals/${segment(goalId)}`,
      { signal: options.signal, query: { transitionLimit: options.transitionLimit } },
    );
    return payload.goal;
  }

  async createGoal(
    sessionId: string,
    input: CreateSessionGoalInput,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation("POST", `${sessionPath(sessionId)}/goals`, input, options);
  }

  async updateGoal(
    sessionId: string,
    goalId: string,
    input: UpdateSessionGoalInput,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation("PATCH", `${sessionPath(sessionId)}/goals/${segment(goalId)}`, input, options);
  }

  async transitionGoal(
    sessionId: string,
    goalId: string,
    input: GoalTransitionRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation("POST", `${sessionPath(sessionId)}/goals/${segment(goalId)}/transition`, input, options);
  }

  async setGoalDependencies(
    sessionId: string,
    goalId: string,
    input: GoalDependenciesRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation("PATCH", `${sessionPath(sessionId)}/goals/${segment(goalId)}/dependencies`, input, options);
  }

  async createGoalTodo(
    sessionId: string,
    goalId: string,
    input: GoalTodoCreateRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation("POST", `${sessionPath(sessionId)}/goals/${segment(goalId)}/todos`, input, options);
  }

  async updateGoalTodo(
    sessionId: string,
    goalId: string,
    todoId: string,
    input: GoalTodoUpdateRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation(
      "PATCH",
      `${sessionPath(sessionId)}/goals/${segment(goalId)}/todos/${segment(todoId)}`,
      input,
      options,
    );
  }

  async transitionGoalTodo(
    sessionId: string,
    goalId: string,
    todoId: string,
    input: GoalTodoTransitionRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionGoalDetail> {
    return this.goalMutation(
      "POST",
      `${sessionPath(sessionId)}/goals/${segment(goalId)}/todos/${segment(todoId)}/transition`,
      input,
      options,
    );
  }

  async listWorkflows(
    sessionId: string,
    options: WorkflowListOptions = {},
  ): Promise<SessionWorkflowSummary[]> {
    const payload = await this.request<{ workflows: SessionWorkflowSummary[] }>(
      "GET",
      `${sessionPath(sessionId)}/workflows`,
      {
        signal: options.signal,
        query: { limit: options.limit, includeTerminal: options.includeTerminal },
      },
    );
    return payload.workflows;
  }

  async getWorkflow(
    sessionId: string,
    workflowId: string,
    options: WorkflowDetailOptions = {},
  ): Promise<SessionWorkflowDetail> {
    const payload = await this.request<{ workflow: SessionWorkflowDetail }>(
      "GET",
      `${sessionPath(sessionId)}/workflows/${segment(workflowId)}`,
      { signal: options.signal, query: { eventLimit: options.eventLimit } },
    );
    return payload.workflow;
  }

  async createWorkflow(
    sessionId: string,
    input: CreateSessionWorkflowInput,
    options: YourCharRequestOptions = {},
  ): Promise<SessionWorkflowDetail> {
    return this.workflowMutation("POST", `${sessionPath(sessionId)}/workflows`, input, options);
  }

  async startWorkflow(
    sessionId: string,
    workflowId: string,
    input: WorkflowActionRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionWorkflowDetail> {
    return this.workflowMutation(
      "POST",
      `${sessionPath(sessionId)}/workflows/${segment(workflowId)}/start`,
      { expectedRevision: input.expectedRevision },
      options,
    );
  }

  async cancelWorkflow(
    sessionId: string,
    workflowId: string,
    input: WorkflowActionRequest & Readonly<{ note: string }>,
    options: YourCharRequestOptions = {},
  ): Promise<SessionWorkflowDetail> {
    return this.workflowMutation(
      "POST",
      `${sessionPath(sessionId)}/workflows/${segment(workflowId)}/cancel`,
      input,
      options,
    );
  }

  async decideWorkflowNode(
    sessionId: string,
    workflowId: string,
    nodeKey: string,
    input: WorkflowDecisionRequest,
    options: YourCharRequestOptions = {},
  ): Promise<SessionWorkflowDetail> {
    return this.workflowMutation(
      "POST",
      `${sessionPath(sessionId)}/workflows/${segment(workflowId)}/nodes/${segment(nodeKey)}/decision`,
      input,
      options,
    );
  }

  async getAgentPermissions(signal?: AbortSignal): Promise<AgentPermissions> {
    const payload = await this.request<{ permissions: AgentPermissions }>(
      "GET",
      "/agent-permissions",
      { signal },
    );
    return payload.permissions;
  }

  async patchAgentPermissions(
    patch: AgentPermissionsPatch,
    options: YourCharRequestOptions = {},
  ): Promise<AgentPermissions> {
    const payload = await this.request<{ permissions: AgentPermissions }>(
      "PATCH",
      "/agent-permissions",
      { ...options, body: patch },
    );
    return payload.permissions;
  }

  async listWorkspaceFiles(options: WorkspaceFileQuery = {}): Promise<WorkspaceFileList> {
    return this.request("GET", workspacePath(options.sessionId, "/files"), {
      signal: options.signal,
      query: { ...workspaceScopeQuery(options), path: options.path },
    });
  }

  async previewWorkspaceFile(
    path: string,
    options: WorkspaceFileQuery = {},
  ): Promise<WorkspaceFilePreview> {
    const payload = await this.request<{ preview: WorkspaceFilePreview }>(
      "GET",
      workspacePath(options.sessionId, "/files/preview"),
      {
        signal: options.signal,
        query: { ...workspaceScopeQuery(options), path },
      },
    );
    return payload.preview;
  }

  async uploadWorkspaceFile(input: WorkspaceUploadRequest): Promise<WorkspaceFileEntry> {
    const response = await this.#response(workspacePath(input.sessionId, "/files/upload"), {
      method: "POST",
      query: {
        ...workspaceScopeQuery(input),
        name: input.name,
        directory: input.directory,
      },
      rawBody: input.bytes,
      contentType: input.contentType ?? "application/octet-stream",
      accept: "application/json",
      signal: input.signal,
    });
    return (await readJsonResponse<{ entry: WorkspaceFileEntry }>(response)).entry;
  }

  async moveWorkspaceFile(
    from: string,
    to: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceFileEntry> {
    const payload = await this.request<{ entry: WorkspaceFileEntry }>(
      "PATCH",
      workspacePath(options.sessionId, "/files"),
      {
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
        query: workspaceScopeQuery(options),
        body: { from, to },
      },
    );
    return payload.entry;
  }

  async deleteWorkspaceFile(
    path: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<Readonly<{ path: string; bytes: number }>> {
    const payload = await this.request<{ deleted: { path: string; bytes: number } }>(
      "DELETE",
      workspacePath(options.sessionId, "/files"),
      {
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
        query: workspaceScopeQuery(options),
        body: { path },
      },
    );
    return payload.deleted;
  }

  async downloadWorkspaceFile(
    path: string,
    options: WorkspaceFileQuery = {},
  ): Promise<Readonly<{ bytes: Uint8Array; contentType: string; disposition: string | null }>> {
    const response = await this.#response(workspacePath(options.sessionId, "/files/content"), {
      method: "GET",
      signal: options.signal,
      query: { ...workspaceScopeQuery(options), path },
    });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      disposition: response.headers.get("content-disposition"),
    };
  }

  private async executionJobAction(
    sessionId: string,
    jobId: string,
    action: "interrupt" | "retry",
    options: YourCharRequestOptions,
  ): Promise<ExecutionJobSummary> {
    const payload = await this.request<{ job: ExecutionJobSummary }>(
      "POST",
      `${sessionPath(sessionId)}/execution-jobs/${segment(jobId)}/${action}`,
      { ...options, body: {} },
    );
    return payload.job;
  }

  private async subagentJobAction(
    sessionId: string,
    jobId: string,
    action: "interrupt" | "retry",
    options: YourCharRequestOptions,
  ): Promise<SubagentJobSummary> {
    const payload = await this.request<{ job: SubagentJobSummary }>(
      "POST",
      `${sessionPath(sessionId)}/subagent-jobs/${segment(jobId)}/${action}`,
      { ...options, body: {} },
    );
    return payload.job;
  }

  private async goalMutation(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    options: YourCharRequestOptions,
  ): Promise<SessionGoalDetail> {
    const payload = await this.request<{ goal: SessionGoalDetail }>(method, path, {
      ...options,
      body,
    });
    return payload.goal;
  }

  private async workflowMutation(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    options: YourCharRequestOptions,
  ): Promise<SessionWorkflowDetail> {
    const payload = await this.request<{ workflow: SessionWorkflowDetail }>(method, path, {
      ...options,
      body,
    });
    return payload.workflow;
  }

  async #response(path: string, options: InternalRequestOptions): Promise<Response> {
    const method = options.method ?? "GET";
    const url = requestUrl(this.baseUrl, path, options.query);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${this.#token}`);
    if (options.accept) headers.set("accept", options.accept);
    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers.set("content-type", options.contentType ?? "application/octet-stream");
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    if (options.idempotencyKey !== undefined) {
      if (method === "GET" || body === undefined || options.rawBody !== undefined) {
        throw new YourCharValidationError(
          "idempotencyKey requires a JSON mutation",
          0,
          "SDK_IDEMPOTENCY_UNSUPPORTED",
        );
      }
      headers.set("idempotency-key", options.idempotencyKey);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: options.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new YourCharAbortError({ cause: error });
      }
      throw new YourCharTransportError("failed to reach the YourChar headless API", { cause: error });
    }

    const version = response.headers.get("x-yourchar-api-version");
    if (version !== apiVersion) {
      await response.body?.cancel();
      throw new YourCharProtocolError(
        `expected YourChar headless API version ${apiVersion}, received ${version ?? "none"}`,
      );
    }
    if (!response.ok) throw await apiError(response);
    return response;
  }
}

export function createIdempotencyKey(prefix = "sdk"): string {
  if (!/^[A-Za-z0-9._~:/+-]{1,40}$/u.test(prefix)) {
    throw new YourCharValidationError(
      "idempotency key prefix must contain 1-40 token characters",
      0,
      "SDK_IDEMPOTENCY_PREFIX_INVALID",
    );
  }
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    await response.body?.cancel();
    throw new YourCharProtocolError("headless API returned a non-JSON response");
  }
  try {
    return await response.json() as T;
  } catch (error) {
    throw new YourCharProtocolError("headless API returned invalid JSON", { cause: error });
  }
}

async function apiError(response: Response): Promise<YourCharApiError> {
  let payload: Record<string, unknown> = {};
  try {
    const value = await response.json() as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      payload = value as Record<string, unknown>;
    }
  } catch {
    // Keep a stable fallback without including an arbitrary response body.
  }
  const code = typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`;
  const message = typeof payload.error === "string"
    ? payload.error
    : `YourChar API request failed with HTTP ${response.status}`;
  const details = Object.freeze({ ...payload });
  if (response.status === 401 || response.status === 403) {
    return new YourCharAuthenticationError(message, response.status, code, details);
  }
  if (response.status === 404) {
    return new YourCharNotFoundError(message, response.status, code, details);
  }
  if (response.status === 409) {
    return new YourCharConflictError(message, response.status, code, details);
  }
  if ([400, 413, 415, 422].includes(response.status)) {
    return new YourCharValidationError(message, response.status, code, details);
  }
  return new YourCharApiError(message, response.status, code, details);
}

function normalizeBaseUrl(input: string | URL): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new YourCharValidationError("baseUrl must be an absolute URL", 0, "SDK_BASE_URL_INVALID", undefined);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !isLoopbackHostname(url.hostname)
  ) {
    throw new YourCharValidationError(
      "baseUrl must be an HTTP(S) loopback origin without credentials or a path",
      0,
      "SDK_BASE_URL_INVALID",
    );
  }
  return url.origin;
}

function requiredToken(value: string): string {
  const token = value.trim();
  if (
    token !== value || token.length < 32 || token.length > 512 ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/u.test(token)
  ) {
    throw new YourCharValidationError(
      "token must contain 32-512 visible token characters",
      0,
      "SDK_TOKEN_INVALID",
    );
  }
  return token;
}

function requestUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("?")) {
    throw new YourCharValidationError(
      "SDK paths must be absolute API-relative paths without traversal or query text",
      0,
      "SDK_PATH_INVALID",
    );
  }
  const url = new URL(`${apiRoot}${path}`, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function sessionPath(sessionId: string): string {
  return `/sessions/${segment(sessionId)}`;
}

function workspacePath(sessionId: string | undefined, suffix: string): string {
  return sessionId === undefined ? `/workspace${suffix}` : `${sessionPath(sessionId)}/workspace${suffix}`;
}

function workspaceScopeQuery(scope: {
  conversationSpace?: string;
  characterId?: string;
}): Record<string, QueryValue> {
  return {
    conversationSpace: scope.conversationSpace,
    characterId: scope.characterId,
  };
}

function scopeQuery(scope: SessionScopeQuery): Record<string, QueryValue> {
  return {
    conversationSpace: scope.conversationSpace,
    characterId: scope.characterId,
  };
}

function segment(value: string): string {
  if (!value) {
    throw new YourCharValidationError("resource id must not be empty", 0, "SDK_RESOURCE_ID_INVALID");
  }
  return encodeURIComponent(value);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
