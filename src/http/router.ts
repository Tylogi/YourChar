import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import {
  DEFAULT_CHARACTER_AVATAR_PATH,
  isDefaultCharacterName,
} from "../app/default-character.js";
import {
  CompanionKernel,
  ConversationArchivedError,
  ConversationDeletionConfirmationError,
  ConversationCompactionUnavailableError,
  ConversationNotFoundError,
  ConversationTitleValidationError,
  RpMemoryValidationError,
  RpNotFoundError,
  ScheduleNotFoundError,
  ScheduleValidationError,
  SessionModeMismatchError,
  TimeResolutionError,
  TurnRetryUnavailableError,
  MessageRevisionError,
  GroupChatNotFoundError,
  GroupChatValidationError,
  WorldNotFoundError,
  WorldValidationError,
  WorldConversationValidationError,
  CharacterInteractionExecutionError,
  CharacterCapabilityValidationError,
  CharacterTaskRoutingError,
  InteractionValidationError,
  PrivateInboxMutationError,
  ControlPlaneBusyError,
  CharacterDeletionConfirmationError,
  ModelApiConfigValidationError,
  ModelProviderConfigurationError,
  ModelProviderNotFoundError,
  ModelProviderOperationUnsupportedError,
  ModelCredentialConflictError,
  ModelCredentialUnavailableError,
  ModelCredentialValidationError,
  ModelCredentialVerificationError,
  IncognitoConversationNotFoundError,
  IncognitoOperationUnsupportedError,
  IncognitoUnavailableError,
} from "../domain/index.js";
import type {
  ConversationSpace,
  MessageRequest,
  ModelApiConfigPatch,
  ModelApiProfilePatch,
  PrivateInboxEvent,
  CharacterOwnedSkillCreateInput,
  CharacterOwnedSkillUpdateInput,
  ModelContextTraceScope,
} from "../domain/index.js";
import { sanitizePriceOverrides, type ModelPrice } from "../usage/index.js";
import type {
  CreateScheduleItemInput,
  ScheduleItemKind,
  ScheduleOwnerType,
  ScheduleItemStatus,
  UpdateScheduleItemInput,
} from "../schedule/index.js";
import type {
  CharacterProfile,
  CreateCharacterInput,
  CreateMemoryInput,
  MemoryRealm,
  MemoryType,
  MemoryValidity,
  RoleplayMemoryType,
  RealityMemoryType,
  UpdateCharacterInput,
  UpdateMemoryInput,
  UpdateSceneInput,
} from "../rp/index.js";
import { RP_MEMORY_REALM, RP_MEMORY_SCOPE } from "../rp/index.js";
import type { InteractionScope } from "../interaction/index.js";
import { TestRunRegistry, type ScriptedModelResponse } from "../testing/index.js";
import { renderAppHtml } from "./ui.js";
import { DiaryValidationError } from "../diary/service.js";
import { CreatorError } from "../creator/contracts.js";
import { HistoryQueryError, historyQuery } from "../history/pagination.js";
import {
  assertLocalControlPlaneMutation,
  attachLocalControlPlaneCookie,
  LocalControlPlaneRequestError,
} from "./local-control-plane.js";
import {
  authenticateHeadlessApiRequest,
  HEADLESS_API_VERSION,
  HeadlessApiRequestError,
  mappedHeadlessApiPath,
  resolveHeadlessApiToken,
} from "./headless-auth.js";
import {
  consumePreparedHeadlessJsonBody,
  HeadlessIdempotencyError,
  HeadlessIdempotencyRegistry,
  recordHeadlessIdempotentJsonResponse,
} from "./headless-idempotency.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentRole } from "../mcp/subagent-server.js";
import { UserProfileValidationError } from "../profile/service.js";
import { profileManualSection } from "../profile/managed-memory.js";
import { AvatarValidationError, type AvatarAsset } from "../profile/avatar-service.js";
import { SystemPromptValidationError } from "../profile/system-prompt-service.js";
import { CharacterSoulValidationError } from "../rp/soul.js";
import { AgentPermissionValidationError } from "../modules/permissions.js";
import type { AgentPermissionsPatch, WorkspaceAccess } from "../modules/types.js";
import {
  AgentModuleSettingsConflictError,
  AgentModuleSettingsSchemaConflictError,
  AgentModuleSettingsUnavailableError,
  AgentModuleSettingsValidationError,
  SubagentJobNotFoundError,
  SubagentJobStateError,
  SubagentSettingsConflictError,
  SubagentSettingsValidationError,
  type SubagentSettingsPatch,
} from "../modules/index.js";
import { TavilyApiError, TavilyConfigurationError } from "../tavily/service.js";
import type { TavilyApiConfigPatch } from "../tavily/types.js";
import { VisionApiError, VisionConfigurationError } from "../vision/service.js";
import type { VisionApiConfigPatch } from "../vision/types.js";
import { MineruApiError, MineruConfigurationError } from "../mineru/service.js";
import type { MineruApiConfigPatch } from "../mineru/types.js";
import {
  GitIdentityKeyError,
  GitRepositoryConfigurationError,
  GitRepositoryOperationError,
  type GitAccessConfigPatch,
} from "../git/index.js";
import { gitMcpModuleId, mineruMcpModuleId } from "../modules/catalog.js";
import { browserAsset } from "./browser-assets.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryVaultError } from "../memory-vault/errors.js";
import { MemoryLifecycleError } from "../memory-coordinator/lifecycle.js";
import {
  ExecutionJobCapacityError,
  ExecutionJobNotFoundError,
  ExecutionJobStateError,
  ExecutionJobValidationError,
  maximumExecutionOutputPageBytes,
} from "../execution/index.js";
import {
  SessionGoalConflictError,
  SessionGoalNotFoundError,
  SessionGoalTodoNotFoundError,
  SessionGoalValidationError,
  type SessionGoalPriority,
  type SessionGoalStatus,
  type SessionGoalTodoStatus,
} from "../goals/index.js";
import {
  SessionWorkflowConflictError,
  SessionWorkflowNotFoundError,
  SessionWorkflowValidationError,
  type SessionWorkflowNodeInput,
  type SessionWorkflowReplayDecision,
} from "../workflows/index.js";
import type { MemoryControlPlaneEdit } from "../memory-coordinator/types.js";
import { UserInsightControlError } from "../user-insight/index.js";
import {
  MAX_OKF_ARCHIVE_BYTES,
  OkfBundleError,
  type OkfImportRealm,
} from "../okf/index.js";
import { listFeatureTestCases, runFeatureTest } from "../evaluation/feature-tests.js";
import {
  judgeFeatureTestQuality,
  scoreFeatureTestResult,
} from "../evaluation/model-adaptation.js";
import {
  parseTaskBenchRequest,
  runTaskBench,
  TaskBenchValidationError,
} from "../evaluation/task-bench.js";
import {
  MAX_TASK_BENCH_UPLOAD_BYTES,
  TaskBenchUploadError,
  TaskBenchUploadRegistry,
} from "../evaluation/task-bench-uploads.js";
import { TaskBenchReportRepository } from "../evaluation/task-bench-reports.js";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  WorkspaceFileError,
  type WorkspaceFileAsset,
} from "../workspace/file-service.js";
import type {
  CharacterAutonomyPolicyPatch,
  CharacterRuntimePatch,
  CharacterWorldAssignmentInput,
  CreatePlaceInput,
  CreateWorldAttributeDefinitionInput,
  CreateWorldInput,
  UpdatePlaceInput,
  UpdateWorldAttributeDefinitionInput,
  UpdateWorldInput,
  ProactiveFeedbackType,
  ProactiveMessageStatus,
  WorldCapabilityId,
} from "../world/index.js";
import {
  MeetingPresetNotFoundError,
  MeetingPresetValidationError,
  type UpdateMeetingPresetInput,
} from "../meeting-preset/index.js";
import {
  AgentSkillInstallerError,
  type AgentSkillStageResult,
} from "../modules/skill-installer.js";
import type { CharacterAgentSkillPackage } from "../modules/character-skill-packages.js";
import {
  ImIntegrationError,
  isFeishuDomain,
  isImProvider,
  type ImBindingSession,
  type ImInboundEventInput,
  type ImProvider,
} from "../im/index.js";

export type HttpServerOptions = {
  kernel?: CompanionKernel;
  testMode?: boolean;
  testRuns?: TestRunRegistry;
  taskBenchUploads?: TaskBenchUploadRegistry;
  taskBenchReports?: TaskBenchReportRepository;
  imGatewaySecret?: string;
  /** Set to false to ignore the environment and keep the headless API disabled. */
  headlessApiToken?: string | false;
};

const ownedResourceDisposers = new WeakMap<Server, () => void>();

export function disposeHttpServerOwnedResources(server: Server): void {
  ownedResourceDisposers.get(server)?.();
}

export function createHttpServer(options: HttpServerOptions = {}) {
  const headlessApiToken = resolveHeadlessApiToken(options.headlessApiToken);
  const headlessIdempotency = new HeadlessIdempotencyRegistry();
  const testMode = options.testMode ?? process.env.RP_AGENT_TEST_MODE === "1";
  const ownsKernel = !options.kernel;
  const kernel = options.kernel ?? new CompanionKernel({
    ...(testMode ? { imGateway: false } : {}),
  });
  const ownsTestRuns = !options.testRuns && testMode;
  const testRuns = options.testRuns ?? (testMode ? new TestRunRegistry() : undefined);
  const ownsTaskBenchUploads = !options.taskBenchUploads;
  const taskBenchUploads = options.taskBenchUploads ?? new TaskBenchUploadRegistry();
  const taskBenchReports = options.taskBenchReports ?? new TaskBenchReportRepository(
    kernel.database,
    { stateDir: kernel.store.stateDir },
  );
  const configuredImGatewaySecret = options.imGatewaySecret ??
    process.env.YOURCHAR_IM_GATEWAY_INGRESS_TOKEN?.trim() ??
    process.env.YOURCHAR_IM_GATEWAY_TOKEN?.trim() ??
    process.env.RP_AGENT_IM_GATEWAY_INGRESS_TOKEN?.trim() ??
    process.env.RP_AGENT_IM_GATEWAY_TOKEN?.trim();
  const imGatewaySecret = configuredImGatewaySecret && configuredImGatewaySecret.length >= 16
    ? configuredImGatewaySecret
    : undefined;
  const server = createServer(async (request, response) => {
    try {
      await route({
        kernel,
        testRuns,
        taskBenchUploads,
        taskBenchReports,
        request,
        response,
        imGatewaySecret,
        headlessApiToken,
        headlessIdempotency,
      });
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        console.error("YourChar HTTP request failed after the response started", error);
        if (!response.writableEnded) response.destroy(asError(error));
        return;
      }
      if (error instanceof HeadlessApiRequestError) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-yourchar-api-version", HEADLESS_API_VERSION);
        if (error.status === 401) {
          response.setHeader("www-authenticate", 'Bearer realm="YourChar Headless API"');
        }
        sendJson(response, error.status, { code: error.code, error: error.message });
      } else if (error instanceof HeadlessIdempotencyError) {
        sendJson(response, error.status, { code: error.code, error: error.message });
      } else if (error instanceof LocalControlPlaneRequestError) {
        if (error.code === "LOCAL_CONTROL_TOKEN_REJECTED") {
          // A browser tab may outlive the server process that issued its
          // HttpOnly capability. Refresh only an otherwise-valid same-origin
          // request so the UI can safely retry the rejected mutation once.
          attachLocalControlPlaneCookie(request, response);
        }
        sendJson(response, error.status, { code: error.code, error: error.message });
      } else if (error instanceof CreatorError) {
        sendJson(response, error.status, { code: error.code, error: error.message });
      } else if (error instanceof ControlPlaneBusyError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof CharacterDeletionConfirmationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof AgentSkillInstallerError) {
        sendJson(response, agentSkillInstallerHttpStatus(error.code), {
          code: error.code,
          error: error.message,
        });
      } else if (error instanceof ImIntegrationError) {
        sendJson(response, error.httpStatus, { code: error.code, error: error.message });
      } else if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { code: "BODY_TOO_LARGE", error: error.message });
      } else if (error instanceof TaskBenchValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof TaskBenchUploadError) {
        sendJson(response, error.httpStatus, { code: error.code, error: error.message });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { code: "INVALID_JSON", error: error.message });
      } else if (error instanceof SessionModeMismatchError) {
        sendJson(response, 409, { code: "SESSION_MODE_MISMATCH", error: error.message });
      } else if (error instanceof ConversationArchivedError) {
        sendJson(response, 409, { code: "SESSION_ARCHIVED", error: error.message });
      } else if (error instanceof ConversationNotFoundError) {
        sendJson(response, 404, { code: "SESSION_NOT_FOUND", error: error.message });
      } else if (error instanceof IncognitoConversationNotFoundError) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof IncognitoOperationUnsupportedError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof IncognitoUnavailableError) {
        sendJson(response, 503, { code: error.code, error: error.message });
      } else if (error instanceof ConversationTitleValidationError) {
        sendJson(response, 400, { code: "SESSION_TITLE_INVALID", error: error.message });
      } else if (error instanceof ConversationDeletionConfirmationError) {
        sendJson(response, 400, { code: "SESSION_DELETE_CONFIRMATION_REQUIRED", error: error.message });
      } else if (error instanceof ConversationCompactionUnavailableError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SessionBatchValidationError) {
        sendJson(response, 400, { code: "SESSION_BATCH_INVALID", error: error.message });
      } else if (error instanceof TurnRetryUnavailableError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof MessageRevisionError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof PrivateInboxMutationError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SessionCharacterMismatchError) {
        sendJson(response, 409, { code: "SESSION_CHARACTER_MISMATCH", error: error.message });
      } else if (error instanceof CharacterBindingRequiredError) {
        sendJson(response, 422, { code: "CHARACTER_REQUIRED", error: error.message });
      } else if (error instanceof GroupChatNotFoundError) {
        sendJson(response, 404, { code: "GROUP_CHAT_NOT_FOUND", error: error.message });
      } else if (error instanceof GroupChatValidationError) {
        sendJson(response, 400, { code: "GROUP_CHAT_INVALID", error: error.message });
      } else if (error instanceof WorldNotFoundError) {
        sendJson(response, 404, { code: "WORLD_NOT_FOUND", error: error.message });
      } else if (error instanceof WorldValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof HistoryQueryError) {
        sendJson(response, error.status, { code: "HISTORY_QUERY_INVALID", error: error.message });
      } else if (error instanceof DiaryValidationError) {
        sendJson(response, 400, { error: error.message });
      } else if (error instanceof WorldConversationValidationError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof CharacterInteractionExecutionError) {
        sendJson(response, 502, {
          code: error.code,
          error: error.message,
          episodeId: error.episodeId,
        });
      } else if (error instanceof CharacterCapabilityValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof CharacterTaskRoutingError) {
        sendJson(response, 409, {
          code: error.code,
          error: error.message,
          ...(error.route ? { route: error.route } : {}),
        });
      } else if (error instanceof InteractionValidationError) {
        const conflict = error.code === "INTERACTION_CONFLICT" || error.code === "INTERACTION_UNDO_UNAVAILABLE";
        sendJson(response, conflict ? 409 : 422, { code: error.code, error: error.message });
      } else if (error instanceof TimeResolutionError) {
        sendJson(response, 422, {
          code: error.code,
          error: error.message,
          candidates: error.candidates,
        });
      } else if (error instanceof ScheduleNotFoundError) {
        sendJson(response, 404, { code: "NOT_FOUND", error: error.message });
      } else if (error instanceof ScheduleValidationError) {
        sendJson(response, 400, { code: "SCHEDULE_INVALID", error: error.message });
      } else if (error instanceof RpNotFoundError) {
        sendJson(response, 404, { code: "NOT_FOUND", error: error.message });
      } else if (error instanceof RpMemoryValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof MeetingPresetNotFoundError) {
        sendJson(response, 404, { code: "MEETING_PRESET_NOT_FOUND", error: error.message });
      } else if (error instanceof MeetingPresetValidationError) {
        sendJson(response, 400, { code: "MEETING_PRESET_INVALID", error: error.message });
      } else if (error instanceof UserProfileValidationError) {
        sendJson(response, 400, { code: "USER_PROFILE_INVALID", error: error.message });
      } else if (error instanceof SystemPromptValidationError) {
        sendJson(response, 400, { code: "SYSTEM_PROMPT_INVALID", error: error.message });
      } else if (error instanceof AvatarValidationError) {
        sendJson(response, 400, { code: "AVATAR_INVALID", error: error.message });
      } else if (error instanceof CharacterSoulValidationError) {
        sendJson(response, 400, { code: "CHARACTER_SOUL_INVALID", error: error.message });
      } else if (error instanceof MemoryVaultError) {
        sendJson(response, error.code === "MEMORY_VAULT_CAS_CONFLICT" ? 409 : 422, {
          code: error.code,
          error: error.message,
        });
      } else if (error instanceof MemoryLifecycleError) {
        sendJson(response, memoryLifecycleHttpStatus(error.code), {
          code: error.code,
          error: error.message,
        });
      } else if (error instanceof UserInsightControlError) {
        const status = error.code === "USER_INSIGHT_NOT_FOUND"
          ? 404
          : error.code === "USER_INSIGHT_SENSITIVE" ? 422 : 409;
        sendJson(response, status, { code: error.code, error: error.message });
      } else if (error instanceof OkfBundleError) {
        sendJson(response, 422, { code: error.code, error: error.message });
      } else if (error instanceof AgentPermissionValidationError) {
        sendJson(response, 400, { code: "AGENT_PERMISSION_INVALID", error: error.message });
      } else if (error instanceof AgentModuleSettingsValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof AgentModuleSettingsConflictError) {
        sendJson(response, 409, {
          code: error.code,
          error: error.message,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        });
      } else if (error instanceof AgentModuleSettingsSchemaConflictError) {
        sendJson(response, 409, {
          code: error.code,
          error: error.message,
          expectedSchemaVersion: error.expectedSchemaVersion,
          actualSchemaVersion: error.actualSchemaVersion,
        });
      } else if (error instanceof AgentModuleSettingsUnavailableError) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof ExecutionJobNotFoundError) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof ExecutionJobValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (
        error instanceof ExecutionJobStateError ||
        error instanceof ExecutionJobCapacityError
      ) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (
        error instanceof SessionGoalNotFoundError ||
        error instanceof SessionGoalTodoNotFoundError
      ) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof SessionGoalValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof SessionGoalConflictError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SessionWorkflowNotFoundError) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof SessionWorkflowValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof SessionWorkflowConflictError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SubagentJobNotFoundError) {
        sendJson(response, 404, { code: error.code, error: error.message });
      } else if (error instanceof SubagentJobStateError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SubagentSettingsValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof SubagentSettingsConflictError) {
        sendJson(response, 409, {
          code: error.code,
          error: error.message,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        });
      } else if (error instanceof ModelApiConfigValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof ModelCredentialValidationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof ModelCredentialConflictError) {
        sendJson(response, 409, {
          code: error.code,
          error: error.message,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        });
      } else if (error instanceof ModelCredentialUnavailableError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof ModelCredentialVerificationError) {
        sendJson(response, 502, { code: error.code, error: error.message });
      } else if (error instanceof ModelProviderConfigurationError) {
        sendJson(response, 400, { code: error.code, error: error.message, issues: error.issues });
      } else if (error instanceof ModelProviderNotFoundError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof ModelProviderOperationUnsupportedError) {
        sendJson(response, 501, { code: error.code, error: error.message });
      } else if (error instanceof WorkspaceFileError) {
        sendJson(response, workspaceFileHttpStatus(error.code), { code: error.code, error: error.message });
      } else if (error instanceof TavilyConfigurationError) {
        sendJson(response, 400, { code: "TAVILY_CONFIG_INVALID", error: error.message });
      } else if (error instanceof TavilyApiError) {
        sendJson(response, 502, { code: "TAVILY_API_ERROR", upstreamStatus: error.status, error: error.message });
      } else if (error instanceof VisionConfigurationError) {
        sendJson(response, 400, { code: "VISION_CONFIG_INVALID", error: error.message });
      } else if (error instanceof VisionApiError) {
        sendJson(response, 502, { code: "VISION_API_ERROR", upstreamStatus: error.status, error: error.message });
      } else if (error instanceof MineruConfigurationError) {
        sendJson(response, 400, { code: "MINERU_CONFIG_INVALID", error: error.message });
      } else if (error instanceof MineruApiError) {
        sendJson(response, 502, { code: "MINERU_API_ERROR", upstreamStatus: error.status, error: error.message });
      } else if (error instanceof GitIdentityKeyError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof GitRepositoryConfigurationError) {
        sendJson(response, 400, { code: error.code, error: error.message });
      } else if (error instanceof GitRepositoryOperationError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  let resourcesDisposed = false;
  let resourceDisposalError: Error | undefined;
  const disposeOwnedResources = () => {
    if (resourcesDisposed) return;
    resourcesDisposed = true;
    try {
      if (ownsTestRuns) testRuns?.dispose();
    } catch (error) {
      resourceDisposalError = asError(error);
    }
    try {
      if (ownsTaskBenchUploads) taskBenchUploads.dispose();
    } catch (error) {
      resourceDisposalError ??= asError(error);
    }
    try {
      if (ownsKernel) kernel.dispose();
    } catch (error) {
      resourceDisposalError ??= asError(error);
    }
  };
  ownedResourceDisposers.set(server, disposeOwnedResources);
  server.once("close", disposeOwnedResources);
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => close((error?: Error) => {
    // A never-listened server reports ERR_SERVER_NOT_RUNNING without emitting close.
    disposeOwnedResources();
    callback?.(error ?? resourceDisposalError);
  })) as typeof server.close;
  return server;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function route(input: {
  kernel: CompanionKernel;
  testRuns?: TestRunRegistry;
  taskBenchUploads: TaskBenchUploadRegistry;
  taskBenchReports: TaskBenchReportRepository;
  request: IncomingMessage;
  response: ServerResponse;
  imGatewaySecret?: string;
  headlessApiToken?: string;
  headlessIdempotency: HeadlessIdempotencyRegistry;
}) {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://127.0.0.1");
  let pathname = normalizePath(url.pathname);
  const mappedHeadlessPath = mappedHeadlessApiPath(pathname);
  if (mappedHeadlessPath !== undefined) {
    input.response.setHeader("cache-control", "no-store");
    input.response.setHeader("x-yourchar-api-version", HEADLESS_API_VERSION);
    authenticateHeadlessApiRequest(input.request, input.headlessApiToken);
    pathname = mappedHeadlessPath;
    if (await input.headlessIdempotency.prepare({
      request: input.request,
      response: input.response,
      method,
      resource: `${pathname}${url.search}`,
    })) return;
  }

  const asset = method === "GET" ? browserAsset(pathname) : undefined;
  if (asset) {
    input.response.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    input.response.end(asset.body);
    return;
  }

  if (await routeTestControl({ ...input, method, url, pathname })) {
    return;
  }

  const kernel = selectKernel(input.request, input.kernel, input.testRuns, input.response);
  if (!kernel) {
    return;
  }
  if (pathname.startsWith("/api/v1/creator/")) {
    // Reads also require the browser's control-plane capability. No creator
    // state is exposed through ordinary character conversation endpoints.
    assertLocalControlPlaneMutation(input.request);
    if (method !== "POST") throw new CreatorError("创作助手接口仅接受 POST", 405);
    const body = asRecord(await readJson(input.request));
    input.response.setHeader("cache-control", "no-store");
    if (pathname === "/api/v1/creator/snapshot") {
      sendJson(input.response, 200, kernel.creator.snapshot(body.before === undefined ? undefined : Number(body.before)));
    } else if (pathname === "/api/v1/creator/messages") {
      sendJson(input.response, 200, await kernel.creator.send(body.text as string, body.requestId as string));
    } else if (pathname === "/api/v1/creator/cancel") {
      sendJson(input.response, 200, kernel.creator.cancel());
    } else if (pathname === "/api/v1/creator/review") {
      if (typeof body.id !== "string" || typeof body.digest !== "string" || !["apply", "reject"].includes(String(body.action))) throw new CreatorError("无效的草案确认请求");
      sendJson(input.response, 200, { proposal: kernel.creator.review(body.id, body.digest, body.action as "apply" | "reject") });
    } else {
      throw new CreatorError("找不到创作助手接口", 404);
    }
    return;
  }
  if (
    method === "GET" &&
    (pathname === "/health" || pathname === "/api/health" || pathname === "/api/v1/health")
  ) {
    sendJson(input.response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/readiness") {
    sendJson(input.response, 200, kernel.readiness());
    return;
  }

  if (method === "GET" && pathname === "/api/v1/feature-tests") {
    sendJson(input.response, 200, { cases: listFeatureTestCases() });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/task-bench/reports") {
    const limit = optionalPositiveInteger(url.searchParams.get("limit")) ?? 20;
    sendJson(input.response, 200, { reports: input.taskBenchReports.list(limit) });
    return;
  }

  const taskBenchReportMatch = pathname.match(/^\/api\/v1\/task-bench\/reports\/([^/]+)$/);
  if (taskBenchReportMatch && method === "GET") {
    const id = decodeURIComponent(taskBenchReportMatch[1]);
    const result = input.taskBenchReports.get(id);
    if (!result) {
      sendJson(input.response, 404, {
        code: "TASK_BENCH_REPORT_NOT_FOUND",
        error: `task-bench report not found: ${id}`,
      });
      return;
    }
    sendJson(input.response, 200, result);
    return;
  }

  if (method === "POST" && pathname === "/api/v1/task-bench/uploads") {
    const name = requiredString(url.searchParams.get("name"), "name");
    const rawContentType = input.request.headers["content-type"];
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
    const bytes = await readBinary(input.request, MAX_TASK_BENCH_UPLOAD_BYTES);
    sendJson(input.response, 201, {
      upload: input.taskBenchUploads.add({ name, contentType, bytes }),
    });
    return;
  }

  const taskBenchUploadMatch = pathname.match(/^\/api\/v1\/task-bench\/uploads\/([^/]+)$/);
  if (taskBenchUploadMatch && method === "DELETE") {
    const id = decodeURIComponent(taskBenchUploadMatch[1]);
    const removed = input.taskBenchUploads.remove(id);
    sendJson(input.response, removed ? 200 : 404, { removed });
    return;
  }

  if (method === "POST" && pathname === "/api/v1/task-bench/run") {
    const request = parseTaskBenchRequest(await readJson(input.request));
    const uploadedFixtures = input.taskBenchUploads.snapshot(request.uploadIds);
    const result = await runTaskBench(kernel, request, uploadedFixtures);
    input.taskBenchReports.save(result);
    sendJson(input.response, 200, result);
    return;
  }

  const featureTestMatch = pathname.match(/^\/api\/v1\/feature-tests\/([^/]+)\/run$/);
  if (featureTestMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const characterId = optionalString(body.characterId) ?? kernel.listCharacters()[0]?.id;
    const result = await runFeatureTest(
      kernel,
      decodeURIComponent(featureTestMatch[1]),
      {
        characterId,
        modelProfileId: optionalString(body.modelProfileId),
      },
    );
    const judgeModelProfileId = optionalString(body.judgeModelProfileId);
    sendJson(input.response, 200, {
      result,
      functional: scoreFeatureTestResult(result),
      ...(judgeModelProfileId
        ? { quality: await judgeFeatureTestQuality(kernel, result, judgeModelProfileId, characterId) }
        : {}),
    });
    return;
  }

  if (
    method === "GET" &&
    (pathname === "/" || pathname === "/ui" || pathname === "/ui/index.html" || pathname === "/index.html")
  ) {
    sendHtml(input.request, input.response, 200, renderAppHtml());
    return;
  }

  if (method === "GET" && pathname === "/api") {
    sendJson(input.response, 200, {
      name: "YourChar",
      status: "ok",
      ui: "/ui",
      messageEndpoint: "POST /api/v1/sessions/{id}/messages",
      directConversation: "POST /api/v1/direct-conversations",
      incognitoConversations: "GET/POST/DELETE /api/v1/incognito-conversations/{id}",
      conversationUnread: "GET /api/v1/conversation-unread",
      markConversationRead: "POST /api/v1/sessions/{id}/read",
      debugContextLogs: "GET /api/debug/context-logs",
      debugModelTraces: "GET /api/debug/model-traces",
      debugContextEconomics: "GET /api/debug/context-economics",
      taskBench: "POST /api/v1/task-bench/run; GET /api/v1/task-bench/reports[/{id}]",
      taskBenchUploads: "POST/DELETE /api/v1/task-bench/uploads[/{id}]",
      agentModules: "GET /api/v1/agent-modules; GET/PATCH /api/v1/agent-modules/{id}/settings",
      agentRuntime: "GET /api/v1/agent-runtime/configuration; PATCH /api/v1/agent-runtime/profile",
      subagentSettings: "GET/PATCH /api/v1/subagent-settings",
      agentPermissions: "GET/PATCH /api/v1/agent-permissions",
      userProfile: "GET/PATCH /api/v1/user-profile",
      userInsights: "GET /api/v1/user-insights",
      userInsightControl: "POST /api/v1/user-insights/{id}/{confirm|reject|unlock}",
      modelApiSettings: "GET/PATCH /api/settings/model-api",
      modelProviders: "GET /api/v1/model-providers",
      modelProfiles: "GET/POST/PATCH/DELETE /api/v1/model-profiles[/{id}]",
      modelCredentials:
        "PUT /api/v1/model-profiles/{id}/credential; POST /api/v1/model-profiles/{id}/credential/{revoke|rollback}",
      modelDiagnostics:
        "POST /api/v1/diagnostics/model/test; GET /api/v1/diagnostics/model/models; POST /api/v1/diagnostics/model/models for an uncommitted candidate",
      tavilySettings: "GET/PATCH /api/settings/tavily",
      visionSettings: "GET/PATCH /api/settings/vision",
      mineruSettings: "GET/PATCH /api/settings/mineru",
      gitAccessSettings: "GET/PATCH /api/settings/git-access; POST /api/settings/git-access/generate-key; GET /api/settings/git-access/public-key",
      traceArchiveSettings: "GET/PATCH /api/settings/trace-archive",
      interactionState: "GET/POST /api/v1/sessions/{id}/interaction",
      worldAttributes: "POST/PATCH /api/v1/worlds/{id}/attributes; PATCH/DELETE /api/v1/world-attributes/{id}; PATCH /api/v1/characters/{id}/life/attributes",
      characterCollaborations: "GET /api/v1/sessions/{id}/character-collaborations",
      contextBudget: "GET /api/v1/sessions/{id}/context-budget",
      compactContext: "POST /api/v1/sessions/{id}/compact",
      subagentJobs:
        "GET/POST /api/v1/sessions/{id}/subagent-jobs; GET /api/v1/sessions/{id}/subagent-jobs/{jobId}; POST /api/v1/sessions/{id}/subagent-jobs/{jobId}/{messages|interrupt|retry}",
      executionJobs:
        "GET/POST /api/v1/sessions/{id}/execution-jobs; GET /api/v1/sessions/{id}/execution-jobs/{jobId}[/output]; POST /api/v1/sessions/{id}/execution-jobs/{jobId}/{interrupt|retry}",
      goals:
        "GET/POST /api/v1/sessions/{id}/goals; GET/PATCH /api/v1/sessions/{id}/goals/{goalId}; mutate transitions, dependencies, and todos below a goal",
      workflows:
        "GET/POST /api/v1/sessions/{id}/workflows; GET /api/v1/sessions/{id}/workflows/{workflowId}; POST start/cancel or trusted node replay decisions below a workflow",
      imChannels: "GET /api/v1/im/channels",
      imSettings: "GET/PATCH /api/v1/im/settings",
      imBindingQr: "POST /api/v1/im/bindings/{provider}/qr",
    });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/im/channels") {
    sendJson(input.response, 200, kernel.listImChannels());
    return;
  }

  const imChannelMatch = pathname.match(/^\/api\/v1\/im\/channels\/([^/]+)$/);
  if (imChannelMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const provider = requireImProvider(decodeURIComponent(imChannelMatch[1]));
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["characterId"], "IM channel route");
    const route = body.characterId === null
      ? (kernel.clearImCharacterRoute(provider), undefined)
      : kernel.setImCharacterRoute(
          provider,
          requiredImString(body.characterId, "characterId"),
        );
    sendJson(input.response, 200, { route: route ?? null });
    return;
  }

  if (pathname === "/api/v1/im/settings") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getImRuntimeSettings());
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asImRecord(await readJson(input.request));
      assertOnlyImKeys(body, ["wechatTypingEnabled", "wechatRemindersEnabled", "feishuRemindersEnabled"], "IM settings");
      sendJson(input.response, 200, kernel.patchImRuntimeSettings({
        ...(body.wechatRemindersEnabled === undefined ? {} : { wechatRemindersEnabled: requiredImBoolean(body.wechatRemindersEnabled, "wechatRemindersEnabled") }),
        ...(body.feishuRemindersEnabled === undefined ? {} : { feishuRemindersEnabled: requiredImBoolean(body.feishuRemindersEnabled, "feishuRemindersEnabled") }),
        ...(body.wechatTypingEnabled === undefined
          ? {}
          : {
              wechatTypingEnabled: requiredImBoolean(
                body.wechatTypingEnabled,
                "wechatTypingEnabled",
              ),
            }),
      }));
      return;
    }
  }

  const imBindingQrMatch = pathname.match(/^\/api\/v1\/im\/bindings\/([^/]+)\/qr$/);
  if (imBindingQrMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const provider = requireImProvider(decodeURIComponent(imBindingQrMatch[1]));
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["domain"], "IM binding request");
    const domain = body.domain;
    if (domain !== undefined && !isFeishuDomain(domain)) {
      throw new ImIntegrationError("IM_DOMAIN_INVALID", "domain must be feishu or lark", 400);
    }
    sendJson(input.response, 201, {
      session: publicImBindingSession(await kernel.startImBinding(provider, {
        ...(domain ? { domain } : {}),
      })),
    });
    return;
  }

  const imBindingSessionMatch = pathname.match(
    /^\/api\/v1\/im\/binding-sessions\/([^/]+)$/,
  );
  if (imBindingSessionMatch && method === "GET") {
    sendJson(input.response, 200, {
      session: publicImBindingSession(
        await kernel.getImBindingSession(decodeURIComponent(imBindingSessionMatch[1])),
      ),
    });
    return;
  }

  const imBindingCancelMatch = pathname.match(
    /^\/api\/v1\/im\/binding-sessions\/([^/]+)\/cancel$/,
  );
  if (imBindingCancelMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, [], "IM binding cancellation");
    sendJson(input.response, 200, {
      session: publicImBindingSession(
        await kernel.cancelImBindingSession(decodeURIComponent(imBindingCancelMatch[1])),
      ),
    });
    return;
  }

  const imBindingVerifyMatch = pathname.match(
    /^\/api\/v1\/im\/binding-sessions\/([^/]+)\/verify$/,
  );
  if (imBindingVerifyMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["code"], "IM binding verification");
    sendJson(input.response, 200, {
      session: publicImBindingSession(
        await kernel.submitImBindingVerification(
          decodeURIComponent(imBindingVerifyMatch[1]),
          requiredImString(body.code, "code"),
        ),
      ),
    });
    return;
  }

  const imBindingMatch = pathname.match(/^\/api\/v1\/im\/bindings\/([^/]+)$/);
  if (imBindingMatch && method === "DELETE") {
    assertLocalControlPlaneMutation(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, [], "IM disconnect request");
    sendJson(input.response, 200, await kernel.disconnectImBinding(
      requireImProvider(decodeURIComponent(imBindingMatch[1])),
    ));
    return;
  }

  if (pathname === "/api/v1/im/gateway/events" && method === "POST") {
    assertImGatewayAuthorization(input.request, input.imGatewaySecret);
    assertImJsonRequest(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, [
      "eventId",
      "provider",
      "connectionId",
      "bindingGeneration",
      "externalChatId",
      "externalUserId",
      "chatType",
      "text",
      "attachments",
      "receivedAt",
      "timezone",
    ], "IM gateway event");
    const provider = requireImProvider(body.provider, 400);
    const chatType = body.chatType;
    if (chatType !== "direct" && chatType !== "group") {
      throw new ImIntegrationError("IM_CHAT_TYPE_INVALID", "chatType must be direct or group", 400);
    }
    if (
      body.attachments !== undefined &&
      (!Array.isArray(body.attachments) || body.attachments.length > 0)
    ) {
      throw new ImIntegrationError(
        "IM_MEDIA_GATEWAY_UNSUPPORTED",
        "外部 Gateway 入站媒体需要独立的鉴权上传协议，当前接口仅接受文字",
        501,
      );
    }
    const receivedAt = optionalImString(body.receivedAt, "receivedAt");
    const timezone = optionalImString(body.timezone, "timezone");
    const bindingGeneration = optionalImString(
      body.bindingGeneration,
      "bindingGeneration",
    );
    const event: ImInboundEventInput = {
      eventId: requiredImString(body.eventId, "eventId"),
      provider,
      connectionId: requiredImString(body.connectionId, "connectionId"),
      externalChatId: requiredImString(body.externalChatId, "externalChatId"),
      externalUserId: requiredImString(body.externalUserId, "externalUserId"),
      chatType,
      text: requiredImString(body.text, "text"),
      ...(bindingGeneration ? { bindingGeneration } : {}),
      ...(receivedAt ? { receivedAt } : {}),
      ...(timezone ? { timezone } : {}),
    };
    sendJson(input.response, 200, await kernel.receiveImInboundEvent(event));
    return;
  }

  if (pathname === "/api/v1/im/gateway/outbox/claim" && method === "POST") {
    assertImGatewayAuthorization(input.request, input.imGatewaySecret);
    assertImJsonRequest(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["provider", "connectionId", "limit"], "IM outbox claim");
    const provider = optionalImString(body.provider, "provider");
    const connectionId = optionalImString(body.connectionId, "connectionId");
    const limit = optionalImPositiveInteger(body.limit, "limit");
    sendJson(input.response, 200, {
      items: kernel.claimImPendingOutbox({
        ...(provider ? { provider: requireImProvider(provider, 400) } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(limit ? { limit } : {}),
      }),
    });
    return;
  }

  const imOutboxAuthorizeMatch = pathname.match(
    /^\/api\/v1\/im\/gateway\/outbox\/([^/]+)\/authorize$/,
  );
  if (imOutboxAuthorizeMatch && method === "POST") {
    assertImGatewayAuthorization(input.request, input.imGatewaySecret);
    assertImJsonRequest(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["leaseToken"], "IM outbox authorization");
    sendJson(input.response, 200, {
      item: kernel.authorizeImOutbox(
        decodeURIComponent(imOutboxAuthorizeMatch[1]),
        requiredImString(body.leaseToken, "leaseToken"),
      ),
    });
    return;
  }

  const imOutboxAckMatch = pathname.match(
    /^\/api\/v1\/im\/gateway\/outbox\/([^/]+)\/ack$/,
  );
  if (imOutboxAckMatch && method === "POST") {
    assertImGatewayAuthorization(input.request, input.imGatewaySecret);
    assertImJsonRequest(input.request);
    const body = asImRecord(await readJson(input.request));
    assertOnlyImKeys(body, ["leaseToken", "delivered", "error", "retryAt"], "IM outbox acknowledgement");
    const deliveryError = optionalImString(body.error, "error");
    const retryAt = optionalImString(body.retryAt, "retryAt");
    sendJson(input.response, 200, {
      item: kernel.acknowledgeImOutbox({
        id: decodeURIComponent(imOutboxAckMatch[1]),
        leaseToken: requiredImString(body.leaseToken, "leaseToken"),
        delivered: requiredImBoolean(body.delivered, "delivered"),
        ...(deliveryError ? { error: deliveryError } : {}),
        ...(retryAt ? { retryAt } : {}),
      }),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/sessions") {
    const conversationSpace = requestedConversationSpace(url);
    const characterId = requestedConversationCharacterId(url, conversationSpace);
    const records = await kernel.listSessions(conversationSpace, characterId);
    const metadata = new Map(kernel.listConversationMetadata()
      .filter((entry) =>
        entry.conversationSpace === conversationSpace &&
        (characterId === undefined || entry.characterId === characterId)
      )
      .map((entry) => [entry.id, entry]));
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    sendJson(input.response, 200, {
      sessions: records.filter((record) => includeArchived || !metadata.get(record.id)?.archivedAt).map((record) => ({
        id: record.id,
        mode: metadata.get(record.id)?.mode,
        conversationSpace: metadata.get(record.id)?.conversationSpace ?? "normal",
        characterId: metadata.get(record.id)?.characterId,
        canonicalDirect: metadata.get(record.id)?.canonicalDirect ?? false,
        title: metadata.get(record.id)?.title,
        archivedAt: metadata.get(record.id)?.archivedAt,
        unreadCount: metadata.get(record.id)?.unreadCount ?? 0,
        lastUnreadAt: metadata.get(record.id)?.lastUnreadAt,
        lastReadAt: metadata.get(record.id)?.lastReadAt,
        lastTurnStatus: metadata.get(record.id)?.lastTurnStatus,
        lastTurnCanRetry: metadata.get(record.id)?.lastTurnCanRetry ?? false,
        ...(conversationSpace === "normal" ? {
          sleepState: metadata.get(record.id)?.sleepState ?? "awake",
          sleepCheckpointAt: metadata.get(record.id)?.sleepCheckpointAt,
        } : {}),
        interactionPresence: metadata.get(record.id)?.characterId
          ? kernel.interactionService.get(
              record.id,
              interactionScopeForConversation(
                conversationSpace,
                metadata.get(record.id)!.characterId!,
              ),
            )?.presence
          : undefined,
        interactionLocation: metadata.get(record.id)?.characterId
          ? kernel.interactionService.get(
              record.id,
              interactionScopeForConversation(
                conversationSpace,
                metadata.get(record.id)!.characterId!,
              ),
            )?.location
          : undefined,
        messageCount: visibleConversationMessages(record.messages).length,
        preview: latestConversationPreview(record.messages),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
    });
    return;
  }

  const goalTodoTransitionMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals\/([^/]+)\/todos\/([^/]+)\/transition$/,
  );
  if (goalTodoTransitionMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["expectedGoalRevision", "expectedTodoRevision", "status", "note"],
      "Goal todo transition",
    );
    const goal = kernel.transitionSessionGoalTodo(
      decodeURIComponent(goalTodoTransitionMatch[1]),
      decodeURIComponent(goalTodoTransitionMatch[2]),
      decodeURIComponent(goalTodoTransitionMatch[3]),
      {
        expectedGoalRevision: requiredPositiveInteger(
          body.expectedGoalRevision,
          "expectedGoalRevision",
        ),
        expectedTodoRevision: requiredPositiveInteger(
          body.expectedTodoRevision,
          "expectedTodoRevision",
        ),
        status: requiredSessionGoalTodoStatus(body.status),
        ...(body.note === undefined
          ? {}
          : { note: requiredStringValue(body.note, "note") }),
      },
    );
    sendJson(input.response, 200, { goal });
    return;
  }

  const goalTodoMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals\/([^/]+)\/todos\/([^/]+)$/,
  );
  if (goalTodoMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      [
        "expectedGoalRevision",
        "expectedTodoRevision",
        "title",
        "notes",
        "transitionNote",
      ],
      "Goal todo update",
    );
    const goal = kernel.updateSessionGoalTodo(
      decodeURIComponent(goalTodoMatch[1]),
      decodeURIComponent(goalTodoMatch[2]),
      decodeURIComponent(goalTodoMatch[3]),
      {
        expectedGoalRevision: requiredPositiveInteger(
          body.expectedGoalRevision,
          "expectedGoalRevision",
        ),
        expectedTodoRevision: requiredPositiveInteger(
          body.expectedTodoRevision,
          "expectedTodoRevision",
        ),
        ...(body.title === undefined
          ? {}
          : { title: requiredStringValue(body.title, "title") }),
        ...(body.notes === undefined
          ? {}
          : { notes: requiredStringValue(body.notes, "notes", true) }),
        ...(body.transitionNote === undefined
          ? {}
          : { transitionNote: requiredStringValue(body.transitionNote, "transitionNote") }),
      },
    );
    sendJson(input.response, 200, { goal });
    return;
  }

  const goalTodosMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals\/([^/]+)\/todos$/,
  );
  if (goalTodosMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["expectedGoalRevision", "title", "notes"], "Goal todo");
    const goal = kernel.createSessionGoalTodo(
      decodeURIComponent(goalTodosMatch[1]),
      decodeURIComponent(goalTodosMatch[2]),
      {
        expectedGoalRevision: requiredPositiveInteger(
          body.expectedGoalRevision,
          "expectedGoalRevision",
        ),
        title: requiredStringValue(body.title, "title"),
        ...(body.notes === undefined
          ? {}
          : { notes: requiredStringValue(body.notes, "notes", true) }),
      },
    );
    sendJson(input.response, 201, { goal });
    return;
  }

  const goalDependenciesMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals\/([^/]+)\/dependencies$/,
  );
  if (goalDependenciesMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["expectedRevision", "dependencyGoalIds", "transitionNote"],
      "Goal dependencies",
    );
    const goal = kernel.setSessionGoalDependencies(
      decodeURIComponent(goalDependenciesMatch[1]),
      decodeURIComponent(goalDependenciesMatch[2]),
      {
        expectedRevision: requiredPositiveInteger(body.expectedRevision, "expectedRevision"),
        dependencyGoalIds: requiredExactStringArray(
          body.dependencyGoalIds,
          "dependencyGoalIds",
        ),
        ...(body.transitionNote === undefined
          ? {}
          : { transitionNote: requiredStringValue(body.transitionNote, "transitionNote") }),
      },
    );
    sendJson(input.response, 200, { goal });
    return;
  }

  const goalTransitionMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals\/([^/]+)\/transition$/,
  );
  if (goalTransitionMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["expectedRevision", "status", "note"], "Goal transition");
    const goal = kernel.transitionSessionGoal(
      decodeURIComponent(goalTransitionMatch[1]),
      decodeURIComponent(goalTransitionMatch[2]),
      {
        expectedRevision: requiredPositiveInteger(body.expectedRevision, "expectedRevision"),
        status: requiredSessionGoalStatus(body.status),
        ...(body.note === undefined
          ? {}
          : { note: requiredStringValue(body.note, "note") }),
      },
    );
    sendJson(input.response, 200, { goal });
    return;
  }

  const goalsMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/goals(?:\/([^/]+))?$/,
  );
  if (goalsMatch && method === "GET") {
    const parentSessionId = decodeURIComponent(goalsMatch[1]);
    if (goalsMatch[2] !== undefined) {
      const transitionLimit = optionalQueryInteger(
        url.searchParams.get("transitionLimit"),
        "transitionLimit",
        0,
      ) ?? 20;
      if (transitionLimit > 100) {
        throw new SyntaxError("transitionLimit must not exceed 100");
      }
      sendJson(input.response, 200, {
        goal: kernel.getSessionGoal(
          parentSessionId,
          decodeURIComponent(goalsMatch[2]),
          transitionLimit,
        ),
      });
      return;
    }
    const limit = optionalQueryInteger(url.searchParams.get("limit"), "limit", 1) ?? 20;
    if (limit > 100) throw new SyntaxError("limit must not exceed 100");
    sendJson(input.response, 200, {
      goals: kernel.listSessionGoals(parentSessionId, {
        limit,
        includeTerminal: optionalQueryBoolean(
          url.searchParams.get("includeTerminal"),
          "includeTerminal",
        ) ?? false,
      }),
    });
    return;
  }
  if (goalsMatch && method === "POST" && goalsMatch[2] === undefined) {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["title", "successCriteria", "plan", "notes", "priority", "dependencyGoalIds"],
      "Goal",
    );
    const goal = kernel.createSessionGoal(decodeURIComponent(goalsMatch[1]), {
      title: requiredStringValue(body.title, "title"),
      successCriteria: requiredStringValue(body.successCriteria, "successCriteria"),
      ...(body.plan === undefined
        ? {}
        : { plan: requiredStringValue(body.plan, "plan", true) }),
      ...(body.notes === undefined
        ? {}
        : { notes: requiredStringValue(body.notes, "notes", true) }),
      ...(body.priority === undefined
        ? {}
        : { priority: requiredSessionGoalPriority(body.priority) }),
      ...(body.dependencyGoalIds === undefined
        ? {}
        : {
            dependencyGoalIds: requiredExactStringArray(
              body.dependencyGoalIds,
              "dependencyGoalIds",
            ),
          }),
    });
    sendJson(input.response, 201, { goal });
    return;
  }
  if (goalsMatch && method === "PATCH" && goalsMatch[2] !== undefined) {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      [
        "expectedRevision",
        "title",
        "successCriteria",
        "plan",
        "notes",
        "priority",
        "transitionNote",
      ],
      "Goal update",
    );
    const goal = kernel.updateSessionGoal(
      decodeURIComponent(goalsMatch[1]),
      decodeURIComponent(goalsMatch[2]),
      {
        expectedRevision: requiredPositiveInteger(body.expectedRevision, "expectedRevision"),
        ...(body.title === undefined
          ? {}
          : { title: requiredStringValue(body.title, "title") }),
        ...(body.successCriteria === undefined
          ? {}
          : { successCriteria: requiredStringValue(body.successCriteria, "successCriteria") }),
        ...(body.plan === undefined
          ? {}
          : { plan: requiredStringValue(body.plan, "plan", true) }),
        ...(body.notes === undefined
          ? {}
          : { notes: requiredStringValue(body.notes, "notes", true) }),
        ...(body.priority === undefined
          ? {}
          : { priority: requiredSessionGoalPriority(body.priority) }),
        ...(body.transitionNote === undefined
          ? {}
          : { transitionNote: requiredStringValue(body.transitionNote, "transitionNote") }),
      },
    );
    sendJson(input.response, 200, { goal });
    return;
  }

  const workflowDecisionMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workflows\/([^/]+)\/nodes\/([^/]+)\/decision$/,
  );
  if (workflowDecisionMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["decision", "note"], "Workflow replay decision");
    const workflow = kernel.decideSessionWorkflowReplay(
      decodeURIComponent(workflowDecisionMatch[1]),
      decodeURIComponent(workflowDecisionMatch[2]),
      decodeURIComponent(workflowDecisionMatch[3]),
      requiredWorkflowReplayDecision(body.decision),
      requiredStringValue(body.note, "note"),
    );
    sendJson(input.response, 202, { workflow });
    return;
  }

  const workflowActionMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workflows\/([^/]+)\/(start|cancel)$/,
  );
  if (workflowActionMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const parentSessionId = decodeURIComponent(workflowActionMatch[1]);
    const workflowId = decodeURIComponent(workflowActionMatch[2]);
    const action = workflowActionMatch[3];
    if (action === "start") {
      assertOnlyKeys(body, ["expectedRevision"], "Workflow start");
      const workflow = kernel.startSessionWorkflow(
        parentSessionId,
        workflowId,
        requiredPositiveInteger(body.expectedRevision, "expectedRevision"),
      );
      sendJson(input.response, 202, { workflow });
      return;
    }
    assertOnlyKeys(body, ["expectedRevision", "note"], "Workflow cancellation");
    const workflow = kernel.cancelSessionWorkflow(
      parentSessionId,
      workflowId,
      requiredPositiveInteger(body.expectedRevision, "expectedRevision"),
      requiredStringValue(body.note, "note"),
    );
    sendJson(input.response, 202, { workflow });
    return;
  }

  const workflowsMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workflows(?:\/([^/]+))?$/,
  );
  if (workflowsMatch && method === "GET") {
    const parentSessionId = decodeURIComponent(workflowsMatch[1]);
    if (workflowsMatch[2] !== undefined) {
      const eventLimit = optionalQueryInteger(url.searchParams.get("eventLimit"), "eventLimit", 0);
      if (eventLimit !== undefined && eventLimit > 100) {
        throw new SyntaxError("eventLimit must not exceed 100");
      }
      sendJson(input.response, 200, {
        workflow: kernel.getSessionWorkflow(
          parentSessionId,
          decodeURIComponent(workflowsMatch[2]),
          eventLimit ?? 20,
        ),
      });
      return;
    }
    const limit = optionalQueryInteger(url.searchParams.get("limit"), "limit", 1) ?? 20;
    if (limit > 100) throw new SyntaxError("limit must not exceed 100");
    const includeTerminal = optionalQueryBoolean(
      url.searchParams.get("includeTerminal"),
      "includeTerminal",
    );
    sendJson(input.response, 200, {
      workflows: kernel.listSessionWorkflows(parentSessionId, {
        ...(includeTerminal === undefined ? {} : { includeTerminal }),
        limit,
      }),
    });
    return;
  }
  if (workflowsMatch && method === "POST" && workflowsMatch[2] === undefined) {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["title", "nodes", "maxConcurrency", "timeoutSeconds"],
      "Workflow request",
    );
    const workflow = kernel.createSessionWorkflow(
      decodeURIComponent(workflowsMatch[1]),
      {
        title: requiredStringValue(body.title, "title"),
        nodes: requiredWorkflowNodes(body.nodes),
        ...(body.maxConcurrency === undefined
          ? {}
          : {
              maxConcurrency: requiredPositiveInteger(
                body.maxConcurrency,
                "maxConcurrency",
              ),
            }),
        ...(body.timeoutSeconds === undefined
          ? {}
          : {
              timeoutSeconds: requiredPositiveInteger(
                body.timeoutSeconds,
                "timeoutSeconds",
              ),
            }),
      },
    );
    sendJson(input.response, 201, { workflow });
    return;
  }

  const executionJobRetryMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/execution-jobs\/([^/]+)\/retry$/,
  );
  if (executionJobRetryMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, [], "Execution job retry");
    const job = kernel.retryExecutionJob(
      decodeURIComponent(executionJobRetryMatch[1]),
      decodeURIComponent(executionJobRetryMatch[2]),
    );
    sendJson(input.response, 202, { job });
    return;
  }

  const executionJobInterruptMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/execution-jobs\/([^/]+)\/interrupt$/,
  );
  if (executionJobInterruptMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, [], "Execution job interruption");
    const job = await kernel.interruptExecutionJob(
      decodeURIComponent(executionJobInterruptMatch[1]),
      decodeURIComponent(executionJobInterruptMatch[2]),
    );
    sendJson(input.response, 200, { job });
    return;
  }

  const executionJobOutputMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/execution-jobs\/([^/]+)\/output$/,
  );
  if (executionJobOutputMatch && method === "GET") {
    const attempt = optionalQueryInteger(url.searchParams.get("attempt"), "attempt", 1);
    const cursor = optionalQueryInteger(url.searchParams.get("cursor"), "cursor", 0);
    const limitBytes = optionalQueryInteger(
      url.searchParams.get("limitBytes"),
      "limitBytes",
      4 * 1_024,
    );
    if (limitBytes !== undefined && limitBytes > maximumExecutionOutputPageBytes) {
      throw new SyntaxError(`limitBytes must not exceed ${maximumExecutionOutputPageBytes}`);
    }
    sendJson(input.response, 200, {
      output: kernel.getExecutionJobOutput(
        decodeURIComponent(executionJobOutputMatch[1]),
        decodeURIComponent(executionJobOutputMatch[2]),
        {
          ...(attempt === undefined ? {} : { attempt }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limitBytes === undefined ? {} : { limitBytes }),
        },
      ),
    });
    return;
  }

  const executionJobsMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/execution-jobs(?:\/([^/]+))?$/,
  );
  if (executionJobsMatch && method === "GET") {
    const parentSessionId = decodeURIComponent(executionJobsMatch[1]);
    if (executionJobsMatch[2] !== undefined) {
      sendJson(input.response, 200, {
        job: kernel.getExecutionJob(
          parentSessionId,
          decodeURIComponent(executionJobsMatch[2]),
        ),
      });
      return;
    }
    const limit = optionalQueryInteger(url.searchParams.get("limit"), "limit", 1) ?? 20;
    if (limit > 100) throw new SyntaxError("limit must not exceed 100");
    sendJson(input.response, 200, {
      jobs: kernel.listExecutionJobs(parentSessionId, limit),
    });
    return;
  }
  if (executionJobsMatch && method === "POST" && executionJobsMatch[2] === undefined) {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["command", "timeoutSeconds"], "Execution job request");
    const timeoutSeconds = body.timeoutSeconds === undefined
      ? undefined
      : requiredPositiveInteger(body.timeoutSeconds, "timeoutSeconds");
    const job = kernel.startExecutionJob(
      decodeURIComponent(executionJobsMatch[1]),
      {
        command: requiredExecutionCommand(body.command),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
    );
    sendJson(input.response, 202, { job });
    return;
  }

  const subagentJobRetryMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/subagent-jobs\/([^/]+)\/retry$/,
  );
  if (subagentJobRetryMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, [], "Subagent recovery retry");
    const job = kernel.retrySubagentJob(
      decodeURIComponent(subagentJobRetryMatch[1]),
      decodeURIComponent(subagentJobRetryMatch[2]),
    );
    sendJson(input.response, 202, { job });
    return;
  }

  const subagentJobInterruptMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/subagent-jobs\/([^/]+)\/interrupt$/,
  );
  if (subagentJobInterruptMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, [], "Subagent job interruption");
    const job = await kernel.interruptSubagentJob(
      decodeURIComponent(subagentJobInterruptMatch[1]),
      decodeURIComponent(subagentJobInterruptMatch[2]),
    );
    sendJson(input.response, 200, { job });
    return;
  }

  const subagentJobMessagesMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/subagent-jobs\/([^/]+)\/messages$/,
  );
  if (subagentJobMessagesMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["message", "timezone"], "Subagent follow-up request");
    const message = requiredString(body.message, "message");
    const timezone = body.timezone === undefined
      ? "Asia/Shanghai"
      : requiredStringValue(body.timezone, "timezone");
    if ([...message].length > 4_000) {
      throw new SyntaxError("message must contain at most 4000 characters");
    }
    if ([...timezone].length > 200) {
      throw new SyntaxError("timezone must contain at most 200 characters");
    }
    const job = kernel.sendSubagentMessage(
      decodeURIComponent(subagentJobMessagesMatch[1]),
      decodeURIComponent(subagentJobMessagesMatch[2]),
      message,
      timezone,
    );
    sendJson(input.response, 202, { job });
    return;
  }

  const subagentJobsMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/subagent-jobs(?:\/([^/]+))?$/,
  );
  if (subagentJobsMatch && method === "GET") {
    const parentSessionId = decodeURIComponent(subagentJobsMatch[1]);
    if (subagentJobsMatch[2] !== undefined) {
      sendJson(input.response, 200, {
        job: kernel.getSubagentJob(
          parentSessionId,
          decodeURIComponent(subagentJobsMatch[2]),
        ),
      });
      return;
    }
    const limit = optionalPositiveInteger(url.searchParams.get("limit")) ?? 20;
    if (limit > 100) throw new SyntaxError("limit must not exceed 100");
    sendJson(input.response, 200, {
      jobs: kernel.listSubagentJobs(parentSessionId, limit),
    });
    return;
  }
  if (subagentJobsMatch && method === "POST" && subagentJobsMatch[2] === undefined) {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["role", "task", "context", "timezone"], "Subagent job request");
    const task = requiredString(body.task, "task");
    const context = body.context === undefined
      ? undefined
      : requiredStringValue(body.context, "context", true);
    const timezone = body.timezone === undefined
      ? "Asia/Shanghai"
      : requiredStringValue(body.timezone, "timezone");
    if ([...task].length > 4_000) throw new SyntaxError("task must contain at most 4000 characters");
    if (context !== undefined && [...context].length > 8_000) {
      throw new SyntaxError("context must contain at most 8000 characters");
    }
    if ([...timezone].length > 200) {
      throw new SyntaxError("timezone must contain at most 200 characters");
    }
    const job = kernel.startSubagentJob(
      decodeURIComponent(subagentJobsMatch[1]),
      {
        role: requiredSubagentRole(body.role ?? "worker"),
        task,
        ...(context === undefined ? {} : { context }),
      },
      timezone,
    );
    sendJson(input.response, 202, { job });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/conversation-unread") {
    const conversationSpace = requestedConversationSpace(url);
    sendJson(input.response, 200, {
      conversations: kernel.listUnreadConversations(
        conversationSpace,
        requestedConversationCharacterId(url, conversationSpace),
      ),
    });
    return;
  }

  if (method === "POST" && pathname === "/api/v1/direct-conversations") {
    const body = asRecord(await readJson(input.request));
    const session = await kernel.openCanonicalPrivateConversation(
      requiredString(body.characterId, "characterId"),
      requiredConversationSpace(body.conversationSpace ?? "normal"),
    );
    sendJson(input.response, 200, { session });
    return;
  }

  if (pathname === "/api/v1/incognito-conversations") {
    if (method === "GET") {
      sendJson(input.response, 200, { conversations: kernel.listIncognitoConversations() });
      return;
    }
    if (method === "POST") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      const conversation = await kernel.openIncognitoConversation(
        requiredString(body.characterId, "characterId"),
      );
      sendJson(input.response, 201, { conversation });
      return;
    }
  }

  const incognitoConversationMatch = pathname.match(
    /^\/api\/v1\/incognito-conversations\/([^/]+)$/,
  );
  if (incognitoConversationMatch && method === "DELETE") {
    assertLocalControlPlaneMutation(input.request);
    await kernel.closeIncognitoConversation(decodeURIComponent(incognitoConversationMatch[1]));
    input.response.writeHead(204, { "cache-control": "no-store" });
    input.response.end();
    return;
  }

  if (method === "POST" && pathname === "/api/v1/sessions/batch") {
    const body = asRecord(await readJson(input.request));
    const conversationSpace = requiredConversationSpace(body.conversationSpace ?? "normal");
    const conversationCharacterId = requiredSecretConversationCharacterId(body, conversationSpace);
    const action = body.action;
    const rawSessionIds = body.sessionIds;
    if (action !== "archive" && action !== "delete") {
      throw new SessionBatchValidationError("action must be archive or delete");
    }
    if (!Array.isArray(rawSessionIds) || rawSessionIds.length === 0 || rawSessionIds.length > 100) {
      throw new SessionBatchValidationError("sessionIds must contain between 1 and 100 session ids");
    }
    if (rawSessionIds.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new SessionBatchValidationError("every session id must be a non-empty string");
    }
    const sessionIds = [...new Set(rawSessionIds.map((entry) => entry.trim()))];
    if (sessionIds.length !== rawSessionIds.length) {
      throw new SessionBatchValidationError("sessionIds must not contain duplicates");
    }
    const metadata = new Map(kernel.listConversationMetadata().map((entry) => [entry.id, entry]));
    const missing = sessionIds.filter((sessionId) =>
      !metadata.has(sessionId) || metadata.get(sessionId)?.conversationSpace !== conversationSpace ||
      (conversationCharacterId !== undefined && metadata.get(sessionId)?.characterId !== conversationCharacterId)
    );
    if (missing.length) throw new ConversationNotFoundError(missing[0]);

    if (action === "archive") {
      const sessions = sessionIds.map((sessionId) => kernel.archiveConversation(sessionId));
      sendJson(input.response, 200, { action, count: sessions.length, sessions });
      return;
    }

    const expectedConfirmation = `永久删除 ${sessionIds.length} 个会话`;
    if (body.confirmation !== expectedConfirmation) throw new ConversationDeletionConfirmationError();
    for (const sessionId of sessionIds) {
      const session = metadata.get(sessionId);
      kernel.assertConversationDeletable(sessionId, session?.title || sessionId);
    }
    const deletions = [];
    for (const sessionId of sessionIds) {
      const session = metadata.get(sessionId);
      deletions.push(await kernel.deleteConversation(sessionId, session?.title || sessionId));
    }
    sendJson(input.response, 200, { action, count: deletions.length, deletions });
    return;
  }

  if (method === "POST" && pathname === "/api/v1/conversations/batch") {
    const body = asRecord(await readJson(input.request));
    const conversationSpace = requiredConversationSpace(body.conversationSpace ?? "normal");
    const conversationCharacterId = requiredSecretConversationCharacterId(body, conversationSpace);
    const action = body.action;
    if (action !== "archive" && action !== "delete") {
      throw new SessionBatchValidationError("action must be archive or delete");
    }
    const sessionIds = requireBatchIds(body.sessionIds, "sessionIds");
    const groupIds = requireBatchIds(body.groupIds, "groupIds");
    if (conversationSpace === "secret" && groupIds.length) {
      throw new SessionBatchValidationError(
        "secret conversation batches cannot include group chats",
      );
    }
    const total = sessionIds.length + groupIds.length;
    if (total < 1 || total > 100) {
      throw new SessionBatchValidationError("batch must contain between 1 and 100 conversations");
    }
    const metadata = new Map(kernel.listConversationMetadata().map((entry) => [entry.id, entry]));
    const groups = new Map(kernel.listGroupChats(true).map((entry) => [entry.id, entry]));
    const missingSession = sessionIds.find((sessionId) =>
      !metadata.has(sessionId) || metadata.get(sessionId)?.conversationSpace !== conversationSpace ||
      (conversationCharacterId !== undefined && metadata.get(sessionId)?.characterId !== conversationCharacterId)
    );
    if (missingSession) throw new ConversationNotFoundError(missingSession);
    const missingGroup = groupIds.find((groupId) => !groups.has(groupId));
    if (missingGroup) throw new GroupChatNotFoundError(missingGroup);

    if (action === "archive") {
      const sessions = sessionIds.map((sessionId) => kernel.archiveConversation(sessionId));
      const groupChats = groupIds.map((groupId) => kernel.archiveGroupChat(groupId));
      sendJson(input.response, 200, { action, count: total, sessions, groups: groupChats });
      return;
    }

    if (body.confirmation !== `永久删除 ${total} 个会话`) {
      throw new ConversationDeletionConfirmationError();
    }
    for (const sessionId of sessionIds) {
      const session = metadata.get(sessionId);
      kernel.assertConversationDeletable(sessionId, session?.title || sessionId);
    }
    const sessionDeletions = [];
    for (const sessionId of sessionIds) {
      const session = metadata.get(sessionId);
      sessionDeletions.push(await kernel.deleteConversation(sessionId, session?.title || sessionId));
    }
    const groupDeletions = groupIds.map((groupId) => kernel.deleteGroupChat(groupId));
    sendJson(input.response, 200, {
      action,
      count: total,
      deletions: { sessions: sessionDeletions, groups: groupDeletions },
    });
    return;
  }

  const archiveSessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/archive$/);
  if (archiveSessionMatch && method === "POST") {
    const sessionId = decodeURIComponent(archiveSessionMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    const session = kernel.archiveConversation(sessionId);
    sendJson(input.response, 200, { session });
    return;
  }

  const restoreSessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/restore$/);
  if (restoreSessionMatch && method === "POST") {
    const sessionId = decodeURIComponent(restoreSessionMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    const session = kernel.restoreConversation(sessionId);
    sendJson(input.response, 200, { session });
    return;
  }

  const readSessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/read$/);
  if (readSessionMatch && method === "POST") {
    const sessionId = decodeURIComponent(readSessionMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    sendJson(input.response, 200, kernel.markConversationRead(sessionId));
    return;
  }

  const sessionMetadataMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (sessionMetadataMatch && method === "PATCH") {
    const body = asRecord(await readJson(input.request));
    const sessionId = decodeURIComponent(sessionMetadataMatch[1]);
    assertSessionConversationSpace(
      kernel,
      sessionId,
      requiredConversationSpace(body.conversationSpace ?? "normal"),
      requiredSecretConversationCharacterId(
        body,
        requiredConversationSpace(body.conversationSpace ?? "normal"),
      ),
    );
    const title = typeof body.title === "string" ? body.title : "";
    const session = kernel.renameConversation(sessionId, title);
    sendJson(input.response, 200, { session });
    return;
  }
  if (sessionMetadataMatch && method === "DELETE") {
    const body = asRecord(await readJson(input.request));
    const sessionId = decodeURIComponent(sessionMetadataMatch[1]);
    assertSessionConversationSpace(
      kernel,
      sessionId,
      requiredConversationSpace(body.conversationSpace ?? "normal"),
      requiredSecretConversationCharacterId(
        body,
        requiredConversationSpace(body.conversationSpace ?? "normal"),
      ),
    );
    const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
    sendJson(
      input.response,
      200,
      await kernel.deleteConversation(sessionId, confirmation),
    );
    return;
  }

  const interactionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/interaction$/);
  if (interactionMatch) {
    const sessionId = decodeURIComponent(interactionMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    assertCharacterBoundSession(kernel, sessionId);
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getConversationInteraction(sessionId));
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      const action = requiredInteractionAction(body.action);
      sendJson(input.response, 200, await kernel.transitionConversationInteraction(sessionId, {
        action,
        ...(optionalString(body.placeId) ? { placeId: optionalString(body.placeId) } : {}),
        ...(optionalString(body.location) ? { location: optionalString(body.location) } : {}),
        ...(optionalString(body.note) ? { note: optionalString(body.note) } : {}),
        ...(optionalString(body.summary) ? { summary: optionalString(body.summary) } : {}),
        ...(body.userConfirmed === undefined ? {} : { userConfirmed: requiredBoolean(body.userConfirmed, "userConfirmed") }),
      }));
      return;
    }
  }

  const contextBudgetMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/context-budget$/);
  if (contextBudgetMatch && method === "GET") {
    const sessionId = decodeURIComponent(contextBudgetMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    assertCharacterBoundSession(kernel, sessionId);
    sendJson(input.response, 200, { budget: await kernel.getConversationContextBudget(sessionId) });
    return;
  }

  const compactContextMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/compact$/);
  if (compactContextMatch && method === "POST") {
    const sessionId = decodeURIComponent(compactContextMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    assertCharacterBoundSession(kernel, sessionId);
    sendJson(input.response, 200, { result: await kernel.compactConversationContext(sessionId) });
    return;
  }

  if (pathname === "/api/v1/group-chats") {
    if (method === "GET") {
      sendJson(input.response, 200, {
        groups: kernel.listGroupChats(url.searchParams.get("includeArchived") === "1"),
      });
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 201, {
        group: kernel.createGroupChat({
          title: optionalString(body.title),
          mode: body.mode === undefined ? undefined : requiredMode(body.mode),
          characterIds: optionalStringArray(body.characterIds),
          maxSpeakers: body.maxSpeakers === undefined ? undefined : requiredNumber(body.maxSpeakers, "maxSpeakers"),
        }),
      });
      return;
    }
  }

  const groupChatMatch = pathname.match(/^\/api\/v1\/group-chats\/([^/]+)$/);
  if (groupChatMatch && method === "GET") {
    sendJson(input.response, 200, { group: kernel.getGroupChat(decodeURIComponent(groupChatMatch[1])) });
    return;
  }
  if (groupChatMatch && method === "DELETE") {
    const groupId = decodeURIComponent(groupChatMatch[1]);
    const group = kernel.getGroupChat(groupId);
    const body = asRecord(await readJson(input.request));
    if (body.confirmation !== `永久删除 ${group.title}`) {
      throw new ConversationDeletionConfirmationError();
    }
    sendJson(input.response, 200, kernel.deleteGroupChat(groupId));
    return;
  }

  const groupLifecycleMatch = pathname.match(/^\/api\/v1\/group-chats\/([^/]+)\/(archive|restore)$/);
  if (groupLifecycleMatch && method === "POST") {
    const groupId = decodeURIComponent(groupLifecycleMatch[1]);
    const group = groupLifecycleMatch[2] === "archive"
      ? kernel.archiveGroupChat(groupId)
      : kernel.restoreGroupChat(groupId);
    sendJson(input.response, 200, { group });
    return;
  }

  const historySearchMatch = pathname.match(/^\/api\/v1\/(sessions|group-chats|worlds)\/([^/]+)\/(?:conversation\/)?messages\/search$/);
  if (historySearchMatch && method === "GET") {
    const id = decodeURIComponent(historySearchMatch[2]);
    const query = messageHistoryQuery(url, 20);
    if (query.after || query.around) throw new HistoryQueryError("搜索结果仅支持向前翻页");
    const text = url.searchParams.get("q") ?? "";
    if (historySearchMatch[1] === "sessions") {
      assertRequestedSessionConversationSpace(kernel, id, url);
      sendJson(input.response, 200, await kernel.getMessageHistory(id, query, text));
    } else {
      sendJson(input.response, 200, kernel.getSharedMessageHistory(historySearchMatch[1] === "worlds" ? "world" : "group", id, query, text));
    }
    return;
  }

  const groupMessagesMatch = pathname.match(/^\/api\/v1\/group-chats\/([^/]+)\/messages$/);
  if (groupMessagesMatch && method === "GET") {
    if (url.searchParams.get("paged") === "1") {
      sendJson(input.response, 200, kernel.getSharedMessageHistory("group", decodeURIComponent(groupMessagesMatch[1]), messageHistoryQuery(url)));
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? "200");
    sendJson(input.response, 200, {
      messages: kernel.listGroupChatMessages(decodeURIComponent(groupMessagesMatch[1]), limit),
    });
    return;
  }
  if (groupMessagesMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, await kernel.sendGroupMessage(
      decodeURIComponent(groupMessagesMatch[1]),
      requiredString(body.text, "text"),
      optionalString(body.timezone) ?? "Asia/Shanghai",
    ));
    return;
  }

  const groupStreamMatch = pathname.match(/^\/api\/v1\/group-chats\/([^/]+)\/messages\/stream$/);
  if (groupStreamMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const abortController = new AbortController();
    input.response.on("close", () => {
      if (!input.response.writableEnded) abortController.abort();
    });
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    input.response.write(": connected\n\n");
    try {
      const result = await kernel.sendGroupMessage(
        decodeURIComponent(groupStreamMatch[1]),
        requiredString(body.text, "text"),
        optionalString(body.timezone) ?? "Asia/Shanghai",
        (event) => sendStreamEvent(input.response, event),
        abortController.signal,
      );
      sendStreamEvent(input.response, { type: "done", response: result });
    } catch (error) {
      sendStreamEvent(input.response, {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      input.response.end();
    }
    return;
  }

  const privateInboxMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/inbox$/);
  if (privateInboxMatch && method === "POST") {
    const sessionId = decodeURIComponent(privateInboxMatch[1]);
    const rawBody = asRecord(await readJson(input.request));
    const body = requireCharacterBoundMessage(kernel, sessionId, rawBody);
    const message = await kernel.enqueuePrivateMessage(
      sessionId,
      body,
      requiredString(rawBody.clientMessageId, "clientMessageId"),
    );
    sendJson(input.response, 202, {
      message,
      inbox: kernel.privateInboxSnapshot(message.sessionId),
    });
    return;
  }

  if (privateInboxMatch && method === "GET") {
    const sessionId = decodeURIComponent(privateInboxMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    sendJson(
      input.response,
      200,
      kernel.privateInboxSnapshot(sessionId),
    );
    return;
  }

  const privateInboxTypingMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/inbox\/typing$/,
  );
  if (privateInboxTypingMatch && method === "POST") {
    const sessionId = decodeURIComponent(privateInboxTypingMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    sendJson(
      input.response,
      200,
      kernel.notePrivateInboxTyping(sessionId),
    );
    return;
  }

  const privateInboxMessageMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/inbox\/([^/]+)$/,
  );
  if (privateInboxMessageMatch && method === "PATCH") {
    const sessionId = decodeURIComponent(privateInboxMessageMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    const body = asRecord(await readJson(input.request));
    const message = kernel.updateQueuedPrivateMessage(
      sessionId,
      decodeURIComponent(privateInboxMessageMatch[2]),
      {
        text: requiredString(body.text, "text"),
        ...(body.attachments === undefined
          ? {}
          : { attachments: requireMessageAttachments(body.attachments) }),
      },
    );
    sendJson(input.response, 200, { message });
    return;
  }

  if (privateInboxMessageMatch && method === "DELETE") {
    const sessionId = decodeURIComponent(privateInboxMessageMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    const message = kernel.retractQueuedPrivateMessage(
      sessionId,
      decodeURIComponent(privateInboxMessageMatch[2]),
    );
    sendJson(input.response, 200, { message });
    return;
  }

  const privateInboxEventsMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/inbox\/events$/,
  );
  if (privateInboxEventsMatch && method === "GET") {
    const sessionId = decodeURIComponent(privateInboxEventsMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    kernel.privateInboxSnapshot(sessionId);
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    input.response.write(": connected\n\n");
    const unsubscribe = kernel.subscribePrivateInbox(sessionId, (event) => {
      const payload = privateInboxEventPayload(event);
      if (payload) sendStreamEvent(input.response, payload);
    });
    sendStreamEvent(input.response, {
      type: "snapshot",
      inbox: kernel.privateInboxSnapshot(sessionId),
    });
    const heartbeat = setInterval(() => {
      if (!input.response.destroyed && !input.response.writableEnded) {
        input.response.write(": heartbeat\n\n");
      }
    }, 15_000);
    heartbeat.unref?.();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!input.response.writableEnded) input.response.end();
    };
    input.request.once("aborted", close);
    input.response.once("close", close);
    return;
  }

  const messageMatch = pathname.match(/^\/api(?:\/v1)?\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && method === "POST") {
    const sessionId = decodeURIComponent(messageMatch[1]);
    const body = requireCharacterBoundMessage(kernel, sessionId, await readJson(input.request));
    if (kernel.isIncognitoConversation(sessionId) && body.attachments?.length) {
      throw new IncognitoOperationUnsupportedError("message attachments");
    }
    const targetSessionId = await kernel.resolveConversationTarget(sessionId, body);
    const result = await kernel.sendMessage(targetSessionId, body);
    sendJson(input.response, 200, { ...result, sessionId: targetSessionId });
    return;
  }

  if (messageMatch && method === "GET") {
    const sessionId = decodeURIComponent(messageMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    if (url.searchParams.get("paged") === "1") {
      sendJson(input.response, 200, await kernel.getMessageHistory(sessionId, messageHistoryQuery(url)));
      return;
    }
    const messages = await kernel.getConversationTranscript(sessionId);
    sendJson(input.response, 200, visibleConversationMessages(messages));
    return;
  }

  const sessionCollaborationsMatch =
    pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/character-collaborations$/);
  if (sessionCollaborationsMatch && method === "GET") {
    const sessionId = decodeURIComponent(sessionCollaborationsMatch[1]);
    const conversationSpace = assertRequestedSessionConversationSpace(kernel, sessionId, url);
    assertCharacterBoundSession(kernel, sessionId);
    sendJson(input.response, 200, {
      collaborations: conversationSpace === "secret"
        ? []
        : kernel.listSessionCharacterCollaborations(
            sessionId,
            optionalPositiveInteger(url.searchParams.get("limit")) ?? 100,
          ),
    });
    return;
  }

  const reviseMessageMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/(edit|retract)$/);
  if (reviseMessageMatch && method === "POST") {
    const sessionId = decodeURIComponent(reviseMessageMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    const entryId = decodeURIComponent(reviseMessageMatch[2]);
    if (reviseMessageMatch[3] === "edit") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, await kernel.editLatestUserMessage(
        sessionId,
        entryId,
        requiredString(body.text, "text"),
      ));
    } else {
      sendJson(input.response, 200, await kernel.retractLatestUserMessage(sessionId, entryId));
    }
    return;
  }

  const streamMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/stream$/);
  if (streamMatch && method === "POST") {
    const sessionId = decodeURIComponent(streamMatch[1]);
    const body = requireCharacterBoundMessage(kernel, sessionId, await readJson(input.request));
    if (kernel.isIncognitoConversation(sessionId) && body.attachments?.length) {
      throw new IncognitoOperationUnsupportedError("message attachments");
    }
    const targetSessionId = await kernel.resolveConversationTarget(sessionId, body);
    const abortController = new AbortController();
    input.response.on("close", () => {
      if (!input.response.writableEnded) abortController.abort();
    });
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-rp-session-id": targetSessionId,
    });
    input.response.write(": connected\n\n");
    try {
      const result = await kernel.streamMessage(
        targetSessionId,
        body,
        (event) => {
          const payload = streamEventPayload(event);
          if (payload) sendStreamEvent(input.response, payload);
        },
        abortController.signal,
      );
      sendStreamEvent(input.response, {
        type: "done",
        response: { ...result, sessionId: targetSessionId },
      });
    } catch (error) {
      sendStreamEvent(input.response, {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      input.response.end();
    }
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/cancel$/);
  if (cancelMatch && method === "POST") {
    const sessionId = decodeURIComponent(cancelMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    sendJson(input.response, 200, {
      cancelled: await kernel.cancelMessage(sessionId),
    });
    return;
  }

  const retryMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/retry$/);
  if (retryMatch && method === "POST") {
    const sessionId = decodeURIComponent(retryMatch[1]);
    assertRequestedSessionConversationSpace(kernel, sessionId, url);
    assertCharacterBoundSession(kernel, sessionId);
    sendJson(input.response, 200, await kernel.retryLastMessage(sessionId));
    return;
  }

  if (pathname === "/api/v1/schedule-items") {
    if (method === "GET") {
      const ownerType = optionalScheduleOwnerType(url.searchParams.get("ownerType"));
      const characterId = optionalString(url.searchParams.get("characterId"));
      if (ownerType === "character" && !characterId) throw new SyntaxError("characterId is required for character schedules");
      if (ownerType === "user" && characterId) throw new SyntaxError("user schedules cannot include characterId");
      const items = kernel.listScheduleItems({
        from: optionalString(url.searchParams.get("from")),
        to: optionalString(url.searchParams.get("to")),
        status: optionalScheduleStatus(url.searchParams.get("status")),
        kind: optionalScheduleKind(url.searchParams.get("kind")),
        ownerType,
        characterId,
        query: optionalString(url.searchParams.get("query")),
      });
      sendJson(input.response, 200, {
        items: items.map((item) => ({
          ...item,
          occurrences: kernel.listReminderOccurrences(item.id),
          notifications: kernel.listNotificationHistory(item.id),
        })),
      });
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      const ownerType = body.ownerType === "character" ? "character" : "user";
      const characterId = optionalString(body.characterId);
      if (ownerType === "character" && (!characterId || !kernel.listCharacters().some((entry) => entry.id === characterId))) {
        throw new SyntaxError("a valid characterId is required for character schedules");
      }
      if (ownerType === "user" && characterId) throw new SyntaxError("user schedules cannot include characterId");
      const idempotencyHeader = input.request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      const result = kernel.createScheduleItem({
        ...(body as CreateScheduleItemInput),
        ownerType,
        characterId,
        timezone: optionalString(body.timezone) ?? "Asia/Shanghai",
        idempotencyKey: idempotencyKey || optionalString(body.idempotencyKey),
      });
      sendJson(input.response, 201, result);
      return;
    }
  }

  const scheduleItemMatch = pathname.match(/^\/api\/v1\/schedule-items\/([^/]+)$/);
  if (scheduleItemMatch) {
    const id = decodeURIComponent(scheduleItemMatch[1]);
    if (method === "GET") {
      sendJson(input.response, 200, {
        item: kernel.getScheduleItem(id),
        occurrences: kernel.listReminderOccurrences(id),
      });
      return;
    }
    if (method === "PATCH") {
      const result = kernel.updateScheduleItem(id, (await readJson(input.request)) as UpdateScheduleItemInput);
      sendJson(input.response, 200, result);
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, { item: kernel.cancelScheduleItem(id) });
      return;
    }
  }

  const completeMatch = pathname.match(/^\/api\/v1\/schedule-items\/([^/]+)\/complete$/);
  if (completeMatch && method === "POST") {
    sendJson(input.response, 200, {
      item: kernel.completeScheduleItem(decodeURIComponent(completeMatch[1])),
    });
    return;
  }

  const occurrencesMatch = pathname.match(/^\/api\/v1\/schedule-items\/([^/]+)\/occurrences$/);
  if (occurrencesMatch && method === "GET") {
    sendJson(input.response, 200, {
      occurrences: kernel.listReminderOccurrences(decodeURIComponent(occurrencesMatch[1])),
    });
    return;
  }

  if (pathname === "/api/v1/usage" && method === "GET") {
    const configured = kernel.store.getModelApiConfig();
    sendJson(input.response, 200, kernel.usageService.summary(
      url.searchParams.get("month") ?? undefined,
      { provider: configured.provider, model: configured.model },
    ));
    return;
  }

  if (pathname === "/api/v1/usage/settings" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const patch: { monthlyBudgetYuan?: number | null; priceOverrides?: Record<string, ModelPrice> } = {};
    if ("monthlyBudgetYuan" in body) {
      const raw = body.monthlyBudgetYuan;
      patch.monthlyBudgetYuan = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    }
    if ("priceOverrides" in body) {
      patch.priceOverrides = sanitizePriceOverrides(body.priceOverrides);
    }
    sendJson(input.response, 200, kernel.usageService.saveSettings(patch));
    return;
  }

  const reminderAckMatch = pathname.match(/^\/api\/v1\/reminder-occurrences\/([^/]+)\/acknowledge$/);
  if (reminderAckMatch && method === "POST") {
    sendJson(input.response,200,{ occurrence: kernel.acknowledgeReminder(decodeURIComponent(reminderAckMatch[1])) }); return;
  }
  if (pathname === "/api/v1/reminder-inbox" && method === "GET") {
    sendJson(input.response,200,{ reminders: kernel.reminderInbox() }); return;
  }
  const snoozeMatch = pathname.match(/^\/api\/v1\/reminder-occurrences\/([^/]+)\/snooze$/);
  if (snoozeMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      occurrence: kernel.snoozeReminder(
        decodeURIComponent(snoozeMatch[1]),
        requiredNumber(body.minutes, "minutes"),
      ),
    });
    return;
  }

  if (pathname === "/api/v1/notifications" && method === "GET") {
    sendJson(input.response, 200, { notifications: kernel.listNotificationHistory() });
    return;
  }

  if (pathname === "/api/v1/agent-modules" && method === "GET") {
    sendJson(input.response, 200, { modules: kernel.listAgentModules() });
    return;
  }

  const moduleProviderSettingsMatch = pathname.match(
    /^\/api\/v1\/agent-modules\/([^/]+)\/settings$/,
  );
  if (moduleProviderSettingsMatch && method === "GET") {
    sendJson(input.response, 200, {
      settings: kernel.getAgentModuleProviderSettings(
        decodeURIComponent(moduleProviderSettingsMatch[1]),
      ),
    });
    return;
  }
  if (moduleProviderSettingsMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["expectedSchemaVersion", "expectedRevision", "values", "clear"],
      "Agent module settings update",
    );
    sendJson(input.response, 200, {
      settings: kernel.patchAgentModuleProviderSettings(
        decodeURIComponent(moduleProviderSettingsMatch[1]),
        {
          expectedSchemaVersion: requiredPositiveInteger(
            body.expectedSchemaVersion,
            "expectedSchemaVersion",
          ),
          expectedRevision: requiredNonNegativeInteger(
            body.expectedRevision,
            "expectedRevision",
          ),
          ...(body.values === undefined ? {} : { values: asRecord(body.values) }),
          ...(body.clear === undefined
            ? {}
            : { clear: requiredExactStringArray(body.clear, "clear") }),
        },
      ),
    });
    return;
  }

  if (pathname === "/api/v1/agent-runtime/configuration" && method === "GET") {
    sendJson(input.response, 200, { configuration: kernel.getAgentRuntimeConfiguration() });
    return;
  }

  if (pathname === "/api/v1/agent-runtime/profile" && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["profileId"], "Agent runtime profile activation");
    sendJson(input.response, 200, {
      configuration: kernel.activateAgentRuntimeProfile(
        requiredString(body.profileId, "profileId"),
      ),
    });
    return;
  }

  if (pathname === "/api/v1/subagent-settings") {
    if (method === "GET") {
      sendJson(input.response, 200, { settings: kernel.getSubagentSettings() });
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(
        body,
        [
          "expectedRevision",
          "maxConcurrentTasks",
          "maxWorkModelCalls",
          "maxOutputTokens",
          "maxResultCharacters",
          "timeoutSeconds",
        ],
        "Subagent settings update",
      );
      const patch: SubagentSettingsPatch = {};
      for (const key of [
        "maxConcurrentTasks",
        "maxWorkModelCalls",
        "maxOutputTokens",
        "maxResultCharacters",
        "timeoutSeconds",
      ] as const) {
        if (body[key] !== undefined) patch[key] = requiredNumber(body[key], key);
      }
      sendJson(input.response, 200, {
        settings: kernel.patchSubagentSettings(
          patch,
          requiredNumber(body.expectedRevision, "expectedRevision"),
        ),
      });
      return;
    }
  }

  if (pathname === "/api/v1/agent-skills/install/preview" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const stage = await kernel.stageAgentSkillInstall({
      sourceUrl: requiredString(body.sourceUrl, "sourceUrl"),
      ...(optionalString(body.packagePath) ? { packagePath: optionalString(body.packagePath) } : {}),
      ...(optionalString(body.expectedSha256)
        ? { expectedSha256: optionalString(body.expectedSha256) }
        : {}),
    });
    sendJson(input.response, 201, { stage: agentSkillStageView(stage) });
    return;
  }

  if (pathname === "/api/v1/agent-skills/install/confirm" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const installed = await kernel.confirmAgentSkillInstall({
      stageId: requiredString(body.stageId, "stageId"),
      digest: requiredString(body.sha256, "sha256"),
      enabledSpaces: requiredConversationSpaces(body.enabledSpaces),
    });
    sendJson(input.response, 201, { installed });
    return;
  }

  const skillInstallStageMatch = pathname.match(
    /^\/api\/v1\/agent-skills\/install\/stages\/([^/]+)$/,
  );
  if (skillInstallStageMatch && method === "DELETE") {
    assertLocalControlPlaneMutation(input.request);
    const stageId = requiredString(decodeURIComponent(skillInstallStageMatch[1]), "stageId");
    sendJson(input.response, 200, {
      cancelled: kernel.cancelAgentSkillInstall(stageId),
    });
    return;
  }

  if (pathname === "/api/v1/agent-permissions") {
    if (method === "GET") {
      sendJson(input.response, 200, { permissions: kernel.getAgentPermissions() });
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      const patch: AgentPermissionsPatch = {};
      if (body.workspaceAccess !== undefined) {
        patch.workspaceAccess = requiredWorkspaceAccess(body.workspaceAccess);
      }
      for (const key of [
        "shellEnabled",
        "networkEnabled",
        "userProfileWriteEnabled",
        "characterSoulWriteEnabled",
        "characterSkillManageEnabled",
        "realityMemoryWriteEnabled",
        "characterMemoryWriteEnabled",
      ] as const) {
        if (body[key] !== undefined) patch[key] = requiredBoolean(body[key], key);
      }
      sendJson(input.response, 200, { permissions: kernel.patchAgentPermissions(patch) });
      return;
    }
  }

  const moduleMatch = pathname.match(/^\/api\/v1\/agent-modules\/([^/]+)$/);
  if (moduleMatch && method === "GET") {
    const conversationSpace = requestedConversationSpace(url);
    requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      detail: kernel.getAgentModuleDetail(
        decodeURIComponent(moduleMatch[1]),
        conversationSpace,
      ),
    });
    return;
  }

  const sessionWorkspaceUploadMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workspace\/files\/upload$/,
  );
  if (sessionWorkspaceUploadMatch && method === "POST") {
    const sessionId = decodeURIComponent(sessionWorkspaceUploadMatch[1]);
    assertSessionWorkspaceScope(kernel, sessionId, url);
    const name = requiredString(url.searchParams.get("name"), "name");
    const directory = optionalString(url.searchParams.get("directory")) ?? "uploads";
    const bytes = await readBinary(input.request, MAX_WORKSPACE_UPLOAD_BYTES);
    sendJson(input.response, 201, {
      entry: kernel.uploadSessionWorkspaceFile(sessionId, { directory, name, bytes }),
    });
    return;
  }

  const sessionWorkspacePreviewMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workspace\/files\/preview$/,
  );
  if (sessionWorkspacePreviewMatch && method === "GET") {
    const sessionId = decodeURIComponent(sessionWorkspacePreviewMatch[1]);
    const conversationSpace = assertSessionWorkspaceScope(kernel, sessionId, url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    const path = requiredString(url.searchParams.get("path"), "path");
    const preview = kernel.previewSessionWorkspaceFile(sessionId, path);
    sendJson(input.response, 200, {
      preview: preview.kind === "image" || preview.kind === "pdf"
        ? {
            ...preview,
            url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/files/content` +
              `?path=${encodeURIComponent(path)}&disposition=inline` +
              `&conversationSpace=${conversationSpace}` +
              (secretOwnerCharacterId
                ? `&characterId=${encodeURIComponent(secretOwnerCharacterId)}`
                : ""),
          }
        : preview,
    });
    return;
  }

  const sessionWorkspaceContentMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workspace\/files\/content$/,
  );
  if (sessionWorkspaceContentMatch && method === "GET") {
    const sessionId = decodeURIComponent(sessionWorkspaceContentMatch[1]);
    assertSessionWorkspaceScope(kernel, sessionId, url);
    const path = requiredString(url.searchParams.get("path"), "path");
    const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    await sendWorkspaceFile(
      input.response,
      kernel.getSessionWorkspaceFileAsset(sessionId, path, disposition),
    );
    return;
  }

  const sessionWorkspaceFilesMatch = pathname.match(
    /^\/api\/v1\/sessions\/([^/]+)\/workspace\/files$/,
  );
  if (sessionWorkspaceFilesMatch) {
    const sessionId = decodeURIComponent(sessionWorkspaceFilesMatch[1]);
    assertSessionWorkspaceScope(kernel, sessionId, url);
    if (method === "GET") {
      sendJson(
        input.response,
        200,
        kernel.listSessionWorkspaceFiles(sessionId, optionalString(url.searchParams.get("path"))),
      );
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        entry: kernel.moveSessionWorkspaceFile(
          sessionId,
          requiredString(body.from, "from"),
          requiredString(body.to, "to"),
        ),
      });
      return;
    }
    if (method === "DELETE") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        deleted: kernel.deleteSessionWorkspaceFile(
          sessionId,
          requiredString(body.path, "path"),
        ),
      });
      return;
    }
  }

  if (pathname === "/api/v1/workspace/files/upload" && method === "POST") {
    const name = requiredString(url.searchParams.get("name"), "name");
    const directory = optionalString(url.searchParams.get("directory")) ?? "uploads";
    const bytes = await readBinary(input.request, MAX_WORKSPACE_UPLOAD_BYTES);
    sendJson(input.response, 201, {
      entry: kernel.uploadWorkspaceFile({ directory, name, bytes }),
    });
    return;
  }

  if (pathname === "/api/v1/workspace/files/preview" && method === "GET") {
    const path = requiredString(url.searchParams.get("path"), "path");
    const preview = kernel.previewWorkspaceFile(path);
    sendJson(input.response, 200, {
      preview: preview.kind === "image" || preview.kind === "pdf"
        ? {
            ...preview,
            url: `/api/v1/workspace/files/content?path=${encodeURIComponent(path)}&disposition=inline`,
          }
        : preview,
    });
    return;
  }

  if (pathname === "/api/v1/workspace/files/content" && method === "GET") {
    const path = requiredString(url.searchParams.get("path"), "path");
    const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    await sendWorkspaceFile(input.response, kernel.getWorkspaceFileAsset(path, disposition));
    return;
  }

  if (pathname === "/api/v1/workspace/files") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.listWorkspaceFiles(optionalString(url.searchParams.get("path"))));
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        entry: kernel.moveWorkspaceFile(requiredString(body.from, "from"), requiredString(body.to, "to")),
      });
      return;
    }
    if (method === "DELETE") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        deleted: kernel.deleteWorkspaceFile(requiredString(body.path, "path")),
      });
      return;
    }
  }
  if (moduleMatch && method === "PATCH") {
    const moduleId = decodeURIComponent(moduleMatch[1]);
    const targetModule = kernel.listAgentModules().find((module) => module.id === moduleId);
    if (targetModule?.type === "skill" || moduleId === mineruMcpModuleId || moduleId === gitMcpModuleId) {
      assertLocalControlPlaneMutation(input.request);
    }
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      module: body.enabledSpaces === undefined
        ? kernel.setAgentModuleEnabled(
            moduleId,
            requiredBoolean(body.enabled, "enabled"),
          )
        : kernel.setAgentSkillEnabledSpaces(
            moduleId,
            requiredConversationSpaces(body.enabledSpaces),
          ),
    });
    return;
  }

  if (pathname === "/api/v1/user-profile") {
    if (method === "GET") {
      const profile = kernel.getUserProfile();
      sendJson(input.response, 200, {
        profile,
        manualMarkdown: profileManualSection(profile.markdown),
        avatarUrl: avatarUrl("/api/v1/avatars/user", kernel.getUserAvatar()),
      });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      if (typeof body.markdown !== "string") throw new Error("markdown must be a string");
      const profile = kernel.updateUserProfileManual(body.markdown);
      sendJson(input.response, 200, {
        profile,
        manualMarkdown: profileManualSection(profile.markdown),
      });
      return;
    }
  }

  if (pathname === "/api/v1/user-insights" && method === "GET") {
    sendJson(input.response, 200, {
      insights: kernel.getUserInsightStatus(
        optionalPositiveInteger(url.searchParams.get("limit")) ?? 30,
      ),
    });
    return;
  }

  const userInsightControlMatch = pathname.match(
    /^\/api\/v1\/user-insights\/([^/]+)\/(confirm|reject|unlock)$/,
  );
  if (userInsightControlMatch && method === "POST") {
    const id = decodeURIComponent(userInsightControlMatch[1]);
    const action = userInsightControlMatch[2];
    const observation = action === "confirm"
      ? kernel.confirmUserInsight(id)
      : action === "reject" ? kernel.rejectUserInsight(id) : kernel.unlockUserInsight(id);
    sendJson(input.response, 200, {
      observation,
      insights: kernel.getUserInsightStatus(50),
    });
    return;
  }

  if (pathname === "/api/v1/system-prompts") {
    if (method === "GET") {
      sendJson(input.response, 200, { prompts: kernel.getSystemPrompts() });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        prompt: kernel.updateSystemPrompt(requiredMode(body.mode), requiredString(body.custom, "custom")),
      });
      return;
    }
  }

  if (pathname === "/api/v1/memory-vault/status" && method === "GET") {
    sendJson(input.response, 200, { vault: kernel.getMemoryVaultStatus() });
    return;
  }

  if (pathname === "/api/v1/runtime-events/health" && method === "GET") {
    sendJson(input.response, 200, { health: kernel.getRuntimeEventHealth() });
    return;
  }

  if (pathname === "/api/v1/memory-vault/health" && method === "GET") {
    sendJson(input.response, 200, { health: kernel.getMemoryVaultHealth() });
    return;
  }

  if (pathname === "/api/v1/memory-vault/recovery" && method === "GET") {
    const health = kernel.getMemoryVaultHealth();
    sendJson(input.response, 200, {
      recovery: {
        writer: health.writer,
        journal: health.journal,
        startupRecoveryCount: health.startupRecoveryCount,
        projectionConsistent: health.projectionConsistent,
        vaultHash: health.vaultHash,
        projectionHash: health.projectionHash,
      },
    });
    return;
  }

  if (pathname === "/api/v1/memory-vault/history" && method === "GET") {
    const requestedLimit = url.searchParams.get("limit");
    const limit = requestedLimit === null ? 30 : Number(requestedLimit);
    sendJson(input.response, 200, {
      checkpoints: kernel.listMemoryVaultHistory(limit),
      history: kernel.getMemoryVaultHealth().history,
    });
    return;
  }

  if (pathname === "/api/v1/memory-vault/history/restore" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    if (body.confirm !== "RESTORE_MEMORY_VAULT") {
      sendJson(input.response, 400, { error: "confirm must equal RESTORE_MEMORY_VAULT" });
      return;
    }
    sendJson(input.response, 200, {
      result: kernel.restoreMemoryVaultHistory(requiredString(body.commitId, "commitId")),
      vault: kernel.getMemoryVaultStatus(),
    });
    return;
  }

  if (pathname === "/api/v1/memory-coordinator/status" && method === "GET") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      coordinator: kernel.getMemoryCoordinatorStatus(
        conversationSpace,
        secretOwnerCharacterId,
      ),
    });
    return;
  }

  if (pathname === "/api/v1/relationship-coordinator/status" && method === "GET") {
    sendJson(input.response, 200, { coordinator: kernel.getRelationshipCoordinatorStatus() });
    return;
  }

  if (pathname === "/api/v1/post-turn-coordinator/status" && method === "GET") {
    sendJson(input.response, 200, { coordinator: kernel.getPostTurnCoordinatorStatus() });
    return;
  }

  if (pathname === "/api/v1/memory-coordinator/memories" && method === "GET") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    const stats = new Map(kernel.memoryRetrievalStats(
      conversationSpace,
      secretOwnerCharacterId,
    ).map((entry) => [entry.memoryId, entry]));
    sendJson(input.response, 200, {
      memories: kernel.listMemories({
        conversationSpace,
        ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
        realm: optionalMemoryRealm(url.searchParams.get("realm")),
        ...(conversationSpace === "normal"
          ? { characterId: optionalString(url.searchParams.get("characterId")) }
          : {}),
        limit: optionalPositiveInteger(url.searchParams.get("limit")) ?? 100,
      }).map((memory) => ({
        ...memory,
        core: memory.salience >= 0.85 || memory.tags.includes("core"),
        hitCount: stats.get(memory.id)?.hitCount ?? 0,
        lastHitAt: stats.get(memory.id)?.lastHitAt ?? null,
      })),
    });
    return;
  }

  if (pathname === "/api/v1/person-profiles" && method === "GET") {
    const conversationSpace = requestedConversationSpace(url);
    requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      profiles: conversationSpace === "normal" ? kernel.listPersonProfiles() : [],
    });
    return;
  }

  const personProfileMatch = pathname.match(/^\/api\/v1\/person-profiles\/([^/]+)$/);
  if (personProfileMatch && method === "PATCH") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      profile: kernel.updatePersonProfile(decodeURIComponent(personProfileMatch[1]), {
        ...(body.displayName === undefined ? {} : { displayName: requiredString(body.displayName, "displayName") }),
        ...(body.aliases === undefined ? {} : { aliases: optionalStringArray(body.aliases) }),
        ...(body.relationship === undefined ? {} : {
          relationship: optionalNullableString(body.relationship, "relationship"),
        }),
        ...(body.visibility === undefined ? {} : { visibility: requiredPersonVisibility(body.visibility) }),
        ...(body.visibleToCharacterIds === undefined ? {} : {
          visibleToCharacterIds: optionalStringArray(body.visibleToCharacterIds),
        }),
        ...(body.markdown === undefined ? {} : { markdown: optionalDocumentString(body.markdown, "markdown")! }),
      }),
    });
    return;
  }

  if (
    method === "GET" &&
    (pathname === "/api/v1/context-plan/preview" || pathname === "/api/v1/memory-retrieval/preview")
  ) {
    const mode = requiredMode(url.searchParams.get("mode"));
    const sessionId = requiredString(url.searchParams.get("sessionId"), "sessionId");
    if (kernel.isIncognitoConversation(sessionId)) {
      throw new IncognitoOperationUnsupportedError("context-plan preview");
    }
    const conversationSpace = requestedConversationSpace(url);
    const metadata = kernel.getConversationMetadata(sessionId);
    if (metadata) {
      assertRequestedSessionConversationSpace(kernel, sessionId, url);
    } else if (conversationSpace === "secret") {
      throw new ConversationNotFoundError(sessionId);
    }
    const requestedCharacterId = optionalString(url.searchParams.get("characterId"));
    if (metadata?.characterId && requestedCharacterId && metadata.characterId !== requestedCharacterId) {
      throw new ConversationNotFoundError(sessionId);
    }
    const characterId = metadata?.characterId ?? requestedCharacterId;
    const plan = kernel.previewContextPlan({
      mode,
      sessionId,
      conversationSpace,
      ...(characterId ? { characterId } : {}),
      query: url.searchParams.get("query") ?? "",
      timezone: optionalString(url.searchParams.get("timezone")) ?? "Asia/Shanghai",
      budgets: contextPlannerBudgets(url.searchParams),
      allowBootstrap: url.searchParams.get("bootstrap") !== "0",
    });
    sendJson(input.response, 200, pathname.includes("memory-retrieval")
      ? { retrieval: plan.retrieval, selectedMemoryIds: plan.selectedMemoryIds, budgets: plan.budgets }
      : { plan });
    return;
  }

  const memoryJobRetryMatch = pathname.match(/^\/api\/v1\/memory-coordinator\/jobs\/([^/]+)\/retry$/);
  if (memoryJobRetryMatch && method === "POST") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      job: kernel.retryMemoryExtractionJob(
        decodeURIComponent(memoryJobRetryMatch[1]),
        conversationSpace,
        secretOwnerCharacterId,
      ),
    });
    return;
  }

  const relationshipJobRetryMatch = pathname.match(/^\/api\/v1\/relationship-coordinator\/jobs\/([^/]+)\/retry$/);
  if (relationshipJobRetryMatch && method === "POST") {
    sendJson(input.response, 200, {
      job: kernel.retryRelationshipExtractionJob(decodeURIComponent(relationshipJobRetryMatch[1])),
    });
    return;
  }

  const postTurnJobRetryMatch = pathname.match(/^\/api\/v1\/post-turn-coordinator\/jobs\/([^/]+)\/retry$/);
  if (postTurnJobRetryMatch && method === "POST") {
    sendJson(input.response, 200, {
      job: kernel.retryPostTurnAnalysisJob(decodeURIComponent(postTurnJobRetryMatch[1])),
    });
    return;
  }

  if (pathname === "/api/v1/memory-vault/documents" && method === "GET") {
    sendJson(input.response, 200, { documents: kernel.listMemoryVaultDocuments() });
    return;
  }

  if (pathname === "/api/v1/memory-vault/okf/export" && method === "GET") {
    const result = kernel.exportOkfBundle({
      includeProfile: url.searchParams.get("includeProfile") === "1",
      includeSouls: url.searchParams.get("includeSouls") === "1",
      includeScenes: url.searchParams.get("includeScenes") === "1",
    });
    input.response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": result.bytes.byteLength,
      "content-disposition": `attachment; filename=${result.filename}`,
      "cache-control": "no-store",
      "x-okf-version": "0.1",
      "x-okf-concept-count": String(result.conceptCount),
    });
    input.response.end(result.bytes);
    return;
  }

  if (
    (pathname === "/api/v1/memory-vault/okf/import/preview" ||
      pathname === "/api/v1/memory-vault/okf/import/stage") && method === "POST"
  ) {
    const bytes = await readBinary(input.request, MAX_OKF_ARCHIVE_BYTES);
    const target = {
      realm: requiredOkfImportRealm(url.searchParams.get("realm")),
      ...(optionalString(url.searchParams.get("characterId"))
        ? { characterId: optionalString(url.searchParams.get("characterId")) }
        : {}),
    };
    if (pathname.endsWith("/preview")) {
      sendJson(input.response, 200, { preview: kernel.previewOkfImport(bytes, target) });
    } else {
      const result = kernel.stageOkfImport(bytes, target);
      sendJson(input.response, 201, { preview: result.preview, staged: result.staged });
    }
    return;
  }

  if (pathname === "/api/v1/memory-vault/sync" && method === "POST") {
    sendJson(input.response, 200, {
      result: kernel.syncMemoryVault(),
      vault: kernel.getMemoryVaultStatus(),
    });
    return;
  }

  if (pathname === "/api/v1/memory-vault/rebuild" && method === "POST") {
    sendJson(input.response, 200, {
      result: kernel.rebuildMemoryVaultIndex(),
      vault: kernel.getMemoryVaultStatus(),
    });
    return;
  }

  if (pathname === "/api/v1/memory-vault/migration/dry-run" && method === "POST") {
    sendJson(input.response, 200, { manifest: kernel.dryRunMemoryVaultMigration() });
    return;
  }

  if (pathname === "/api/v1/memory-vault/migration/apply" && method === "POST") {
    sendJson(input.response, 200, {
      manifest: kernel.applyMemoryVaultMigration(),
      vault: kernel.getMemoryVaultStatus(),
    });
    return;
  }

  const notificationRetryMatch = pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/retry$/);
  if (notificationRetryMatch && method === "POST") {
    sendJson(input.response, 200, {
      notification: kernel.retryNotification(decodeURIComponent(notificationRetryMatch[1])),
    });
    return;
  }

  if (pathname === "/api/v1/worlds") {
    if (method === "GET") {
      const includeArchived = url.searchParams.get("includeArchived") === "1";
      sendJson(input.response, 200, {
        worlds: kernel.listWorlds(includeArchived),
        ...(url.searchParams.get("includeMap") === "1"
          ? { maps: kernel.listWorldMapSnapshots(includeArchived) }
          : {}),
      });
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      const world = kernel.createWorld({
        name: requiredString(body.name, "name"),
        timezone: optionalString(body.timezone),
        description: optionalDocumentString(body.description, "description"),
        rulesMarkdown: optionalDocumentString(body.rulesMarkdown, "rulesMarkdown"),
        directorModelProfileId: optionalString(body.directorModelProfileId),
        analystModelProfileId: optionalString(body.analystModelProfileId),
      } satisfies CreateWorldInput);
      sendJson(input.response, 201, { world });
      return;
    }
  }

  if (pathname === "/api/v1/world-conversations" && method === "GET") {
    sendJson(input.response, 200, { conversations: kernel.listWorldConversations() });
    return;
  }

  if (pathname === "/api/v1/character-channels" && method === "GET") {
    sendJson(input.response, 200, {
      channels: kernel.listCharacterChannels({
        ...(url.searchParams.get("worldId") ? { worldId: url.searchParams.get("worldId")! } : {}),
        ...(url.searchParams.get("characterId") ? { characterId: url.searchParams.get("characterId")! } : {}),
        limit: Number(url.searchParams.get("limit") ?? "100"),
      }),
    });
    return;
  }

  if (pathname === "/api/v1/character-channels/exchanges" && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const kind = requiredString(body.kind, "kind");
    const sourceCharacterId = requiredString(body.sourceCharacterId, "sourceCharacterId");
    const targetCharacterId = optionalString(body.targetCharacterId);
    const clientRequestId = requiredString(body.clientRequestId, "clientRequestId");
    const idempotencyKey = `character-channel-http:${kind}:${clientRequestId}`;
    if (kind === "message") {
      sendJson(input.response, 200, await kernel.sendCharacterChannelMessage({
        sourceCharacterId,
        targetCharacterId: requiredString(targetCharacterId, "targetCharacterId"),
        message: requiredString(body.message, "message"),
        idempotencyKey,
        source: "manual",
      }));
      return;
    }
    if (kind === "collaboration") {
      sendJson(input.response, 200, await kernel.requestCharacterCollaboration({
        sourceCharacterId,
        ...(targetCharacterId ? { targetCharacterId } : {}),
        ...(body.requiredSkillIds === undefined
          ? {}
          : {
              requiredSkillIds: optionalStringArray(body.requiredSkillIds),
            }),
        task: requiredString(body.task, "task"),
        ...(optionalString(body.context) ? { context: optionalString(body.context) } : {}),
        ...(optionalString(body.message) ? { message: optionalString(body.message) } : {}),
        idempotencyKey,
      }));
      return;
    }
    if (kind === "social") {
      sendJson(input.response, 200, await kernel.startCharacterSocialExchange({
        sourceCharacterId,
        targetCharacterId: requiredString(targetCharacterId, "targetCharacterId"),
        ...(optionalString(body.topic) ? { topic: optionalString(body.topic) } : {}),
        idempotencyKey,
      }));
      return;
    }
    throw new WorldValidationError("character channel exchange kind must be message, collaboration, or social");
  }

  const characterChannelReadMatch = pathname.match(/^\/api\/v1\/character-channels\/([^/]+)\/read$/);
  if (characterChannelReadMatch && method === "POST") {
    sendJson(input.response, 200, {
      channel: kernel.markCharacterChannelRead(decodeURIComponent(characterChannelReadMatch[1])),
    });
    return;
  }

  const characterChannelMatch = pathname.match(/^\/api\/v1\/character-channels\/([^/]+)$/);
  if (characterChannelMatch && method === "GET") {
    sendJson(input.response, 200, {
      snapshot: kernel.getCharacterChannel(
        decodeURIComponent(characterChannelMatch[1]),
        optionalPositiveInteger(url.searchParams.get("messageLimit")) ?? 120,
        optionalPositiveInteger(url.searchParams.get("episodeLimit")) ?? 40,
        optionalString(url.searchParams.get("focusEpisodeId")),
      ),
    });
    return;
  }

  const worldConversationMatch = pathname.match(/^\/api\/v1\/worlds\/([^/]+)\/conversation$/);
  if (worldConversationMatch && method === "GET") {
    sendJson(input.response, 200, {
      conversation: kernel.getWorldConversation(decodeURIComponent(worldConversationMatch[1])),
    });
    return;
  }
  if (worldConversationMatch && method === "DELETE") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      reset: await kernel.resetWorldConversation(
        decodeURIComponent(worldConversationMatch[1]),
        optionalString(body.confirmation) ?? "",
      ),
    });
    return;
  }

  const worldConversationMessagesMatch = pathname.match(
    /^\/api\/v1\/worlds\/([^/]+)\/conversation\/messages$/,
  );
  if (worldConversationMessagesMatch && method === "GET") {
    if (url.searchParams.get("paged") === "1") {
      sendJson(input.response, 200, kernel.getSharedMessageHistory("world", decodeURIComponent(worldConversationMessagesMatch[1]), messageHistoryQuery(url)));
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? "200");
    sendJson(input.response, 200, {
      messages: kernel.listWorldConversationMessages(
        decodeURIComponent(worldConversationMessagesMatch[1]),
        limit,
      ),
    });
    return;
  }
  if (worldConversationMessagesMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, await kernel.sendWorldMessage(
      decodeURIComponent(worldConversationMessagesMatch[1]),
      optionalString(body.text) ?? "",
      optionalString(body.timezone) ?? "Asia/Shanghai",
      requireMessageAttachments(body.attachments),
    ));
    return;
  }

  const worldConversationStreamMatch = pathname.match(
    /^\/api\/v1\/worlds\/([^/]+)\/conversation\/messages\/stream$/,
  );
  if (worldConversationStreamMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const abortController = new AbortController();
    input.response.on("close", () => {
      if (!input.response.writableEnded) abortController.abort();
    });
    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    input.response.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      if (!input.response.destroyed && !input.response.writableEnded) {
        input.response.write(": heartbeat\n\n");
      }
    }, 15_000);
    heartbeat.unref?.();
    try {
      const result = await kernel.sendWorldMessage(
        decodeURIComponent(worldConversationStreamMatch[1]),
        optionalString(body.text) ?? "",
        optionalString(body.timezone) ?? "Asia/Shanghai",
        requireMessageAttachments(body.attachments),
        (event) => sendStreamEvent(input.response, event),
        abortController.signal,
      );
      sendStreamEvent(input.response, { type: "done", response: result });
    } catch (error) {
      sendStreamEvent(input.response, {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(heartbeat);
      input.response.end();
    }
    return;
  }

  const worldConversationReadMatch = pathname.match(
    /^\/api\/v1\/worlds\/([^/]+)\/conversation\/read$/,
  );
  if (worldConversationReadMatch && method === "POST") {
    sendJson(input.response, 200, {
      conversation: kernel.markWorldConversationRead(decodeURIComponent(worldConversationReadMatch[1])),
    });
    return;
  }

  const worldStoryEventMatch = pathname.match(
    /^\/api\/v1\/worlds\/([^/]+)\/conversation\/event$/,
  );
  if (worldStoryEventMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const action = requiredWorldStoryAction(body.action);
    const worldId = decodeURIComponent(worldStoryEventMatch[1]);
    const event = action === "undo"
      ? kernel.undoWorldStoryEvent(worldId)
      : kernel.transitionWorldStoryEvent(worldId, {
          action,
          source: "user_control",
          ...(optionalString(body.title) ? { title: optionalString(body.title) } : {}),
          ...(optionalString(body.summary) ? { summary: optionalString(body.summary) } : {}),
          ...(optionalString(body.objective) ? { objective: optionalString(body.objective) } : {}),
          ...(optionalString(body.placeId) ? { placeId: optionalString(body.placeId) } : {}),
          participantIds: optionalStringArray(body.participantIds),
        });
    sendJson(input.response, 200, { event, conversation: kernel.getWorldConversation(worldId) });
    return;
  }

  const worldPlacesMatch = pathname.match(/^\/api\/v1\/worlds\/([^/]+)\/places$/);
  if (worldPlacesMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    const place = kernel.createWorldPlace({
      worldId: decodeURIComponent(worldPlacesMatch[1]),
      name: requiredString(body.name, "name"),
      description: optionalDocumentString(body.description, "description"),
      capabilityIds: body.capabilityIds === undefined
        ? undefined
        : optionalStringArray(body.capabilityIds) as WorldCapabilityId[],
    } satisfies CreatePlaceInput);
    sendJson(input.response, 201, { place });
    return;
  }
  const worldAttributesMatch = pathname.match(/^\/api\/v1\/worlds\/([^/]+)\/attributes$/);
  if (worldAttributesMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const attribute = kernel.createWorldAttribute({
      worldId: decodeURIComponent(worldAttributesMatch[1]),
      key: requiredString(body.key, "key"),
      name: requiredString(body.name, "name"),
      scope: body.scope === undefined ? undefined : requiredWorldAttributeScope(body.scope),
      description: optionalDocumentString(body.description, "description"),
      minValue: requiredNumber(body.minValue, "minValue"),
      maxValue: requiredNumber(body.maxValue, "maxValue"),
      defaultValue: requiredNumber(body.defaultValue, "defaultValue"),
      analysisEnabled: body.analysisEnabled === undefined
        ? undefined
        : requiredBoolean(body.analysisEnabled, "analysisEnabled"),
      increaseRule: body.increaseRule === undefined
        ? undefined
        : optionalDocumentString(body.increaseRule, "increaseRule"),
      increaseDelta: body.increaseDelta === undefined
        ? undefined
        : requiredNumber(body.increaseDelta, "increaseDelta"),
      decreaseRule: body.decreaseRule === undefined
        ? undefined
        : optionalDocumentString(body.decreaseRule, "decreaseRule"),
      decreaseDelta: body.decreaseDelta === undefined
        ? undefined
        : requiredNumber(body.decreaseDelta, "decreaseDelta"),
      visibleToAgent: body.visibleToAgent === undefined
        ? undefined
        : requiredBoolean(body.visibleToAgent, "visibleToAgent"),
    } satisfies CreateWorldAttributeDefinitionInput);
    sendJson(input.response, 201, { attribute });
    return;
  }
  if (worldAttributesMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const rawValues = asRecord(body.values);
    const values = Object.fromEntries(Object.entries(rawValues).map(([key, value]) => [
      key,
      requiredNumber(value, `values.${key}`),
    ]));
    sendJson(input.response, 200, {
      worldAttributes: kernel.updateWorldSharedAttributes(
        decodeURIComponent(worldAttributesMatch[1]),
        values,
      ),
    });
    return;
  }

  const worldMatch = pathname.match(/^\/api\/v1\/worlds\/([^/]+)$/);
  if (worldMatch) {
    const id = decodeURIComponent(worldMatch[1]);
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getWorld(id));
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      const patch: UpdateWorldInput = {
        ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
        ...(body.timezone === undefined ? {} : { timezone: requiredString(body.timezone, "timezone") }),
        ...(body.description === undefined ? {} : { description: optionalDocumentString(body.description, "description")! }),
        ...(body.rulesMarkdown === undefined ? {} : { rulesMarkdown: optionalDocumentString(body.rulesMarkdown, "rulesMarkdown")! }),
        ...(body.directorModelProfileId === undefined
          ? {}
          : { directorModelProfileId: optionalString(body.directorModelProfileId) ?? null }),
        ...(body.analystModelProfileId === undefined
          ? {}
          : { analystModelProfileId: optionalString(body.analystModelProfileId) ?? null }),
        ...(body.status === undefined ? {} : { status: requiredString(body.status, "status") as UpdateWorldInput["status"] }),
      };
      sendJson(input.response, 200, { world: kernel.updateWorld(id, patch) });
      return;
    }
    if (method === "DELETE") {
      const body = asRecord(await readJson(input.request));
      const world = kernel.getWorld(id).world;
      const confirmation = requiredString(body.confirmation, "confirmation");
      if (confirmation !== world.id && confirmation !== world.name) {
        throw new WorldValidationError("world deletion requires the exact world name or id");
      }
      sendJson(input.response, 200, { deleted: kernel.deleteWorld(id) });
      return;
    }
  }

  const worldPlaceMatch = pathname.match(/^\/api\/v1\/world-places\/([^/]+)$/);
  if (worldPlaceMatch) {
    const id = decodeURIComponent(worldPlaceMatch[1]);
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      const patch: UpdatePlaceInput = {
        ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
        ...(body.description === undefined ? {} : { description: optionalDocumentString(body.description, "description")! }),
        ...(body.capabilityIds === undefined
          ? {}
          : { capabilityIds: optionalStringArray(body.capabilityIds) as WorldCapabilityId[] }),
      };
      sendJson(input.response, 200, { place: kernel.updateWorldPlace(id, patch) });
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, { deleted: kernel.deleteWorldPlace(id) });
      return;
    }
  }

  const worldAttributeMatch = pathname.match(/^\/api\/v1\/world-attributes\/([^/]+)$/);
  if (worldAttributeMatch) {
    const id = decodeURIComponent(worldAttributeMatch[1]);
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      if (body.scope !== undefined) {
        const requestedScope = requiredWorldAttributeScope(body.scope);
        if (requestedScope !== kernel.worldService.getAttributeDefinition(id).scope) {
          throw new WorldValidationError("world attribute scope is immutable");
        }
      }
      const patch: UpdateWorldAttributeDefinitionInput = {
        ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
        ...(body.description === undefined
          ? {}
          : { description: optionalDocumentString(body.description, "description")! }),
        ...(body.minValue === undefined ? {} : { minValue: requiredNumber(body.minValue, "minValue") }),
        ...(body.maxValue === undefined ? {} : { maxValue: requiredNumber(body.maxValue, "maxValue") }),
        ...(body.defaultValue === undefined
          ? {}
          : { defaultValue: requiredNumber(body.defaultValue, "defaultValue") }),
        ...(body.analysisEnabled === undefined
          ? {}
          : { analysisEnabled: requiredBoolean(body.analysisEnabled, "analysisEnabled") }),
        ...(body.increaseRule === undefined
          ? {}
          : { increaseRule: optionalDocumentString(body.increaseRule, "increaseRule")! }),
        ...(body.increaseDelta === undefined
          ? {}
          : { increaseDelta: requiredNumber(body.increaseDelta, "increaseDelta") }),
        ...(body.decreaseRule === undefined
          ? {}
          : { decreaseRule: optionalDocumentString(body.decreaseRule, "decreaseRule")! }),
        ...(body.decreaseDelta === undefined
          ? {}
          : { decreaseDelta: requiredNumber(body.decreaseDelta, "decreaseDelta") }),
        ...(body.visibleToAgent === undefined
          ? {}
          : { visibleToAgent: requiredBoolean(body.visibleToAgent, "visibleToAgent") }),
      };
      sendJson(input.response, 200, { attribute: kernel.updateWorldAttribute(id, patch) });
      return;
    }
    if (method === "DELETE") {
      assertLocalControlPlaneMutation(input.request);
      await readJson(input.request);
      sendJson(input.response, 200, { attribute: kernel.archiveWorldAttribute(id) });
      return;
    }
  }

  if (pathname === "/api/v1/world-autonomy/tick" && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      result: await kernel.tickWorldAutonomy(optionalString(body.characterId)),
    });
    return;
  }

  if (pathname === "/api/v1/proactive-messages" && method === "GET") {
    const sessionId = optionalString(url.searchParams.get("sessionId"));
    const conversationSpace = requestedConversationSpace(url);
    requestedConversationCharacterId(url, conversationSpace);
    if (sessionId) assertRequestedSessionConversationSpace(kernel, sessionId, url);
    sendJson(input.response, 200, {
      messages: conversationSpace === "secret"
        ? []
        : kernel.listProactiveMessages({
            characterId: optionalString(url.searchParams.get("characterId")),
            sessionId,
            status: optionalProactiveMessageStatus(url.searchParams.get("status")),
            unreadOnly: url.searchParams.get("unreadOnly") === "1",
            limit: optionalPositiveInteger(url.searchParams.get("limit")) ?? 100,
          }),
    });
    return;
  }

  if (pathname === "/api/v1/proactive-messages/read" && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      read: kernel.markProactiveMessagesRead(requiredString(body.sessionId, "sessionId")),
    });
    return;
  }

  const proactiveFeedbackMatch = pathname.match(/^\/api\/v1\/proactive-messages\/([^/]+)\/feedback$/);
  if (proactiveFeedbackMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, kernel.recordProactiveMessageFeedback(
      decodeURIComponent(proactiveFeedbackMatch[1]),
      requiredString(body.feedbackType, "feedbackType") as ProactiveFeedbackType,
    ));
    return;
  }

  if (pathname === "/api/v1/avatars/user") {
    if (method === "GET") {
      const avatar = kernel.getUserAvatar();
      if (!avatar) {
        sendJson(input.response, 404, { code: "AVATAR_NOT_FOUND", error: "User avatar not found" });
      } else {
        sendAvatar(input.response, avatar);
      }
      return;
    }
    if (method === "PUT") {
      const body = asRecord(await readJson(input.request));
      const avatar = kernel.updateUserAvatar(requiredString(body.dataUrl, "dataUrl"));
      sendJson(input.response, 200, { avatarUrl: avatarUrl(pathname, avatar) });
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, { deleted: kernel.deleteUserAvatar() });
      return;
    }
  }

  const characterAvatarMatch = pathname.match(/^\/api\/v1\/avatars\/characters\/([^/]+)$/);
  if (characterAvatarMatch) {
    const id = decodeURIComponent(characterAvatarMatch[1]);
    if (method === "GET") {
      const avatar = kernel.getCharacterAvatar(id);
      if (!avatar) {
        sendJson(input.response, 404, { code: "AVATAR_NOT_FOUND", error: "Character avatar not found" });
      } else {
        sendAvatar(input.response, avatar);
      }
      return;
    }
    if (method === "PUT") {
      const body = asRecord(await readJson(input.request));
      const avatar = kernel.updateCharacterAvatar(id, requiredString(body.dataUrl, "dataUrl"));
      sendJson(input.response, 200, { avatarUrl: avatarUrl(pathname, avatar) });
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, { deleted: kernel.deleteCharacterAvatar(id) });
      return;
    }
  }

  if (pathname === "/api/v1/characters") {
    if (method === "GET") {
      sendJson(input.response, 200, {
        characters: kernel.listCharacters().map((character) => withCharacterAvatar(kernel, character)),
      });
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      const character = kernel.createCharacter({
        ...(body as CreateCharacterInput),
        name: requiredString(body.name, "name"),
        soulMarkdown: optionalDocumentString(body.soulMarkdown, "soulMarkdown"),
        modelProfileId: optionalNullableString(body.modelProfileId, "modelProfileId"),
        meetingPresetId: optionalNullableString(body.meetingPresetId, "meetingPresetId"),
        boundaries: optionalStringArray(body.boundaries),
      });
      sendJson(input.response, 201, { character: withCharacterAvatar(kernel, character) });
      return;
    }
  }

  if (pathname === "/api/v1/meeting-presets") {
    if (method === "GET") {
      sendJson(input.response, 200, { presets: kernel.listMeetingPresets() });
      return;
    }
  }

  if (pathname === "/api/v1/meeting-presets/import" && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 201, {
      preset: kernel.importMeetingPreset({
        name: requiredString(body.name, "name"),
        source: body.source,
        ...(body.promptOrderCharacterId === undefined
          ? {}
          : {
              promptOrderCharacterId:
                typeof body.promptOrderCharacterId === "number"
                  ? body.promptOrderCharacterId
                  : requiredString(body.promptOrderCharacterId, "promptOrderCharacterId"),
            }),
        ...(body.requiredSkillIds === undefined
          ? {}
          : { requiredSkillIds: optionalStringArray(body.requiredSkillIds) }),
      }),
    });
    return;
  }

  const meetingPresetMatch = pathname.match(/^\/api\/v1\/meeting-presets\/([^/]+)$/);
  if (meetingPresetMatch) {
    const id = decodeURIComponent(meetingPresetMatch[1]);
    if (method === "GET") {
      sendJson(input.response, 200, { preset: kernel.getMeetingPreset(id) });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      const patch: UpdateMeetingPresetInput = {
        ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
        ...(body.parametersEnabled === undefined
          ? {}
          : {
              parametersEnabled: requiredBoolean(
                body.parametersEnabled,
                "parametersEnabled",
              ),
            }),
        ...(body.parameters === undefined
          ? {}
          : { parameters: requiredMeetingPresetParameters(body.parameters) }),
        ...(body.prompts === undefined
          ? {}
          : {
              prompts: requiredMeetingPresetPromptPatches(body.prompts),
            }),
      };
      sendJson(input.response, 200, {
        preset: kernel.updateMeetingPreset(id, patch),
      });
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, { deleted: kernel.deleteMeetingPreset(id) });
      return;
    }
  }

  if (pathname === "/api/v1/character-task-routing/preview" && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      route: kernel.previewCharacterTaskRoute({
        sourceCharacterId: requiredString(body.sourceCharacterId, "sourceCharacterId"),
        task: requiredString(body.task, "task"),
        ...(optionalString(body.targetCharacterId)
          ? { targetCharacterId: optionalString(body.targetCharacterId) }
          : {}),
        ...(body.requiredSkillIds === undefined
          ? {}
          : {
              requiredSkillIds: optionalStringArray(body.requiredSkillIds),
            }),
      }),
    });
    return;
  }

  const characterSkillPackageConfirmMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-package-stages\/([^/]+)\/confirm$/,
  );
  if (characterSkillPackageConfirmMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const characterId = decodeURIComponent(characterSkillPackageConfirmMatch[1]);
    const stageId = decodeURIComponent(characterSkillPackageConfirmMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["stageId", "digest", "enabled", "conversationSpace", "characterId"],
      "Character Skill confirmation",
    );
    assertCharacterSkillMutationScope(body, characterId, conversationSpace);
    assertCharacterSkillStageId(body, stageId);
    sendJson(input.response, 201, {
      package: kernel.confirmCharacterAgentSkillPackage({
        characterId,
        conversationSpace,
        stageId,
        digest: requiredStringValue(body.digest, "digest"),
        enabled: requiredBoolean(body.enabled, "enabled"),
      }),
    });
    return;
  }

  const characterSkillPackageStageReviewMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-package-stages\/([^/]+)\/review$/,
  );
  if (characterSkillPackageStageReviewMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    kernel.assertCharacterSkillControlPlaneIdle();
    const characterId = decodeURIComponent(characterSkillPackageStageReviewMatch[1]);
    const stageId = decodeURIComponent(characterSkillPackageStageReviewMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["stageId", "conversationSpace", "characterId"],
      "Character Skill review read",
    );
    assertCharacterSkillMutationScope(body, characterId, conversationSpace);
    assertCharacterSkillStageId(body, stageId);
    const stage = kernel.getCharacterAgentSkillStage({
      characterId,
      conversationSpace,
      stageId,
    });
    if (!stage) {
      throw new AgentSkillInstallerError(
        "character Skill review was not found for this character and conversation space",
        "STAGE_NOT_FOUND",
      );
    }
    sendJson(input.response, 200, { stage: characterAgentSkillStageReviewView(stage) });
    return;
  }

  const characterSkillPackageCancelMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-package-stages\/([^/]+)\/cancel$/,
  );
  if (characterSkillPackageCancelMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const characterId = decodeURIComponent(characterSkillPackageCancelMatch[1]);
    const stageId = decodeURIComponent(characterSkillPackageCancelMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["stageId", "digest", "conversationSpace", "characterId"],
      "Character Skill review cancellation",
    );
    assertCharacterSkillMutationScope(body, characterId, conversationSpace);
    assertCharacterSkillStageId(body, stageId);
    sendJson(input.response, 200, {
      cancelled: kernel.cancelCharacterAgentSkillStage({
        characterId,
        conversationSpace,
        stageId,
        digest: requiredStringValue(body.digest, "digest"),
      }),
    });
    return;
  }

  const characterSkillPackageStageMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-package-stages\/([^/]+)$/,
  );
  if (characterSkillPackageStageMatch && method === "GET") {
    const characterId = decodeURIComponent(characterSkillPackageStageMatch[1]);
    const stageId = decodeURIComponent(characterSkillPackageStageMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const stage = kernel.getCharacterAgentSkillStage({
      characterId,
      conversationSpace,
      stageId,
    });
    if (!stage) {
      throw new AgentSkillInstallerError(
        "character Skill review was not found for this character and conversation space",
        "STAGE_NOT_FOUND",
      );
    }
    sendJson(input.response, 200, { stage: characterAgentSkillStageSummary(stage) });
    return;
  }

  const characterSkillPackageReviewMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-packages\/([^/]+)\/review$/,
  );
  if (characterSkillPackageReviewMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    kernel.assertCharacterSkillControlPlaneIdle();
    const characterId = decodeURIComponent(characterSkillPackageReviewMatch[1]);
    const packageName = decodeURIComponent(characterSkillPackageReviewMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["name", "conversationSpace", "characterId"],
      "Character Skill package review read",
    );
    assertCharacterSkillMutationScope(body, characterId, conversationSpace);
    assertCharacterSkillPackageName(body, packageName);
    const packageSummary = kernel.listCharacterAgentSkillPackages({
      characterId,
      conversationSpace,
    }).find((entry) => entry.name === packageName);
    if (!packageSummary) {
      throw new AgentSkillInstallerError(
        "character Skill package was not found for this character and conversation space",
        "SKILL_NOT_FOUND",
      );
    }
    sendJson(input.response, 200, {
      package: {
        ...characterAgentSkillPackageSummary(packageSummary),
        source: packageSummary.source,
        archiveSha256: packageSummary.archiveSha256,
        manifest: packageSummary.manifest,
        skillMarkdown: kernel.readCharacterAgentSkillMarkdown({
          characterId,
          conversationSpace,
          name: packageName,
        }),
      },
    });
    return;
  }

  const characterSkillPackageMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-packages\/([^/]+)$/,
  );
  if (characterSkillPackageMatch) {
    const characterId = decodeURIComponent(characterSkillPackageMatch[1]);
    const packageName = decodeURIComponent(characterSkillPackageMatch[2]);
    if (method === "GET") {
      const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
      const packageSummary = kernel.listCharacterAgentSkillPackages({
        characterId,
        conversationSpace,
      }).find((entry) => entry.name === packageName);
      if (!packageSummary) {
        throw new AgentSkillInstallerError(
          "character Skill package was not found for this character and conversation space",
          "SKILL_NOT_FOUND",
        );
      }
      sendJson(input.response, 200, { package: characterAgentSkillPackageSummary(packageSummary) });
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(
        body,
        ["enabled", "conversationSpace", "characterId"],
        "Character Skill package update",
      );
      assertCharacterSkillMutationScope(body, characterId, conversationSpace);
      sendJson(input.response, 200, {
        package: kernel.setCharacterAgentSkillEnabled({
          characterId,
          conversationSpace,
          name: packageName,
          enabled: requiredBoolean(body.enabled, "enabled"),
        }),
      });
      return;
    }
    if (method === "DELETE") {
      assertLocalControlPlaneMutation(input.request);
      const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(
        body,
        ["name", "digest", "conversationSpace", "characterId"],
        "Character Skill package removal",
      );
      assertCharacterSkillMutationScope(body, characterId, conversationSpace);
      assertCharacterSkillPackageName(body, packageName);
      sendJson(input.response, 200, {
        uninstalled: await kernel.uninstallCharacterAgentSkillPackage({
          characterId,
          conversationSpace,
          name: packageName,
          digest: requiredStringValue(body.digest, "digest"),
        }),
      });
      return;
    }
  }

  const characterSkillPackagesMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-packages$/,
  );
  if (characterSkillPackagesMatch && method === "GET") {
    const characterId = decodeURIComponent(characterSkillPackagesMatch[1]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    sendJson(input.response, 200, {
      packages: kernel.listCharacterAgentSkillPackages({ characterId, conversationSpace })
        .map(characterAgentSkillPackageSummary),
    });
    return;
  }

  const characterSkillPackageStagesMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/skill-package-stages$/,
  );
  if (characterSkillPackageStagesMatch && method === "GET") {
    const characterId = decodeURIComponent(characterSkillPackageStagesMatch[1]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    sendJson(input.response, 200, {
      stages: kernel.listCharacterAgentSkillStages({ characterId, conversationSpace })
        .map(characterAgentSkillStageSummary),
    });
    return;
  }

  const characterOwnedSkillsMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills$/,
  );
  if (characterOwnedSkillsMatch) {
    const characterId = decodeURIComponent(characterOwnedSkillsMatch[1]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    if (method === "GET") {
      sendJson(input.response, 200, {
        skills: kernel.listCharacterOwnedSkills(characterId, conversationSpace),
      });
      return;
    }
    if (method === "POST") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      const createInput: CharacterOwnedSkillCreateInput = {
        name: requiredString(body.name, "name"),
        description: optionalString(body.description),
        tags: body.tags === undefined ? [] : optionalStringArray(body.tags),
        markdown: requiredString(body.markdown, "markdown"),
        autoImprove: body.autoImprove === undefined
          ? true
          : requiredBoolean(body.autoImprove, "autoImprove"),
        activate: body.activate === undefined
          ? true
          : requiredBoolean(body.activate, "activate"),
        createdBy: "user",
      };
      sendJson(input.response, 201, {
        skill: kernel.createCharacterOwnedSkill(characterId, createInput, conversationSpace),
      });
      return;
    }
  }

  const characterOwnedSkillMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills\/([^/]+)$/,
  );
  if (characterOwnedSkillMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const characterId = decodeURIComponent(characterOwnedSkillMatch[1]);
    const packageId = decodeURIComponent(characterOwnedSkillMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    const body = asRecord(await readJson(input.request));
    const patch: CharacterOwnedSkillUpdateInput = {
      ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
      ...(body.description === undefined
        ? {}
        : { description: optionalString(body.description) ?? "" }),
      ...(body.tags === undefined ? {} : { tags: optionalStringArray(body.tags) }),
      ...(body.autoImprove === undefined
        ? {}
        : { autoImprove: requiredBoolean(body.autoImprove, "autoImprove") }),
      ...(body.status === undefined
        ? {}
        : { status: requiredString(body.status, "status") as CharacterOwnedSkillUpdateInput["status"] }),
    };
    sendJson(input.response, 200, {
      skill: kernel.updateCharacterOwnedSkill(
        characterId,
        packageId,
        patch,
        conversationSpace,
      ),
    });
    return;
  }

  const characterOwnedSkillReviewMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills\/([^/]+)\/review$/,
  );
  if (characterOwnedSkillReviewMatch && method === "GET") {
    const characterId = decodeURIComponent(characterOwnedSkillReviewMatch[1]);
    const packageId = decodeURIComponent(characterOwnedSkillReviewMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    sendJson(input.response, 200, {
      skill: kernel.listCharacterOwnedSkills(characterId, conversationSpace)
        .find((entry) => entry.id === packageId),
      ...kernel.getCharacterOwnedSkillReview(characterId, packageId, conversationSpace),
    });
    return;
  }

  const characterOwnedSkillVersionsMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills\/([^/]+)\/versions$/,
  );
  if (characterOwnedSkillVersionsMatch) {
    const characterId = decodeURIComponent(characterOwnedSkillVersionsMatch[1]);
    const packageId = decodeURIComponent(characterOwnedSkillVersionsMatch[2]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    if (method === "GET") {
      sendJson(input.response, 200, {
        versions: kernel.listCharacterOwnedSkillVersions(
          characterId,
          packageId,
          conversationSpace,
        ),
      });
      return;
    }
    if (method === "POST") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 201, {
        version: kernel.createCharacterOwnedSkillVersion(
          characterId,
          packageId,
          {
            markdown: requiredString(body.markdown, "markdown"),
            changeSummary: optionalString(body.changeSummary),
            activate: body.activate === undefined
              ? true
              : requiredBoolean(body.activate, "activate"),
            source: "manual",
          },
          conversationSpace,
        ),
      });
      return;
    }
  }

  const characterOwnedSkillActivateMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills\/([^/]+)\/versions\/([^/]+)\/activate$/,
  );
  if (characterOwnedSkillActivateMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const characterId = decodeURIComponent(characterOwnedSkillActivateMatch[1]);
    const packageId = decodeURIComponent(characterOwnedSkillActivateMatch[2]);
    const versionId = decodeURIComponent(characterOwnedSkillActivateMatch[3]);
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    sendJson(input.response, 200, {
      version: kernel.activateCharacterOwnedSkillVersion(
        characterId,
        packageId,
        versionId,
        conversationSpace,
      ),
    });
    return;
  }

  const characterOwnedSkillProposalMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/owned-skills\/([^/]+)\/proposals\/([^/]+)\/(approve|reject)$/,
  );
  if (characterOwnedSkillProposalMatch && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const characterId = decodeURIComponent(characterOwnedSkillProposalMatch[1]);
    const packageId = decodeURIComponent(characterOwnedSkillProposalMatch[2]);
    const proposalId = decodeURIComponent(characterOwnedSkillProposalMatch[3]);
    const decision = characterOwnedSkillProposalMatch[4] as "approve" | "reject";
    const conversationSpace = requestedCharacterWorkspaceSpace(url, characterId);
    sendJson(input.response, 200, {
      result: kernel.reviewCharacterOwnedSkillProposal(
        characterId,
        packageId,
        proposalId,
        decision,
        conversationSpace,
      ),
    });
    return;
  }

  const characterCollaborationProfileMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/collaboration-profile$/,
  );
  if (characterCollaborationProfileMatch) {
    const characterId = decodeURIComponent(characterCollaborationProfileMatch[1]);
    if (method === "GET") {
      sendJson(input.response, 200, {
        collaborationProfile: kernel.getCharacterCollaborationProfile(characterId),
      });
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        collaborationProfile: kernel.updateCharacterCollaborationProfile(characterId, {
          ...(body.introduction === undefined
            ? {}
            : { introduction: String(body.introduction) }),
          ...(body.traits === undefined ? {} : { traits: optionalStringArray(body.traits) }),
          ...(body.maxConcurrentTasks === undefined
            ? {}
            : {
                maxConcurrentTasks: requiredNumber(
                  body.maxConcurrentTasks,
                  "maxConcurrentTasks",
                ),
              }),
        }),
      });
      return;
    }
  }

  const characterLifePlanMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/life\/plan$/);
  if (characterLifePlanMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      result: await kernel.planCharacterLife(
        decodeURIComponent(characterLifePlanMatch[1]),
        body.force === undefined ? false : requiredBoolean(body.force, "force"),
      ),
    });
    return;
  }

  const characterLifeMomentMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/life\/moment$/);
  if (characterLifeMomentMatch && method === "POST") {
    sendJson(input.response, 200, {
      result: await kernel.simulateCharacterMoment(decodeURIComponent(characterLifeMomentMatch[1])),
    });
    return;
  }

  const characterLifeResumeMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/life\/proactive\/resume$/);
  if (characterLifeResumeMatch && method === "POST") {
    sendJson(input.response, 200, {
      policy: kernel.resumeCharacterProactiveMessages(decodeURIComponent(characterLifeResumeMatch[1])),
    });
    return;
  }

  const characterLifeTopicResetMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/life\/proactive-topics\/([^/]+)\/reset$/,
  );
  if (characterLifeTopicResetMatch && method === "POST") {
    sendJson(input.response, 200, {
      topicPolicy: kernel.resetCharacterProactiveTopic(
        decodeURIComponent(characterLifeTopicResetMatch[1]),
        decodeURIComponent(characterLifeTopicResetMatch[2]),
      ),
    });
    return;
  }

  const characterLifeAttributesMatch = pathname.match(
    /^\/api\/v1\/characters\/([^/]+)\/life\/attributes$/,
  );
  if (characterLifeAttributesMatch && method === "PATCH") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    const rawValues = asRecord(body.values);
    const values = Object.fromEntries(Object.entries(rawValues).map(([key, value]) => [
      key,
      requiredNumber(value, `values.${key}`),
    ]));
    sendJson(input.response, 200, {
      life: kernel.updateCharacterWorldAttributes(
        decodeURIComponent(characterLifeAttributesMatch[1]),
        values,
      ),
    });
    return;
  }

  const characterLifeMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/life$/);
  if (characterLifeMatch) {
    const characterId = decodeURIComponent(characterLifeMatch[1]);
    if (method === "GET") {
      sendJson(input.response, 200, { life: kernel.getCharacterLife(characterId) });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      if (body.worldId !== undefined || body.homePlaceId !== undefined || body.currentPlaceId !== undefined) {
        kernel.assignCharacterWorld(characterId, {
          worldId: optionalNullableString(body.worldId, "worldId"),
          homePlaceId: optionalNullableString(body.homePlaceId, "homePlaceId"),
          currentPlaceId: optionalNullableString(body.currentPlaceId, "currentPlaceId"),
        } satisfies CharacterWorldAssignmentInput);
      }
      if (body.policy !== undefined) {
        const policy = asRecord(body.policy);
        const patch: CharacterAutonomyPolicyPatch = {};
        if (policy.enabled !== undefined) patch.enabled = requiredBoolean(policy.enabled, "policy.enabled");
        if (policy.proactiveEnabled !== undefined) {
          patch.proactiveEnabled = requiredBoolean(policy.proactiveEnabled, "policy.proactiveEnabled");
        }
        if (policy.socialEnabled !== undefined) {
          patch.socialEnabled = requiredBoolean(policy.socialEnabled, "policy.socialEnabled");
        }
        if (policy.dailyMessageLimit !== undefined) {
          patch.dailyMessageLimit = requiredNumber(policy.dailyMessageLimit, "policy.dailyMessageLimit");
        }
        if (policy.socialDailyLimit !== undefined) {
          patch.socialDailyLimit = requiredNumber(policy.socialDailyLimit, "policy.socialDailyLimit");
        }
        if (policy.proactiveCooldownMinutes !== undefined) {
          patch.proactiveCooldownMinutes = requiredNumber(
            policy.proactiveCooldownMinutes,
            "policy.proactiveCooldownMinutes",
          );
        }
        if (policy.socialCooldownMinutes !== undefined) {
          patch.socialCooldownMinutes = requiredNumber(
            policy.socialCooldownMinutes,
            "policy.socialCooldownMinutes",
          );
        }
        if (policy.quietStart !== undefined) patch.quietStart = requiredString(policy.quietStart, "policy.quietStart");
        if (policy.quietEnd !== undefined) patch.quietEnd = requiredString(policy.quietEnd, "policy.quietEnd");
        if (policy.proactivePausedUntil !== undefined) {
          patch.proactivePausedUntil = optionalNullableString(
            policy.proactivePausedUntil,
            "policy.proactivePausedUntil",
          );
        }
        kernel.updateCharacterAutonomyPolicy(characterId, patch);
      }
      if (body.runtime !== undefined) {
        const runtime = asRecord(body.runtime);
        const patch: CharacterRuntimePatch = {
          ...(runtime.placeId === undefined ? {} : { placeId: requiredString(runtime.placeId, "runtime.placeId") }),
          ...(runtime.activity === undefined ? {} : { activity: requiredString(runtime.activity, "runtime.activity") }),
          ...(runtime.availability === undefined
            ? {}
            : { availability: requiredString(runtime.availability, "runtime.availability") as CharacterRuntimePatch["availability"] }),
          ...(runtime.energy === undefined ? {} : { energy: requiredNumber(runtime.energy, "runtime.energy") }),
          ...(runtime.expectedUntil === undefined
            ? {}
            : { expectedUntil: optionalNullableString(runtime.expectedUntil, "expectedUntil") }),
        };
        kernel.updateCharacterRuntime(characterId, patch);
      }
      sendJson(input.response, 200, { life: kernel.getCharacterLife(characterId) });
      return;
    }
  }

  const relationshipResetMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/relationship\/reset$/);
  if (relationshipResetMatch && method === "POST") {
    const id = decodeURIComponent(relationshipResetMatch[1]);
    const character = kernel.getCharacter(id);
    const body = asRecord(await readJson(input.request));
    const confirmation = requiredString(body.confirmation, "confirmation");
    if (confirmation !== character.id && confirmation !== character.name) {
      throw new Error("relationship reset requires the exact character name or id");
    }
    sendJson(input.response, 200, { relationship: kernel.resetCharacterRelationship(id) });
    return;
  }

  const relationshipMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/relationship$/);
  if (relationshipMatch && method === "GET") {
    sendJson(input.response, 200, {
      relationship: kernel.getCharacterRelationship(decodeURIComponent(relationshipMatch[1])),
    });
    return;
  }

  const recentMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/(recent-activity|goals|background-tasks)(?:\/([^/]+))?$/);
  if (recentMatch) {
    const characterId = decodeURIComponent(recentMatch[1]);
    const spaceValue = new URL(input.request.url ?? "/", "http://localhost").searchParams.get("space") ?? "normal";
    if (spaceValue !== "normal" && spaceValue !== "secret") throw new WorldValidationError("无效的会话空间");
    const itemId = recentMatch[3] ? decodeURIComponent(recentMatch[3]) : undefined;
    if (method === "GET" && recentMatch[2] === "recent-activity" && !itemId) {
      sendJson(input.response, 200, kernel.getCharacterRecentActivity(characterId, spaceValue));
      return;
    }
    if (method === "POST" || method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      if (recentMatch[2] === "goals" && method === "POST" && !itemId) {
        if (body.kind !== "request" && body.kind !== "wish") throw new WorldValidationError("无效的事项类型");
        sendJson(input.response, 201, { goal: kernel.createCharacterGoal(characterId, spaceValue, {
          kind: body.kind, title: requiredString(body.title, "title"), nextStep: optionalDocumentString(body.nextStep, "nextStep"),
        }) });
        return;
      }
      if (recentMatch[2] === "goals" && method === "PATCH" && itemId) {
        const action = requiredString(body.action, "action");
        if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "complete" && action !== "edit") throw new WorldValidationError("无效的事项操作");
        sendJson(input.response, 200, { goal: kernel.updateCharacterGoal(characterId, spaceValue, itemId, {
          revision: requiredNumber(body.revision, "revision"), action,
          nextStep: optionalDocumentString(body.nextStep, "nextStep"), completionNote: optionalDocumentString(body.completionNote, "completionNote"),
        }) });
        return;
      }
      if (recentMatch[2] === "background-tasks" && method === "POST" && itemId) {
        if (body.action !== "cancel" && body.action !== "retry") throw new WorldValidationError("无效的任务操作");
        kernel.characterBackgroundTasks.control(characterId, spaceValue, itemId, body.action);
        sendJson(input.response, 200, { accepted: true });
        return;
      }
    }
  }

  const diaryMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)\/diary(?:\/(settings)|\/([^/]+)\/(retry))?$/);
  if (diaryMatch) {
    const characterId = decodeURIComponent(diaryMatch[1]);
    if (method === "GET" && !diaryMatch[2] && !diaryMatch[3]) {
      sendJson(input.response, 200, kernel.getCharacterDiary(characterId));
      return;
    }
    if (method === "PATCH" && diaryMatch[2]) {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      if (body.presetMode !== undefined && body.presetMode !== "inherit" && body.presetMode !== "custom" && body.presetMode !== "none") throw new DiaryValidationError("无效的创作预设选择");
      sendJson(input.response, 200, { settings: kernel.characterDiaries.updateSettings(characterId, {
        narrativeEnabled: requiredBoolean(body.narrativeEnabled, "narrativeEnabled"),
        preset: optionalDocumentString(body.preset, "preset") ?? "",
        ...(body.presetMode === undefined ? {} : { presetMode: body.presetMode as "inherit" | "custom" | "none" }),
        ...(body.presetId === undefined ? {} : { presetId: optionalNullableString(body.presetId, "presetId") }),
      }) });
      return;
    }
    if (method === "POST" && diaryMatch[4]) {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      if (body.kind !== "memory" && body.kind !== "narrative") throw new DiaryValidationError("无效的日记任务类型");
      kernel.characterDiaries.retry(characterId, decodeURIComponent(diaryMatch[3]), body.kind);
      void kernel.characterDiaries.drain().catch(() => undefined);
      sendJson(input.response, 202, { queued: true });
      return;
    }
  }
  const characterMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)$/);
  if (characterMatch) {
    const id = decodeURIComponent(characterMatch[1]);
    if (method === "DELETE") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      if (body.mode !== undefined && body.mode !== "depart" && body.mode !== "delete") throw new WorldValidationError("无效的角色移除方式");
      sendJson(input.response, 200, kernel.deleteCharacter(id, requiredString(body.confirmation, "confirmation"), body.mode as "depart" | "delete" | undefined));
      return;
    }
    if (method === "GET") {
      sendJson(input.response, 200, { character: withCharacterAvatar(kernel, kernel.getCharacter(id)) });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        character: withCharacterAvatar(kernel, kernel.updateCharacter(id, {
          ...(body as UpdateCharacterInput),
          name: body.name === undefined ? undefined : requiredString(body.name, "name"),
          soulMarkdown: optionalDocumentString(body.soulMarkdown, "soulMarkdown"),
          modelProfileId: body.modelProfileId === undefined
            ? undefined
            : optionalNullableString(body.modelProfileId, "modelProfileId"),
          meetingPresetId: body.meetingPresetId === undefined
            ? undefined
            : optionalNullableString(body.meetingPresetId, "meetingPresetId"),
          boundaries: body.boundaries === undefined ? undefined : optionalStringArray(body.boundaries),
        })),
      });
      return;
    }
  }

  const sceneMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/scene$/);
  if (sceneMatch) {
    const sessionId = decodeURIComponent(sceneMatch[1]);
    const conversationSpace = assertRequestedSessionConversationSpace(kernel, sessionId, url);
    if (conversationSpace === "secret") throw new ConversationNotFoundError(sessionId);
    if (method === "GET") {
      sendJson(input.response, 200, {
        scene: kernel.getScene(sessionId, optionalString(url.searchParams.get("characterId"))),
      });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, {
        scene: kernel.updateScene(
          sessionId,
          body as UpdateSceneInput,
          optionalString(body.characterId),
        ),
      });
      return;
    }
  }

  if (pathname === "/api/v1/reality-memories" && method === "POST") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    const body = asRecord(await readJson(input.request));
    if (body.scope !== undefined && body.scope !== "global") {
      throw new MemoryLifecycleError("reality memory requires scope=global", "REALITY_MEMORY_CONTRACT_INVALID");
    }
    if (body.realm !== undefined && body.realm !== "reality") {
      throw new MemoryLifecycleError("reality memory requires realm=reality", "REALITY_MEMORY_CONTRACT_INVALID");
    }
    if (body.characterId !== undefined) {
      throw new MemoryLifecycleError("reality memory cannot have characterId", "REALITY_MEMORY_CONTRACT_INVALID");
    }
    const sourceMessageId = optionalString(body.sourceMessageId) ?? kernel.store.idGenerator.next("message");
    const memory = kernel.createControlPlaneMemory({
      conversationSpace,
      ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
      realm: "reality",
      type: requiredRealityMemoryType(body.type),
      key: optionalString(body.key),
      content: requiredString(body.content, "content"),
      sourceSessionId: optionalString(body.sourceSessionId) ?? "control-plane",
      sourceMessageId,
      salience: optionalUnitNumber(body.salience, "salience"),
      confidence: optionalUnitNumber(body.confidence, "confidence"),
      tags: optionalStringArray(body.tags),
      idempotencyKey: optionalString(body.idempotencyKey) ?? `http:${sourceMessageId}`,
    });
    sendJson(input.response, 201, { memory });
    return;
  }

  if (pathname === "/api/v1/memories") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    if (method === "GET") {
      sendJson(input.response, 200, {
        memories: kernel.searchRpMemories({
          conversationSpace,
          ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
          query: optionalString(url.searchParams.get("query")),
          ...(conversationSpace === "normal"
            ? { characterId: optionalString(url.searchParams.get("characterId")) }
            : {}),
          realm: optionalMemoryRealm(url.searchParams.get("realm")),
          type: optionalMemoryType(url.searchParams.get("type")),
          validity: optionalMemoryValidity(url.searchParams.get("validity")),
          confirmedOnly: url.searchParams.get("confirmedOnly") === "1",
          limit: optionalPositiveInteger(url.searchParams.get("limit")),
        }),
      });
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      assertCharacterMemoryRealm(body);
      const idempotencyHeader = input.request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      const result = kernel.writeRpMemory({
        ...(body as CreateMemoryInput),
        conversationSpace,
        ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
        realm: RP_MEMORY_REALM,
        scope: RP_MEMORY_SCOPE,
        type: requiredRoleplayMemoryType(body.type),
        content: requiredString(body.content, "content"),
        characterId: requiredString(body.characterId, "characterId"),
        confirmed: body.confirmed === undefined ? false : requiredBoolean(body.confirmed, "confirmed"),
        tags: optionalStringArray(body.tags),
        idempotencyKey: idempotencyKey || optionalString(body.idempotencyKey),
      });
      sendJson(input.response, result.needsConfirmation ? 409 : 201, result);
      return;
    }
  }

  const memoryMatch = pathname.match(/^\/api\/v1\/memories\/([^/]+)$/);
  if (memoryMatch) {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    const id = decodeURIComponent(memoryMatch[1]);
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      assertImmutableMemoryRealm(body);
      const current = kernel.listMemories({
        conversationSpace,
        ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
      }).find((memory) => memory.id === id);
      if (current && current.realm !== "legacy") {
        const edit = memoryControlPlaneEdit(body, current.realm);
        const result = current.validity === "pending"
          ? kernel.confirmMemory(id, edit, conversationSpace, secretOwnerCharacterId)
          : current.validity === "active"
            ? kernel.correctMemory(id, edit, conversationSpace, secretOwnerCharacterId)
            : (() => {
                throw new MemoryLifecycleError(
                  `memory in ${current.validity} state is not editable`,
                  "MEMORY_NOT_EDITABLE",
                );
              })();
        sendJson(input.response, 200, result);
        return;
      }
      sendJson(input.response, 200, {
        memory: kernel.updateRpMemory(id, {
          ...(body as UpdateMemoryInput),
          type: body.type === undefined ? undefined : requiredMemoryType(body.type),
          tags: body.tags === undefined ? undefined : optionalStringArray(body.tags),
        }, conversationSpace, secretOwnerCharacterId),
      });
      return;
    }
    if (method === "DELETE") {
      const current = kernel.listMemories({
        conversationSpace,
        ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
      }).find((memory) => memory.id === id);
      sendJson(input.response, 200, {
        memory: current?.realm === "legacy"
          ? kernel.deleteRpMemory(id, conversationSpace, secretOwnerCharacterId)
          : kernel.forgetMemory(id, undefined, conversationSpace, secretOwnerCharacterId),
      });
      return;
    }
  }

  const memoryActionMatch = pathname.match(/^\/api\/v1\/memories\/([^/]+)\/(confirm|correct|reject|archive|forget)$/);
  if (memoryActionMatch && method === "POST") {
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    const id = decodeURIComponent(memoryActionMatch[1]);
    const action = memoryActionMatch[2];
    const body = asRecord(await readJson(input.request));
    if (action === "confirm") {
      sendJson(input.response, 200, kernel.confirmMemory(
        id,
        memoryControlPlaneEdit(body),
        conversationSpace,
        secretOwnerCharacterId,
      ));
    } else if (action === "correct") {
      sendJson(input.response, 200, kernel.correctMemory(
        id,
        memoryControlPlaneEdit(body),
        conversationSpace,
        secretOwnerCharacterId,
      ));
    } else if (action === "reject") {
      sendJson(input.response, 200, {
        memory: kernel.rejectMemory(
          id,
          optionalString(body.reason),
          conversationSpace,
          secretOwnerCharacterId,
        ),
      });
    } else if (action === "archive") {
      sendJson(input.response, 200, {
        memory: kernel.archiveMemory(
          id,
          optionalString(body.reason),
          conversationSpace,
          secretOwnerCharacterId,
        ),
      });
    } else {
      sendJson(input.response, 200, {
        memory: kernel.forgetMemory(
          id,
          optionalString(body.reason),
          conversationSpace,
          secretOwnerCharacterId,
        ),
      });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/debug/context-logs") {
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      logs: kernel.recentContextLogs(
        limit,
        conversationSpace,
        secretOwnerCharacterId,
      ),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/debug/model-traces") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const requestedScope = url.searchParams.get("scope");
    if (requestedScope && requestedScope !== "conversation" && requestedScope !== "background") {
      sendJson(input.response, 400, {
        code: "INVALID_TRACE_SCOPE",
        error: "scope must be conversation or background",
      });
      return;
    }
    const scope = requestedScope as ModelContextTraceScope | null;
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      traces: kernel.recentModelContextTraces(
        limit,
        scope ?? undefined,
        conversationSpace,
        secretOwnerCharacterId,
      ),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/debug/context-economics") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const conversationSpace = requestedConversationSpace(url);
    const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
    sendJson(input.response, 200, {
      economics: kernel.recentContextEconomics(
        limit,
        conversationSpace,
        secretOwnerCharacterId,
      ),
    });
    return;
  }

  if (isModelApiSettingsPath(pathname)) {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getModelApiConfig());
      return;
    }
    if (method === "PATCH") {
      const patch = (await readJson(input.request)) as ModelApiConfigPatch;
      sendJson(input.response, 200, kernel.patchModelApiConfig(patch));
      return;
    }
  }

  if (method === "GET" && pathname === "/api/v1/model-providers") {
    sendJson(input.response, 200, { providers: kernel.listModelProviders() });
    return;
  }

  if (pathname === "/api/v1/model-profiles") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.listModelApiProfiles());
      return;
    }
    if (method === "POST") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 201, { profile: kernel.createModelApiProfile(body as ModelApiProfilePatch) });
      return;
    }
  }

  const modelCredentialMatch = pathname.match(
    /^\/api\/v1\/model-profiles\/([^/]+)\/credential(?:\/(revoke|rollback))?$/,
  );
  if (modelCredentialMatch) {
    const id = decodeURIComponent(modelCredentialMatch[1]);
    const operation = modelCredentialMatch[2];
    if (!operation && method === "PUT") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(body, ["apiKey", "expectedRevision", "verify", "profilePatch"], "Model credential");
      const profilePatch = body.profilePatch === undefined
        ? undefined
        : asModelCredentialProfilePatch(body.profilePatch);
      const profile = await kernel.setModelApiCredential(id, {
        apiKey: body.apiKey as string,
        expectedRevision: body.expectedRevision as number,
        verify: body.verify as boolean | undefined,
        profilePatch,
      });
      sendJson(input.response, 200, { profile });
      return;
    }
    if (operation === "revoke" && method === "POST") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(body, ["expectedRevision"], "Model credential revoke");
      sendJson(input.response, 200, {
        profile: kernel.revokeModelApiCredential(id, body.expectedRevision as number),
      });
      return;
    }
    if (operation === "rollback" && method === "POST") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(body, ["expectedRevision"], "Model credential rollback");
      sendJson(input.response, 200, {
        profile: kernel.rollbackModelApiCredential(id, body.expectedRevision as number),
      });
      return;
    }
  }

  const modelProfileMatch = pathname.match(/^\/api\/v1\/model-profiles\/([^/]+)$/);
  if (modelProfileMatch) {
    const id = decodeURIComponent(modelProfileMatch[1]);
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      sendJson(input.response, 200, { profile: kernel.patchModelApiProfile(id, body as ModelApiProfilePatch) });
      return;
    }
    if (method === "DELETE") {
      sendJson(input.response, 200, kernel.deleteModelApiProfile(id));
      return;
    }
  }

  const defaultModelProfileMatch = pathname.match(/^\/api\/v1\/model-profiles\/([^/]+)\/default$/);
  if (defaultModelProfileMatch && method === "POST") {
    sendJson(
      input.response,
      200,
      kernel.setDefaultModelApiProfile(decodeURIComponent(defaultModelProfileMatch[1])),
    );
    return;
  }

  if (pathname === "/api/settings/tavily") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getTavilyConfig());
      return;
    }
    if (method === "PATCH") {
      const patch = (await readJson(input.request)) as TavilyApiConfigPatch;
      sendJson(input.response, 200, kernel.patchTavilyConfig(patch));
      return;
    }
  }

  if (pathname === "/api/settings/vision") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getVisionConfig());
      return;
    }
    if (method === "PATCH") {
      const patch = (await readJson(input.request)) as VisionApiConfigPatch;
      sendJson(input.response, 200, kernel.patchVisionConfig(patch));
      return;
    }
  }

  if (pathname === "/api/settings/mineru") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getMineruConfig());
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const patch = (await readJson(input.request)) as MineruApiConfigPatch;
      sendJson(input.response, 200, kernel.patchMineruConfig(patch));
      return;
    }
  }

  if (pathname === "/api/settings/git-access") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getGitAccessConfig());
      return;
    }
    if (method === "PATCH") {
      assertLocalControlPlaneMutation(input.request);
      const body = asRecord(await readJson(input.request));
      assertOnlyKeys(body, ["expectedRevision", "credential", "proxyMode", "proxyPort"], "Git access settings");
      const patch: GitAccessConfigPatch = {
        ...(body.credential === undefined ? {} : { credential: requiredBrowserGitAccessCredential(body.credential) }),
        ...(body.proxyMode === undefined ? {} : { proxyMode: requiredGitProxyMode(body.proxyMode) }),
        ...(body.proxyPort === undefined ? {} : { proxyPort: requiredGitProxyPort(body.proxyPort) }),
      };
      sendJson(input.response, 200, kernel.patchGitAccessConfig(
        patch,
        requiredGitAccessRevision(body.expectedRevision),
      ));
      return;
    }
  }

  if (pathname === "/api/settings/git-access/generate-key" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(body, ["expectedRevision"], "Git access key generation");
    sendJson(input.response, 200, await kernel.generateGitAccessKey(
      requiredGitAccessRevision(body.expectedRevision),
    ));
    return;
  }

  if (pathname === "/api/settings/git-access/public-key" && method === "GET") {
    sendJson(input.response, 200, kernel.getGitAccessPublicKey());
    return;
  }

  if (pathname === "/api/settings/trace-archive") {
    if (method === "GET") {
      sendJson(input.response, 200, kernel.getTraceArchiveStatus());
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      if (typeof body.enabled !== "boolean") {
        sendJson(input.response, 400, { error: "enabled must be a boolean" });
        return;
      }
      sendJson(input.response, 200, kernel.patchTraceArchiveConfig({ enabled: body.enabled }));
      return;
    }
  }

  if (pathname === "/api/v1/diagnostics/model/test" && method === "POST") {
    sendJson(input.response, 200, await kernel.testModelConnection(optionalString(url.searchParams.get("profileId"))));
    return;
  }

  if (pathname === "/api/v1/diagnostics/model/models" && method === "GET") {
    sendJson(input.response, 200, {
      models: await kernel.discoverModels(optionalString(url.searchParams.get("profileId"))),
    });
    return;
  }

  if (pathname === "/api/v1/diagnostics/model/models" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    assertOnlyKeys(
      body,
      ["profileId", "apiKey", "expectedRevision", "profilePatch"],
      "Candidate model discovery",
    );
    const profilePatch = body.profilePatch === undefined
      ? undefined
      : asModelCredentialProfilePatch(body.profilePatch);
    sendJson(input.response, 200, {
      models: await kernel.discoverModelsWithCandidate(
        requiredString(body.profileId, "profileId"),
        {
          ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey as string }),
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision as number }),
          ...(profilePatch === undefined ? {} : { profilePatch }),
        },
      ),
    });
    return;
  }

  if (pathname === "/api/v1/diagnostics/tavily/test" && method === "POST") {
    sendJson(input.response, 200, await kernel.testTavilyConnection());
    return;
  }

  if (pathname === "/api/v1/diagnostics/vision/test" && method === "POST") {
    sendJson(input.response, 200, await kernel.testVisionConnection());
    return;
  }

  if (pathname === "/api/v1/diagnostics/vision/models" && method === "GET") {
    sendJson(input.response, 200, { models: await kernel.discoverVisionModels() });
    return;
  }

  if (pathname === "/api/v1/diagnostics/mineru/test" && method === "POST") {
    assertLocalControlPlaneMutation(input.request);
    sendJson(input.response, 200, await kernel.testMineruConnection());
    return;
  }

  if (pathname === "/api/v1/export" && method === "GET") {
    // Exports contain reviewed Skill source and Markdown.  Refuse them while a
    // model turn is active so a networked shell cannot impersonate the local UI.
    kernel.assertCharacterSkillControlPlaneIdle();
    const conversationSpace = requestedConversationSpace(url);
    const characterId = requestedConversationCharacterId(url, conversationSpace);
    input.response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=yourchar-export.json",
      "cache-control": "no-store",
    });
    input.response.end(JSON.stringify(
      await kernel.exportUserData(conversationSpace, characterId),
      null,
      2,
    ));
    return;
  }

  if (pathname === "/api/v1/data" && method === "DELETE") {
    assertLocalControlPlaneMutation(input.request);
    const body = asRecord(await readJson(input.request));
    if (body.confirm !== "DELETE_ALL_DATA") {
      sendJson(input.response, 400, { error: "confirm must equal DELETE_ALL_DATA" });
      return;
    }
    await kernel.deleteAllUserData();
    sendJson(input.response, 200, { deleted: true });
    return;
  }

  if (method === "GET" && !pathname.startsWith("/api/")) {
    sendHtml(input.request, input.response, 200, renderAppHtml());
    return;
  }

  sendJson(input.response, 404, { error: "Not Found" });
}

async function routeTestControl(input: {
  testRuns?: TestRunRegistry;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  url: URL;
  pathname: string;
}): Promise<boolean> {
  if (!input.pathname.startsWith("/api/_test/v1")) {
    return false;
  }
  if (!input.testRuns) {
    sendJson(input.response, 404, { error: "Test API is disabled" });
    return true;
  }

  if (input.pathname === "/api/_test/v1/runs" && input.method === "POST") {
    const body = asRecord(await readJson(input.request));
    const runtime = input.testRuns.create({
      now: optionalString(body.now),
      timezone: optionalString(body.timezone),
      seed: optionalString(body.seed),
    });
    sendJson(input.response, 201, {
      runId: runtime.id,
      now: runtime.clock.now().toISOString(),
      timezone: runtime.timezone,
    });
    return true;
  }

  const runMatch = input.pathname.match(/^\/api\/_test\/v1\/runs\/([^/]+)(\/.*)?$/);
  if (!runMatch) {
    sendJson(input.response, 404, { error: "Not Found" });
    return true;
  }
  const runId = decodeURIComponent(runMatch[1]);
  const suffix = runMatch[2] ?? "";
  if (!suffix && input.method === "DELETE") {
    const deleted = input.testRuns.delete(runId);
    sendJson(input.response, deleted ? 200 : 404, { deleted });
    return true;
  }
  const runtime = input.testRuns.get(runId);
  if (!runtime) {
    sendJson(input.response, 404, { error: `Unknown test run: ${runId}` });
    return true;
  }

  if (suffix === "/clock" && input.method === "PUT") {
    const body = asRecord(await readJson(input.request));
    const now = requiredString(body.now, "now");
    sendJson(input.response, 200, { now: runtime.clock.set(now).toISOString() });
    return true;
  }
  if (suffix === "/clock/advance" && input.method === "POST") {
    const body = asRecord(await readJson(input.request));
    const milliseconds = requiredNumber(body.milliseconds, "milliseconds");
    sendJson(input.response, 200, { now: runtime.clock.advance(milliseconds).toISOString() });
    return true;
  }
  if (suffix === "/model/responses" && input.method === "POST") {
    const body = asRecord(await readJson(input.request));
    if (!Array.isArray(body.responses)) {
      sendJson(input.response, 400, { error: "responses must be an array" });
      return true;
    }
    runtime.model.enqueue(body.responses as ScriptedModelResponse[]);
    sendJson(input.response, 200, { pending: runtime.model.pendingCount() });
    return true;
  }
  if (suffix === "/model/requests" && input.method === "GET") {
    sendJson(input.response, 200, { requests: runtime.model.requests });
    return true;
  }
  if (suffix === "/context-economics" && input.method === "GET") {
    sendJson(input.response, 200, {
      economics: runtime.kernel.recentContextEconomics(
        optionalPositiveInteger(input.url.searchParams.get("limit")) ?? 100,
      ),
    });
    return true;
  }
  if (suffix === "/context-plan" && input.method === "GET") {
    const mode = requiredMode(input.url.searchParams.get("mode"));
    sendJson(input.response, 200, {
      plan: runtime.kernel.previewContextPlan({
        mode,
        sessionId: requiredString(input.url.searchParams.get("sessionId"), "sessionId"),
        ...(optionalString(input.url.searchParams.get("characterId"))
          ? { characterId: optionalString(input.url.searchParams.get("characterId")) }
          : {}),
        query: input.url.searchParams.get("query") ?? "",
        timezone: optionalString(input.url.searchParams.get("timezone")) ?? runtime.timezone,
        budgets: contextPlannerBudgets(input.url.searchParams),
        allowBootstrap: input.url.searchParams.get("bootstrap") !== "0",
      }),
    });
    return true;
  }
  if (suffix === "/scheduler/tick" && input.method === "POST") {
    sendJson(input.response, 200, await runtime.schedulerTick());
    return true;
  }
  if (suffix === "/world/tick" && input.method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, await runtime.worldTick(optionalString(body.characterId)));
    return true;
  }
  if (suffix === "/notifications" && input.method === "GET") {
    sendJson(input.response, 200, { notifications: runtime.notifications });
    return true;
  }
  if (suffix === "/events" && input.method === "GET") {
    const after = Math.max(0, Number(input.url.searchParams.get("after") ?? "0"));
    const events = runtime.kernel
      .recentContextLogs(100)
      .slice()
      .reverse()
      .flatMap((log) => log.events)
      .map((event, index) => ({ sequence: index + 1, event }))
      .filter((entry) => entry.sequence > after);
    sendJson(input.response, 200, { events });
    return true;
  }
  if (suffix === "/snapshot" && input.method === "GET") {
    sendJson(input.response, 200, await runtime.snapshot());
    return true;
  }

  sendJson(input.response, 404, { error: "Not Found" });
  return true;
}

function selectKernel(
  request: IncomingMessage,
  productionKernel: CompanionKernel,
  testRuns: TestRunRegistry | undefined,
  response: ServerResponse,
): CompanionKernel | undefined {
  const value = request.headers["x-rp-test-run-id"];
  const runId = Array.isArray(value) ? value[0] : value;
  if (!runId) {
    return productionKernel;
  }
  if (!testRuns) {
    sendJson(response, 403, { error: "Test run headers are disabled" });
    return undefined;
  }
  const runtime = testRuns.get(runId);
  if (!runtime) {
    sendJson(response, 404, { error: `Unknown test run: ${runId}` });
    return undefined;
  }
  return runtime.kernel;
}

function normalizePath(pathname: string): string {
  let path = pathname;
  if (path === "/ui/api" || path.startsWith("/ui/api/")) {
    path = path.slice("/ui".length);
  } else if (path === "/ui/health") {
    path = "/health";
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path || "/";
}

function isModelApiSettingsPath(pathname: string): boolean {
  return (
    pathname === "/api/settings/model-api" ||
    pathname === "/api/model-config/openai-compatible"
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const prepared = consumePreparedHeadlessJsonBody(request);
  if (prepared.prepared) return prepared.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

async function readBinary(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new RequestBodyTooLargeError(maximumBytes);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new RequestBodyTooLargeError(maximumBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {
  constructor(maximumBytes = 1024 * 1024) {
    super(`request body exceeds ${Math.ceil(maximumBytes / 1024 / 1024)} MiB`);
    this.name = "RequestBodyTooLargeError";
  }
}

class SessionBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBatchValidationError";
  }
}

function requireBatchIds(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new SessionBatchValidationError(`${label} must contain non-empty string ids`);
  }
  const ids = value.map((entry) => String(entry).trim());
  if (new Set(ids).size !== ids.length) {
    throw new SessionBatchValidationError(`${label} must not contain duplicates`);
  }
  return ids;
}

class CharacterBindingRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterBindingRequiredError";
  }
}

class SessionCharacterMismatchError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is already bound to another character; create a new session`);
    this.name = "SessionCharacterMismatchError";
  }
}

function requireCharacterBoundMessage(
  kernel: CompanionKernel,
  sessionId: string,
  value: unknown,
): MessageRequest {
  const body = asRecord(value);
  const metadata = kernel.getConversationMetadata(sessionId);
  const conversationSpace = requiredConversationSpace(body.conversationSpace ?? "normal");
  const requestedCharacterId = optionalString(body.characterId);
  const secretCharacterId = requiredSecretConversationCharacterId(body, conversationSpace);
  if (
    metadata && (
      metadata.conversationSpace !== conversationSpace ||
      (secretCharacterId !== undefined && metadata.characterId !== secretCharacterId)
    )
  ) {
    throw new ConversationNotFoundError(sessionId);
  }
  if (metadata?.archivedAt) throw new ConversationArchivedError(sessionId);
  const requestedMode = body.mode === undefined ? metadata?.mode ?? "sms" : body.mode;
  if (requestedMode !== "sms" && requestedMode !== "rp") {
    throw new SyntaxError("mode must be sms or rp");
  }
  if (metadata && metadata.mode !== requestedMode) {
    throw new SessionModeMismatchError(sessionId, metadata.mode, requestedMode);
  }
  if (metadata && !metadata.characterId) {
    throw new CharacterBindingRequiredError(
      `Session ${sessionId} is a legacy unbound session; create a new character-bound session`,
    );
  }
  if (metadata?.characterId && requestedCharacterId && metadata.characterId !== requestedCharacterId) {
    throw new SessionCharacterMismatchError(sessionId);
  }
  const characterId = metadata?.characterId ?? requestedCharacterId;
  if (!characterId) {
    throw new CharacterBindingRequiredError(
      "A selected character is required; create or select a character before starting a session",
    );
  }
  kernel.getCharacter(characterId);
  if (conversationSpace === "secret" && requestedMode !== "sms") {
    throw new SyntaxError("secret conversation space is available only for SMS conversations");
  }
  return {
    mode: requestedMode,
    conversationSpace,
    text: requiredString(body.text, "text"),
    timezone: optionalString(body.timezone),
    characterId,
    attachments: requireMessageAttachments(body.attachments),
  };
}

function requireMessageAttachments(value: unknown): NonNullable<MessageRequest["attachments"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SyntaxError("attachments must be an array");
  if (value.length > 8) throw new SyntaxError("attachments must contain at most 8 items");
  return value.map((item, index) => {
    const input = asRecord(item);
    const path = requiredString(input.path, `attachments[${index}].path`);
    if (path.length > 500) throw new SyntaxError(`attachments[${index}].path is too long`);
    const size = input.size === undefined ? undefined : Number(input.size);
    if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
      throw new SyntaxError(`attachments[${index}].size must be a non-negative number`);
    }
    return {
      path,
      ...(optionalString(input.name) ? { name: optionalString(input.name) } : {}),
      ...(optionalString(input.contentType) ? { contentType: optionalString(input.contentType) } : {}),
      ...(size === undefined ? {} : { size: Math.floor(size) }),
    };
  });
}

function assertCharacterBoundSession(kernel: CompanionKernel, sessionId: string): void {
  const metadata = kernel.getConversationMetadata(sessionId);
  if (!metadata) throw new ConversationNotFoundError(sessionId);
  if (metadata?.archivedAt) throw new ConversationArchivedError(sessionId);
  if (!metadata?.characterId) {
    throw new CharacterBindingRequiredError(
      `Session ${sessionId} has no selected character; create a new character-bound session`,
    );
  }
}

function requestedConversationSpace(url: URL): ConversationSpace {
  return requiredConversationSpace(url.searchParams.get("conversationSpace") ?? "normal");
}

function interactionScopeForConversation(
  conversationSpace: ConversationSpace,
  characterId: string,
): InteractionScope {
  return conversationSpace === "secret"
    ? { conversationSpace: "secret", secretOwnerCharacterId: characterId }
    : { conversationSpace: "normal" };
}

function requestedConversationCharacterId(
  url: URL,
  conversationSpace: ConversationSpace,
): string | undefined {
  if (conversationSpace === "normal") return undefined;
  const characterId = optionalString(url.searchParams.get("characterId"));
  if (!characterId) throw new SyntaxError("characterId is required for secret conversation space");
  return characterId;
}

function requestedCharacterWorkspaceSpace(
  url: URL,
  characterId: string,
): ConversationSpace {
  const conversationSpace = requestedConversationSpace(url);
  const secretOwnerCharacterId = requestedConversationCharacterId(url, conversationSpace);
  if (secretOwnerCharacterId && secretOwnerCharacterId !== characterId) {
    throw new ConversationNotFoundError(characterId);
  }
  return conversationSpace;
}

function assertSessionConversationSpace(
  kernel: CompanionKernel,
  sessionId: string,
  conversationSpace: ConversationSpace,
  characterId?: string,
): void {
  const metadata = kernel.getConversationMetadata(sessionId);
  if (
    !metadata || metadata.conversationSpace !== conversationSpace ||
    (characterId !== undefined && metadata.characterId !== characterId)
  ) {
    throw new ConversationNotFoundError(sessionId);
  }
}

function assertRequestedSessionConversationSpace(
  kernel: CompanionKernel,
  sessionId: string,
  url: URL,
): ConversationSpace {
  const conversationSpace = requestedConversationSpace(url);
  assertSessionConversationSpace(
    kernel,
    sessionId,
    conversationSpace,
    requestedConversationCharacterId(url, conversationSpace),
  );
  return conversationSpace;
}

function assertSessionWorkspaceScope(
  kernel: CompanionKernel,
  sessionId: string,
  url: URL,
): ConversationSpace {
  const conversationSpace = assertRequestedSessionConversationSpace(kernel, sessionId, url);
  const metadata = kernel.getConversationMetadata(sessionId);
  if (conversationSpace === "secret" && !metadata?.characterId) {
    throw new CharacterBindingRequiredError(
      `Session ${sessionId} has no selected character; secret Workspace is unavailable`,
    );
  }
  return conversationSpace;
}

function requireImProvider(value: unknown, httpStatus = 404): ImProvider {
  if (!isImProvider(value)) {
    throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", httpStatus);
  }
  return value;
}

function asImRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImIntegrationError("IM_REQUEST_INVALID", "JSON body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function assertOnlyImKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new ImIntegrationError(
      "IM_REQUEST_INVALID",
      `${context} contains unsupported fields: ${unexpected.join(", ")}`,
      400,
    );
  }
}

function requiredImString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImIntegrationError("IM_REQUEST_INVALID", `${field} is required`, 400);
  }
  return value.trim();
}

function optionalImString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ImIntegrationError("IM_REQUEST_INVALID", `${field} must be a string`, 400);
  }
  return value.trim() || undefined;
}

function requiredImBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ImIntegrationError("IM_REQUEST_INVALID", `${field} must be a boolean`, 400);
  }
  return value;
}

function optionalImPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ImIntegrationError(
      "IM_REQUEST_INVALID",
      `${field} must be a positive integer`,
      400,
    );
  }
  return value;
}

function assertImJsonRequest(request: IncomingMessage): void {
  const contentType = request.headers["content-type"] ?? "";
  const mediaType = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ImIntegrationError(
      "IM_CONTENT_TYPE_REQUIRED",
      "IM mutation requests require Content-Type: application/json",
      415,
    );
  }
}

function publicImBindingSession(session: ImBindingSession) {
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    ...(session.domain ? { domain: session.domain } : {}),
    ...(session.qrCodeUrl ? { qrCodeUrl: session.qrCodeUrl } : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    ...(session.message ? { message: session.message } : {}),
    ...(session.verificationRequired !== undefined
      ? { verificationRequired: session.verificationRequired }
      : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.connection
      ? {
          connection: {
            provider: session.connection.provider,
            ...(session.connection.displayName
              ? { displayName: session.connection.displayName }
              : {}),
            ...(session.connection.domain ? { domain: session.connection.domain } : {}),
            connectedAt: session.connection.connectedAt,
            updatedAt: session.connection.updatedAt,
            ...(session.connection.lastSeenAt
              ? { lastSeenAt: session.connection.lastSeenAt }
              : {}),
          },
        }
      : {}),
  };
}

function assertImGatewayAuthorization(request: IncomingMessage, secret?: string): void {
  if (!secret) {
    throw new ImIntegrationError(
      "IM_GATEWAY_INGRESS_DISABLED",
      "未配置 YOURCHAR_IM_GATEWAY_INGRESS_TOKEN 或 YOURCHAR_IM_GATEWAY_TOKEN，gateway ingress 已关闭",
      503,
    );
  }
  const authorization = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ImIntegrationError(
      "IM_GATEWAY_UNAUTHORIZED",
      "IM gateway authentication failed",
      401,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object required");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new SyntaxError(`${subject} contains unsupported field: ${unexpected}`);
}

function asModelCredentialProfilePatch(value: unknown): ModelApiProfilePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Model credential profilePatch must be an object");
  }
  const patch = value as Record<string, unknown>;
  assertOnlyKeys(patch, [
    "name",
    "enabled",
    "provider",
    "baseUrl",
    "model",
    "visionInputEnabled",
    "temperature",
    "maxTokens",
    "contextWindowTokens",
    "reasoningEffort",
    "thinkingTokenBudgetField",
    "thinkingBudgetTokens",
  ], "Model credential profilePatch");
  return patch as ModelApiProfilePatch;
}

function requiredGitAccessRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SyntaxError("expectedRevision must be a non-negative integer");
  }
  return value;
}

function requiredBrowserGitAccessCredential(
  value: unknown,
): NonNullable<GitAccessConfigPatch["credential"]> {
  const credential = asRecord(value);
  if (credential.kind === "unconfigured") {
    assertOnlyKeys(credential, ["kind"], "Git identity credential");
    return { kind: "unconfigured" };
  }
  if (credential.kind === "external-file") {
    assertOnlyKeys(credential, ["kind", "privateKeyPath"], "Git identity credential");
    return {
      kind: "external-file",
      privateKeyPath: requiredString(credential.privateKeyPath, "privateKeyPath"),
    };
  }
  throw new SyntaxError("credential.kind must be unconfigured or external-file");
}

function requiredStringValue(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new SyntaxError(`${field} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new SyntaxError(`${field} is required`);
  return normalized;
}

function requiredExecutionCommand(value: unknown): string {
  if (typeof value !== "string") throw new SyntaxError("command must be a string");
  if (!value.trim()) throw new SyntaxError("command is required");
  return value;
}

function requiredGitProxyMode(value: unknown): "direct" | "hclient" {
  if (value !== "direct" && value !== "hclient") {
    throw new SyntaxError("proxyMode must be direct or hclient");
  }
  return value;
}

function requiredGitProxyPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new SyntaxError("proxyPort must be an integer between 1 and 65535");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`${field} is required`);
  }
  return result;
}

function requiredSubagentRole(value: unknown): SubagentRole {
  if (value === "worker" || value === "researcher" || value === "planner" || value === "reviewer") {
    return value;
  }
  throw new SyntaxError("role must be worker, researcher, planner, or reviewer");
}

function requiredWorkflowNodes(value: unknown): SessionWorkflowNodeInput[] {
  if (!Array.isArray(value)) throw new SyntaxError("nodes must be an array");
  return value.map((raw, index) => {
    const node = asRecord(raw);
    const prefix = `nodes[${index}]`;
    const key = requiredStringValue(node.key, `${prefix}.key`);
    const dependsOn = node.dependsOn === undefined
      ? undefined
      : requiredExactStringArray(node.dependsOn, `${prefix}.dependsOn`);
    const timeoutSeconds = node.timeoutSeconds === undefined
      ? undefined
      : requiredPositiveInteger(node.timeoutSeconds, `${prefix}.timeoutSeconds`);
    if (node.kind === "subagent") {
      assertOnlyKeys(node, [
        "key", "kind", "dependsOn", "role", "task", "context",
        "timeoutSeconds", "workspaceAccess", "moduleIds", "skillNames",
      ], `Workflow Subagent ${prefix}`);
      const workspaceAccess = node.workspaceAccess === undefined
        ? undefined
        : requiredWorkflowSubagentWorkspaceAccess(node.workspaceAccess, `${prefix}.workspaceAccess`);
      return {
        key,
        kind: "subagent" as const,
        ...(dependsOn === undefined ? {} : { dependsOn }),
        role: requiredSubagentRole(node.role),
        task: requiredStringValue(node.task, `${prefix}.task`),
        ...(node.context === undefined
          ? {}
          : { context: requiredStringValue(node.context, `${prefix}.context`, true) }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(workspaceAccess === undefined ? {} : { workspaceAccess }),
        ...(node.moduleIds === undefined
          ? {}
          : { moduleIds: requiredExactStringArray(node.moduleIds, `${prefix}.moduleIds`) }),
        ...(node.skillNames === undefined
          ? {}
          : { skillNames: requiredExactStringArray(node.skillNames, `${prefix}.skillNames`) }),
      };
    }
    if (node.kind === "shell") {
      assertOnlyKeys(node, [
        "key", "kind", "dependsOn", "command", "timeoutSeconds",
        "workspaceAccess", "networkEnabled",
      ], `Workflow shell ${prefix}`);
      return {
        key,
        kind: "shell" as const,
        ...(dependsOn === undefined ? {} : { dependsOn }),
        command: requiredExecutionCommand(node.command),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(node.workspaceAccess === undefined
          ? {}
          : {
              workspaceAccess: requiredWorkflowWorkspaceAccess(
                node.workspaceAccess,
                `${prefix}.workspaceAccess`,
              ),
            }),
        ...(node.networkEnabled === undefined
          ? {}
          : { networkEnabled: requiredBoolean(node.networkEnabled, `${prefix}.networkEnabled`) }),
      };
    }
    throw new SyntaxError(`${prefix}.kind must be subagent or shell`);
  });
}

function requiredWorkflowWorkspaceAccess(value: unknown, field: string): WorkspaceAccess {
  if (value === "off" || value === "read_only" || value === "read_write") return value;
  throw new SyntaxError(`${field} must be off, read_only, or read_write`);
}

function requiredWorkflowSubagentWorkspaceAccess(
  value: unknown,
  field: string,
): "off" | "read_only" {
  if (value === "off" || value === "read_only") return value;
  throw new SyntaxError(`${field} must be off or read_only`);
}

function requiredWorkflowReplayDecision(value: unknown): SessionWorkflowReplayDecision {
  if (value === "retry" || value === "skip" || value === "cancel") return value;
  throw new SyntaxError("decision must be retry, skip, or cancel");
}

function optionalDocumentString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value.trim() || null;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SyntaxError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SyntaxError(`${field} must be a positive safe integer`);
  }
  return value;
}

function requiredExactStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SyntaxError(`${field} must be a string array`);
  }
  return [...value];
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requiredMeetingPresetParameters(
  value: unknown,
): NonNullable<UpdateMeetingPresetInput["parameters"]> {
  const input = asRecord(value);
  const output: NonNullable<UpdateMeetingPresetInput["parameters"]> = {};
  for (const key of [
    "temperature",
    "topP",
    "frequencyPenalty",
    "presencePenalty",
    "maxTokens",
    "seed",
  ] as const) {
    if (input[key] !== undefined) output[key] = requiredNumber(input[key], `parameters.${key}`);
  }
  return output;
}

function requiredMeetingPresetPromptPatches(
  value: unknown,
): NonNullable<UpdateMeetingPresetInput["prompts"]> {
  if (!Array.isArray(value)) throw new Error("prompts must be an array");
  return value.map((entry, index) => {
    const input = asRecord(entry);
    const role = input.role;
    if (
      role !== undefined &&
      role !== "system" &&
      role !== "user" &&
      role !== "assistant"
    ) {
      throw new Error(`prompts[${index}].role must be system, user, or assistant`);
    }
    return {
      id: requiredString(input.id, `prompts[${index}].id`),
      ...(input.name === undefined
        ? {}
        : { name: optionalDocumentString(input.name, `prompts[${index}].name`) }),
      ...(role === undefined ? {} : { role }),
      ...(input.content === undefined
        ? {}
        : {
            content: optionalDocumentString(
              input.content,
              `prompts[${index}].content`,
            ),
          }),
      ...(input.enabled === undefined
        ? {}
        : { enabled: requiredBoolean(input.enabled, `prompts[${index}].enabled`) }),
    };
  });
}

function requiredMode(value: unknown): "sms" | "rp" {
  if (value === "sms" || value === "rp") return value;
  throw new SyntaxError("mode must be sms or rp");
}

function requiredConversationSpace(value: unknown): "normal" | "secret" {
  if (value === "normal" || value === "secret") return value;
  throw new SyntaxError("conversationSpace must be normal or secret");
}

function assertCharacterSkillMutationScope(
  body: Record<string, unknown>,
  characterId: string,
  conversationSpace: ConversationSpace,
): void {
  const bodyCharacterId = requiredStringValue(body.characterId, "characterId");
  const bodyConversationSpace = requiredConversationSpace(body.conversationSpace);
  if (
    body.characterId !== bodyCharacterId ||
    bodyCharacterId !== characterId ||
    bodyConversationSpace !== conversationSpace
  ) {
    throw new ConversationNotFoundError(characterId);
  }
}

function assertCharacterSkillStageId(
  body: Record<string, unknown>,
  routeStageId: string,
): void {
  const bodyStageId = requiredStringValue(body.stageId, "stageId");
  if (body.stageId !== bodyStageId || bodyStageId !== routeStageId) {
    throw new AgentSkillInstallerError(
      "character Skill review does not match the requested stage",
      "STAGE_NOT_FOUND",
    );
  }
}

function assertCharacterSkillPackageName(
  body: Record<string, unknown>,
  routePackageName: string,
): void {
  const bodyPackageName = requiredStringValue(body.name, "name");
  if (body.name !== bodyPackageName || bodyPackageName !== routePackageName) {
    throw new AgentSkillInstallerError(
      "character Skill package does not match the requested package",
      "SKILL_NOT_FOUND",
    );
  }
}

function requiredSecretConversationCharacterId(
  body: Record<string, unknown>,
  conversationSpace: ConversationSpace,
): string | undefined {
  if (conversationSpace === "normal") return undefined;
  const characterId = optionalString(body.characterId);
  if (!characterId) throw new SyntaxError("characterId is required for secret conversation space");
  return characterId;
}

function requiredConversationSpaces(value: unknown): Array<"normal" | "secret"> {
  if (!Array.isArray(value)) throw new SyntaxError("enabledSpaces must be an array");
  const spaces = value.map(requiredConversationSpace);
  if (new Set(spaces).size !== spaces.length) {
    throw new SyntaxError("enabledSpaces must not contain duplicates");
  }
  return spaces;
}

function requiredPersonVisibility(value: unknown): "global" | "selected_characters" {
  if (value === "global" || value === "selected_characters") return value;
  throw new SyntaxError("visibility must be global or selected_characters");
}

function requiredInteractionAction(value: unknown): "propose" | "begin" | "end" | "cancel" | "undo" {
  if (value === "propose" || value === "begin" || value === "end" || value === "cancel" || value === "undo") {
    return value;
  }
  throw new SyntaxError("interaction action must be propose, begin, end, cancel, or undo");
}

function requiredWorldAttributeScope(value: unknown): "world" | "character" {
  if (value === "world" || value === "character") return value;
  throw new SyntaxError("scope must be world or character");
}

function contextPlannerBudgets(search: URLSearchParams) {
  const output: Record<string, number> = {};
  for (const key of [
    "dynamicTokens", "memoryTokens", "realityMemoryTokens", "roleplayMemoryTokens",
    "sceneTokens", "worldCoreTokens", "worldRuntimeTokens", "interactionTokens",
    "realityItems", "roleplayItems", "bootstrapItems",
  ]) {
    const value = optionalPositiveInteger(search.get(key));
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function requiredWorkspaceAccess(value: unknown): WorkspaceAccess {
  if (value === "off" || value === "read_only" || value === "read_write") return value;
  throw new AgentPermissionValidationError("workspaceAccess must be off, read_only, or read_write");
}

function optionalScheduleStatus(value: string | null): ScheduleItemStatus | undefined {
  return value === "scheduled" || value === "completed" || value === "cancelled" ? value : undefined;
}

function optionalScheduleKind(value: string | null): ScheduleItemKind | undefined {
  return value === "event" || value === "task" || value === "reminder" ? value : undefined;
}

function optionalScheduleOwnerType(value: string | null): ScheduleOwnerType | undefined {
  return value === "user" || value === "character" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("string array required");
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalMemoryType(value: unknown): MemoryType | undefined {
  return value === "user_fact" || value === "preference" || value === "relationship_event" ||
    value === "goal" || value === "person" || value === "project" ||
    value === "world_fact" || value === "plot_event" || value === "boundary"
    ? value
    : undefined;
}

function requiredOkfImportRealm(value: string | null): OkfImportRealm {
  if (value === null || value === "" || value === "auto") return "auto";
  if (value === "reality" || value === "roleplay") return value;
  throw new OkfBundleError("realm must be auto, reality, or roleplay", "OKF_TARGET_INVALID");
}

function requiredMemoryType(value: unknown): MemoryType {
  const type = optionalMemoryType(value);
  if (!type) {
    throw new RpMemoryValidationError("valid memory type is required", "RP_MEMORY_TYPE_INVALID");
  }
  return type;
}

function requiredRoleplayMemoryType(value: unknown): RoleplayMemoryType {
  if (
    value !== "relationship_event" && value !== "world_fact" &&
    value !== "plot_event" && value !== "boundary"
  ) {
    throw new RpMemoryValidationError(
      "roleplay memory type must be relationship_event, world_fact, plot_event, or boundary; use User Profile for real-user facts and preferences",
      "RP_MEMORY_TYPE_INVALID",
    );
  }
  return value;
}

function requiredRealityMemoryType(value: unknown): RealityMemoryType {
  if (
    value !== "user_fact" && value !== "preference" && value !== "goal" &&
    value !== "person" && value !== "project" && value !== "boundary"
  ) {
    throw new MemoryLifecycleError(
      "reality memory type must be user_fact, preference, goal, person, project, or boundary",
      "REALITY_MEMORY_CONTRACT_INVALID",
    );
  }
  return value;
}

function memoryLifecycleHttpStatus(code: string): number {
  if (code === "MEMORY_NOT_FOUND") return 404;
  if (
    code === "REALITY_MEMORY_CONTRACT_INVALID" ||
    code === "ROLEPLAY_MEMORY_CONTRACT_INVALID" ||
    code === "MEMORY_IDEMPOTENCY_REQUIRED" ||
    code === "MEMORY_INPUT_INVALID"
  ) return 400;
  return 409;
}

function optionalMemoryRealm(value: unknown): MemoryRealm | undefined {
  return value === "reality" || value === "roleplay" || value === "legacy" ? value : undefined;
}

function optionalMemoryValidity(value: unknown): MemoryValidity | undefined {
  return value === "pending" || value === "active" || value === "superseded" ||
    value === "rejected" || value === "archived" || value === "deleted"
    ? value
    : undefined;
}

function optionalUnitNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryLifecycleError(`${field} must be between 0 and 1`, "MEMORY_INPUT_INVALID");
  }
  return value;
}

function memoryControlPlaneEdit(
  body: Record<string, unknown>,
  realm?: MemoryRealm,
): MemoryControlPlaneEdit {
  const edit: MemoryControlPlaneEdit = {};
  if (body.type !== undefined) {
    edit.type = realm === RP_MEMORY_REALM
      ? requiredRoleplayMemoryType(body.type)
      : realm === "reality"
        ? requiredRealityMemoryType(body.type)
        : requiredMemoryType(body.type);
  }
  if (body.key !== undefined) edit.key = optionalString(body.key);
  if (body.content !== undefined) edit.content = requiredString(body.content, "content");
  if (body.salience !== undefined) edit.salience = optionalUnitNumber(body.salience, "salience");
  if (body.confidence !== undefined) edit.confidence = optionalUnitNumber(body.confidence, "confidence");
  if (body.tags !== undefined) edit.tags = optionalStringArray(body.tags);
  return edit;
}

function assertCharacterMemoryRealm(body: Record<string, unknown>): void {
  if (body.realm !== undefined && body.realm !== RP_MEMORY_REALM) {
    throw new RpMemoryValidationError(
      "RP memory must use realm=roleplay; use User Profile for global reality data",
    );
  }
  if (body.scope !== undefined && body.scope !== RP_MEMORY_SCOPE) {
    throw new RpMemoryValidationError(
      "RP memory must use scope=character; use User Profile for global reality data",
    );
  }
  if (typeof body.characterId !== "string" || !body.characterId.trim()) {
    throw new RpMemoryValidationError(
      "RP memory requires a characterId; use User Profile for global reality data",
    );
  }
}

function assertImmutableMemoryRealm(body: Record<string, unknown>): void {
  if (body.realm !== undefined || body.scope !== undefined || body.characterId !== undefined) {
    throw new RpMemoryValidationError(
      "RP memory realm, scope, and characterId are immutable; create a new character-bound memory instead",
    );
  }
}

function messageHistoryQuery(url: URL, defaultLimit = 40) {
  return historyQuery({ limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : defaultLimit,
    ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}),
    ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}),
    ...(url.searchParams.has("around") ? { around: url.searchParams.get("around")! } : {}),
  });
}

function visibleConversationMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !(message.role === "custom" && message.display === false));
}

function latestConversationPreview(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") continue;
    if (message.role === "custom" && message.display === false) continue;
    const content = typeof message.content === "string"
      ? message.content
      : message.content.flatMap((entry) =>
          entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : []).join(" ");
    const preview = content.replace(/\s+/gu, " ").trim();
    if (preview) return preview.slice(0, 80);
  }
  return "";
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function optionalQueryInteger(
  value: string | null,
  field: string,
  minimum: number,
): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new SyntaxError(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function optionalQueryBoolean(value: string | null, field: string): boolean | undefined {
  if (value === null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SyntaxError(`${field} must be true or false`);
}

function requiredSessionGoalPriority(value: unknown): SessionGoalPriority {
  if (value === "low" || value === "normal" || value === "high" || value === "urgent") {
    return value;
  }
  throw new SyntaxError("priority must be low, normal, high, or urgent");
}

function requiredSessionGoalStatus(value: unknown): SessionGoalStatus {
  if (
    value === "planned" ||
    value === "active" ||
    value === "blocked" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new SyntaxError("status must be planned, active, blocked, completed, or cancelled");
}

function requiredSessionGoalTodoStatus(value: unknown): SessionGoalTodoStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new SyntaxError("status must be pending, in_progress, completed, or cancelled");
}

function optionalProactiveMessageStatus(value: unknown): ProactiveMessageStatus | undefined {
  return value === "pending" || value === "delivered" || value === "skipped" || value === "failed"
    ? value
    : undefined;
}

function requiredWorldStoryAction(
  value: unknown,
): "propose" | "begin" | "advance" | "resolve" | "cancel" | "undo" {
  if (value === "propose" || value === "begin" || value === "advance" || value === "resolve" || value === "cancel" || value === "undo") {
    return value;
  }
  throw new SyntaxError("action must be propose, begin, advance, resolve, cancel, or undo");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  recordHeadlessIdempotentJsonResponse(response, statusCode, body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendAvatar(response: ServerResponse, avatar: AvatarAsset): void {
  response.writeHead(200, {
    "content-type": avatar.contentType,
    "content-length": avatar.bytes.byteLength,
    "cache-control": "private, max-age=3600",
    "last-modified": new Date(avatar.updatedAt).toUTCString(),
    "x-content-type-options": "nosniff",
  });
  response.end(avatar.bytes);
}

async function sendWorkspaceFile(response: ServerResponse, asset: WorkspaceFileAsset): Promise<void> {
  const disposition = asset.inline ? "inline" : "attachment";
  const asciiName = asset.entry.name.replace(/[^A-Za-z0-9._-]/gu, "_") || "download";
  response.writeHead(200, {
    "content-type": asset.entry.contentType ?? "application/octet-stream",
    "content-length": asset.entry.size,
    "content-disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(asset.entry.name)}`,
    "cache-control": "private, no-store",
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "font-src data:",
      "img-src data:",
      "object-src 'none'",
      "script-src 'none'",
      "style-src 'unsafe-inline'",
      "sandbox",
    ].join("; "),
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  await pipeline(createReadStream(asset.absolutePath), response);
}

function workspaceFileHttpStatus(code: WorkspaceFileError["code"]): number {
  if (code === "WORKSPACE_NOT_FOUND") return 404;
  if (code === "WORKSPACE_CONFLICT") return 409;
  if (code === "WORKSPACE_FILE_TOO_LARGE") return 413;
  if (code === "WORKSPACE_PREVIEW_UNSUPPORTED") return 415;
  return 400;
}

function agentSkillInstallerHttpStatus(code: string): number {
  if (
    code === "STAGE_NOT_FOUND" ||
    code === "SKILL_NOT_FOUND" ||
    code === "CHARACTER_NOT_FOUND"
  ) return 404;
  if (
    code === "STAGE_EXPIRED" ||
    code === "STAGE_DIGEST_MISMATCH" ||
    code === "STAGE_CHANGED" ||
    code === "DIGEST_MISMATCH" ||
    code === "PACKAGE_DIGEST_MISMATCH" ||
    code === "PACKAGE_ENABLED" ||
    code === "SKILL_EXISTS" ||
    code === "SKILL_NAME_CONFLICT" ||
    code === "SKILL_SOURCE_MISMATCH"
  ) return 409;
  if (code === "UNINSTALL_FAILED" || code === "UNINSTALL_ROLLBACK_FAILED") return 500;
  if (code === "REQUEST_ABORTED" || code === "REQUEST_TIMEOUT") return 408;
  if (
    code === "DOWNLOAD_TOO_LARGE" ||
    code === "ARCHIVE_BOMB" ||
    code === "ARCHIVE_TOO_MANY_FILES" ||
    code === "SKILL_TOO_LARGE"
  ) return 413;
  if (code === "ARCHIVE_FORMAT" || code === "CONTENT_TYPE_INVALID") return 415;
  if (
    code === "DNS_EMPTY" ||
    code === "DNS_FAILED" ||
    code === "DNS_INVALID" ||
    code === "GITHUB_METADATA_INVALID" ||
    code === "HTTP_ERROR" ||
    code === "INVALID_REDIRECT" ||
    code === "REDIRECT_LOOP" ||
    code === "REQUEST_FAILED" ||
    code === "TOO_MANY_REDIRECTS"
  ) return 502;
  if (code === "INSTALLER_UNAVAILABLE") return 503;
  if (
    code === "INVALID_INSTALL_RECEIPT" ||
    code === "INVALID_CLOCK" ||
    code === "PUBLISH_FAILED" ||
    code === "ROLLBACK_CHANGED" ||
    code === "SKILL_NAME_CHECK_FAILED" ||
    code === "STAGE_WRITE_FAILED" ||
    code === "UNSAFE_REMOVE" ||
    code === "UNSAFE_STATE_DIRECTORY"
  ) return 500;
  return 422;
}

function agentSkillStageView(stage: AgentSkillStageResult) {
  const packageName = stage.source.packagePath
    ? stage.source.packagePath.split("/").filter(Boolean).at(-1) ?? stage.metadata.name
    : stage.metadata.name;
  return {
    id: stage.stageId,
    sourceUrl: stage.source.requestedUrl,
    sourceHost: new URL(stage.source.requestedUrl).hostname.toLowerCase(),
    ...(stage.source.requestedRef ? { resolvedRef: stage.source.requestedRef } : {}),
    ...(stage.source.resolvedCommit ? { resolvedCommit: stage.source.resolvedCommit } : {}),
    packageName,
    skillName: stage.metadata.name,
    description: stage.metadata.description,
    sha256: stage.digest,
    archiveSha256: stage.archiveSha256,
    files: stage.manifest,
    totalBytes: stage.metadata.unpackedBytes,
    expiresAt: stage.expiresAt,
    skillMarkdown: stage.skillMarkdown,
  };
}

function characterAgentSkillStageReviewView(stage: AgentSkillStageResult) {
  return {
    ...stage,
    reviewId: stage.stageId,
  };
}

function characterAgentSkillStageSummary(stage: AgentSkillStageResult) {
  const source = agentSkillSafeSourceSummary(stage.source);
  return {
    reviewId: stage.stageId,
    name: stage.metadata.name,
    description: stage.metadata.description,
    digest: stage.digest,
    fileCount: stage.metadata.files,
    expiresAt: stage.expiresAt,
    ...source,
  };
}

function characterAgentSkillPackageSummary(skill: CharacterAgentSkillPackage) {
  return {
    characterId: skill.characterId,
    conversationSpace: skill.conversationSpace,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    digest: skill.digest,
    fileCount: skill.manifest.length,
    integrity: skill.integrity,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    ...agentSkillSafeSourceSummary(skill.source),
  };
}

function agentSkillSafeSourceSummary(source: AgentSkillStageResult["source"]) {
  let sourceHost = "";
  try {
    sourceHost = new URL(source.requestedUrl).hostname.toLowerCase();
  } catch {
    // Persisted corrupt provenance must not make the safe inventory endpoint fail.
  }
  return {
    ...(sourceHost ? { sourceHost } : {}),
    ...(source.requestedRef ? { ref: source.requestedRef } : {}),
    ...(source.resolvedCommit ? { commit: source.resolvedCommit } : {}),
  };
}

function avatarUrl(pathname: string, avatar: AvatarAsset | undefined): string | undefined {
  return avatar ? `${pathname}?v=${encodeURIComponent(avatar.updatedAt)}` : undefined;
}

function withCharacterAvatar(kernel: CompanionKernel, character: CharacterProfile) {
  const customAvatarUrl = avatarUrl(
    `/api/v1/avatars/characters/${encodeURIComponent(character.id)}`,
    kernel.avatarService.getCharacter(character.id),
  );
  return {
    ...character,
    avatarUrl: customAvatarUrl ?? (
      isDefaultCharacterName(character.name) ? DEFAULT_CHARACTER_AVATAR_PATH : undefined
    ),
  };
}

function sendHtml(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  attachLocalControlPlaneCookie(request, response);
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendStreamEvent(response: ServerResponse, payload: unknown): void {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function streamEventPayload(event: AgentSessionEvent): Record<string, unknown> | undefined {
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return { type: "delta", delta: event.assistantMessageEvent.delta };
    }
    if (event.assistantMessageEvent.type === "thinking_start") {
      return { type: "reasoning_status", phase: "start" };
    }
    if (event.assistantMessageEvent.type === "thinking_end") {
      return { type: "reasoning_status", phase: "end" };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return undefined;
    }
  }
  if (event.type === "tool_execution_start") {
    return { type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      result: event.result,
    };
  }
  if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
    return { ...event };
  }
  return { type: "lifecycle", eventType: event.type };
}

function privateInboxEventPayload(event: PrivateInboxEvent): Record<string, unknown> | undefined {
  if (event.type === "burst_done") {
    return { ...event, response: { ...event.response, events: [] } };
  }
  if (event.type !== "agent_event") return event;
  const payload = streamEventPayload(event.event);
  return payload
    ? { type: "agent_event", burstId: event.burstId, event: payload }
    : undefined;
}
