import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ConversationSpace,
  MessageRequest,
  MessageResponse,
  Mode,
} from "../domain/types.js";
import type {
  ExecutionJobDetail,
  ExecutionJobSummary,
  ExecutionOutputPage,
} from "../execution/shell-jobs.js";
import type {
  CreateSessionGoalInput,
  SessionGoalDetail,
  SessionGoalPriority,
  SessionGoalStatus,
  SessionGoalSummary,
  SessionGoalTodoStatus,
  UpdateSessionGoalInput,
} from "../goals/session-goals.js";
import type { SubagentRole } from "../mcp/subagent-server.js";
import type { SubagentJobDetail, SubagentJobSummary } from "../modules/subagent-jobs.js";
import type { AgentPermissions, AgentPermissionsPatch } from "../modules/types.js";
import type { WorkspaceFileEntry, WorkspaceFilePreview } from "../workspace/file-service.js";
import type {
  CreateSessionWorkflowInput,
  SessionWorkflowDetail,
  SessionWorkflowReplayDecision,
  SessionWorkflowSummary,
} from "../workflows/session-workflows.js";

export type YourCharFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type YourCharClientOptions = Readonly<{
  /** Server origin, for example http://127.0.0.1:8765. */
  baseUrl: string | URL;
  /** Process-owned token configured as YOURCHAR_HEADLESS_API_TOKEN. */
  token: string;
  fetch?: YourCharFetch;
}>;

export type YourCharRequestOptions = Readonly<{
  signal?: AbortSignal;
  /** Replays an identical JSON mutation within the server's bounded retry window. */
  idempotencyKey?: string;
}>;

export type SessionScopeQuery = Readonly<{
  conversationSpace?: ConversationSpace;
  characterId?: string;
}>;

export type SessionListOptions = SessionScopeQuery & Readonly<{
  includeArchived?: boolean;
  signal?: AbortSignal;
}>;

export type SessionSummary = Readonly<{
  id: string;
  mode?: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  canonicalDirect: boolean;
  title?: string;
  archivedAt?: string;
  unreadCount: number;
  lastUnreadAt?: string;
  lastReadAt?: string;
  lastTurnStatus?: string;
  lastTurnCanRetry: boolean;
  sleepState?: "awake" | "sleeping";
  sleepCheckpointAt?: string;
  interactionPresence?: string;
  interactionLocation?: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionMessageResponse = MessageResponse & Readonly<{ sessionId: string }>;

export type MessageHistoryQuery = SessionScopeQuery & Readonly<{
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  signal?: AbortSignal;
}>;

export type MessageHistoryPage = Readonly<{
  messages: AgentMessage[];
  page: Readonly<{
    first: string | null;
    last: string | null;
    hasEarlier: boolean;
    hasLater: boolean;
  }>;
}>;

export type SessionStreamEvent =
  | Readonly<{ type: "delta"; delta: string }>
  | Readonly<{ type: "reasoning_status"; phase: "start" | "end" }>
  | Readonly<{ type: "tool_start"; toolName: string; toolCallId: string }>
  | Readonly<{
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      isError: boolean;
      result: unknown;
    }>
  | Readonly<{ type: "auto_retry_start" | "auto_retry_end"; [key: string]: unknown }>
  | Readonly<{ type: "lifecycle"; eventType: string }>
  | Readonly<{ type: "done"; response: SessionMessageResponse }>
  | Readonly<{ type: "error"; error: string }>;

export type StartExecutionJobRequest = Readonly<{
  command: string;
  timeoutSeconds?: number;
}>;

export type ExecutionOutputQuery = Readonly<{
  attempt?: number;
  cursor?: number;
  limitBytes?: number;
  signal?: AbortSignal;
}>;

export type StartSubagentJobRequest = Readonly<{
  role?: SubagentRole;
  task: string;
  context?: string;
  timezone?: string;
}>;

export type SubagentFollowupRequest = Readonly<{
  message: string;
  timezone?: string;
}>;

export type GoalListOptions = Readonly<{
  limit?: number;
  includeTerminal?: boolean;
  signal?: AbortSignal;
}>;

export type GoalDetailOptions = Readonly<{
  transitionLimit?: number;
  signal?: AbortSignal;
}>;

export type GoalTransitionRequest = Readonly<{
  expectedRevision: number;
  status: SessionGoalStatus;
  note?: string;
}>;

export type GoalTodoCreateRequest = Readonly<{
  expectedGoalRevision: number;
  title: string;
  notes?: string;
}>;

export type GoalTodoUpdateRequest = Readonly<{
  expectedGoalRevision: number;
  expectedTodoRevision: number;
  title?: string;
  notes?: string;
  transitionNote?: string;
}>;

export type GoalTodoTransitionRequest = Readonly<{
  expectedGoalRevision: number;
  expectedTodoRevision: number;
  status: SessionGoalTodoStatus;
  note?: string;
}>;

export type GoalDependenciesRequest = Readonly<{
  expectedRevision: number;
  dependencyGoalIds: readonly string[];
  transitionNote?: string;
}>;

export type WorkflowListOptions = Readonly<{
  limit?: number;
  includeTerminal?: boolean;
  signal?: AbortSignal;
}>;

export type WorkflowDetailOptions = Readonly<{
  eventLimit?: number;
  signal?: AbortSignal;
}>;

export type WorkflowActionRequest = Readonly<{
  expectedRevision: number;
  note?: string;
}>;

export type WorkflowDecisionRequest = Readonly<{
  decision: SessionWorkflowReplayDecision;
  note: string;
}>;

export type WorkspaceScope = Readonly<{
  sessionId?: string;
  conversationSpace?: ConversationSpace;
  characterId?: string;
}>;

export type WorkspaceFileList = Readonly<{
  path: string;
  parent?: string;
  entries: WorkspaceFileEntry[];
}>;

export type WorkspaceFileQuery = WorkspaceScope & Readonly<{
  path?: string;
  signal?: AbortSignal;
}>;

export type WorkspaceUploadRequest = WorkspaceScope & Readonly<{
  name: string;
  directory?: string;
  bytes: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
}>;

export type WorkspaceMutationOptions = WorkspaceScope & YourCharRequestOptions;

export type JsonRecord = Readonly<Record<string, unknown>>;

export type {
  AgentMessage,
  AgentPermissions,
  AgentPermissionsPatch,
  ConversationSpace,
  CreateSessionGoalInput,
  CreateSessionWorkflowInput,
  ExecutionJobDetail,
  ExecutionJobSummary,
  ExecutionOutputPage,
  MessageRequest,
  Mode,
  SessionGoalDetail,
  SessionGoalPriority,
  SessionGoalSummary,
  SessionWorkflowDetail,
  SessionWorkflowSummary,
  SubagentJobDetail,
  SubagentJobSummary,
  UpdateSessionGoalInput,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
};
