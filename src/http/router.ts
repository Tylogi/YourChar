import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import {
  CompanionKernel,
  ConversationArchivedError,
  ConversationDeletionConfirmationError,
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
} from "../domain/index.js";
import type { MessageRequest, ModelApiConfigPatch, ModelApiProfilePatch } from "../domain/index.js";
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
import { TestRunRegistry, type ScriptedModelResponse } from "../testing/index.js";
import { renderAppHtml } from "./ui.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { UserProfileValidationError } from "../profile/service.js";
import { AvatarValidationError, type AvatarAsset } from "../profile/avatar-service.js";
import { SystemPromptValidationError } from "../profile/system-prompt-service.js";
import { CharacterSoulValidationError } from "../rp/soul.js";
import { AgentPermissionValidationError } from "../modules/permissions.js";
import type { AgentPermissionsPatch, WorkspaceAccess } from "../modules/types.js";
import { TavilyApiError, TavilyConfigurationError } from "../tavily/service.js";
import type { TavilyApiConfigPatch } from "../tavily/types.js";
import { VisionApiError, VisionConfigurationError } from "../vision/service.js";
import type { VisionApiConfigPatch } from "../vision/types.js";
import { browserAsset } from "./browser-assets.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryVaultError } from "../memory-vault/errors.js";
import { MemoryLifecycleError } from "../memory-coordinator/lifecycle.js";
import type { MemoryControlPlaneEdit } from "../memory-coordinator/types.js";
import {
  MAX_OKF_ARCHIVE_BYTES,
  OkfBundleError,
  type OkfImportRealm,
} from "../okf/index.js";
import { listFeatureTestCases, runFeatureTest } from "../evaluation/feature-tests.js";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  WorkspaceFileError,
  type WorkspaceFileAsset,
} from "../workspace/file-service.js";

export type HttpServerOptions = {
  kernel?: CompanionKernel;
  testMode?: boolean;
  testRuns?: TestRunRegistry;
};

const ownedResourceDisposers = new WeakMap<Server, () => void>();

export function disposeHttpServerOwnedResources(server: Server): void {
  ownedResourceDisposers.get(server)?.();
}

export function createHttpServer(options: HttpServerOptions = {}) {
  const ownsKernel = !options.kernel;
  const kernel = options.kernel ?? new CompanionKernel();
  const testMode = options.testMode ?? process.env.RP_AGENT_TEST_MODE === "1";
  const ownsTestRuns = !options.testRuns && testMode;
  const testRuns = options.testRuns ?? (testMode ? new TestRunRegistry() : undefined);
  const server = createServer(async (request, response) => {
    try {
      await route({ kernel, testRuns, request, response });
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        console.error("RP Agent HTTP request failed after the response started", error);
        if (!response.writableEnded) response.destroy(asError(error));
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { code: "BODY_TOO_LARGE", error: error.message });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { code: "INVALID_JSON", error: error.message });
      } else if (error instanceof SessionModeMismatchError) {
        sendJson(response, 409, { code: "SESSION_MODE_MISMATCH", error: error.message });
      } else if (error instanceof ConversationArchivedError) {
        sendJson(response, 409, { code: "SESSION_ARCHIVED", error: error.message });
      } else if (error instanceof ConversationNotFoundError) {
        sendJson(response, 404, { code: "SESSION_NOT_FOUND", error: error.message });
      } else if (error instanceof ConversationTitleValidationError) {
        sendJson(response, 400, { code: "SESSION_TITLE_INVALID", error: error.message });
      } else if (error instanceof ConversationDeletionConfirmationError) {
        sendJson(response, 400, { code: "SESSION_DELETE_CONFIRMATION_REQUIRED", error: error.message });
      } else if (error instanceof SessionBatchValidationError) {
        sendJson(response, 400, { code: "SESSION_BATCH_INVALID", error: error.message });
      } else if (error instanceof TurnRetryUnavailableError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof MessageRevisionError) {
        sendJson(response, 409, { code: error.code, error: error.message });
      } else if (error instanceof SessionCharacterMismatchError) {
        sendJson(response, 409, { code: "SESSION_CHARACTER_MISMATCH", error: error.message });
      } else if (error instanceof CharacterBindingRequiredError) {
        sendJson(response, 422, { code: "CHARACTER_REQUIRED", error: error.message });
      } else if (error instanceof GroupChatNotFoundError) {
        sendJson(response, 404, { code: "GROUP_CHAT_NOT_FOUND", error: error.message });
      } else if (error instanceof GroupChatValidationError) {
        sendJson(response, 400, { code: "GROUP_CHAT_INVALID", error: error.message });
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
      } else if (error instanceof OkfBundleError) {
        sendJson(response, 422, { code: error.code, error: error.message });
      } else if (error instanceof AgentPermissionValidationError) {
        sendJson(response, 400, { code: "AGENT_PERMISSION_INVALID", error: error.message });
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
  request: IncomingMessage;
  response: ServerResponse;
}) {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://127.0.0.1");
  const pathname = normalizePath(url.pathname);

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

  const featureTestMatch = pathname.match(/^\/api\/v1\/feature-tests\/([^/]+)\/run$/);
  if (featureTestMatch && method === "POST") {
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      result: await runFeatureTest(
        kernel,
        decodeURIComponent(featureTestMatch[1]),
        optionalString(body.characterId),
      ),
    });
    return;
  }

  if (
    method === "GET" &&
    (pathname === "/" || pathname === "/ui" || pathname === "/ui/index.html" || pathname === "/index.html")
  ) {
    sendHtml(input.response, 200, renderAppHtml());
    return;
  }

  if (method === "GET" && pathname === "/api") {
    sendJson(input.response, 200, {
      name: "RP Agent",
      status: "ok",
      ui: "/ui",
      messageEndpoint: "POST /api/v1/sessions/{id}/messages",
      debugContextLogs: "GET /api/debug/context-logs",
      debugModelTraces: "GET /api/debug/model-traces",
      debugContextEconomics: "GET /api/debug/context-economics",
      agentModules: "GET /api/v1/agent-modules",
      agentPermissions: "GET/PATCH /api/v1/agent-permissions",
      userProfile: "GET/PATCH /api/v1/user-profile",
      modelApiSettings: "GET/PATCH /api/settings/model-api",
      tavilySettings: "GET/PATCH /api/settings/tavily",
      visionSettings: "GET/PATCH /api/settings/vision",
      traceArchiveSettings: "GET/PATCH /api/settings/trace-archive",
    });
    return;
  }

  if (method === "GET" && pathname === "/api/v1/sessions") {
    const records = await kernel.listSessions();
    const metadata = new Map(kernel.listConversationMetadata().map((entry) => [entry.id, entry]));
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    sendJson(input.response, 200, {
      sessions: records.filter((record) => includeArchived || !metadata.get(record.id)?.archivedAt).map((record) => ({
        id: record.id,
        mode: metadata.get(record.id)?.mode,
        characterId: metadata.get(record.id)?.characterId,
        title: metadata.get(record.id)?.title,
        archivedAt: metadata.get(record.id)?.archivedAt,
        lastTurnStatus: metadata.get(record.id)?.lastTurnStatus,
        lastTurnCanRetry: metadata.get(record.id)?.lastTurnCanRetry ?? false,
        sleepState: metadata.get(record.id)?.sleepState ?? "awake",
        sleepCheckpointAt: metadata.get(record.id)?.sleepCheckpointAt,
        messageCount: visibleConversationMessages(record.messages).length,
        preview: latestConversationPreview(record.messages),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
    });
    return;
  }

  if (method === "POST" && pathname === "/api/v1/sessions/batch") {
    const body = asRecord(await readJson(input.request));
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
    const missing = sessionIds.filter((sessionId) => !metadata.has(sessionId));
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
    const action = body.action;
    if (action !== "archive" && action !== "delete") {
      throw new SessionBatchValidationError("action must be archive or delete");
    }
    const sessionIds = requireBatchIds(body.sessionIds, "sessionIds");
    const groupIds = requireBatchIds(body.groupIds, "groupIds");
    const total = sessionIds.length + groupIds.length;
    if (total < 1 || total > 100) {
      throw new SessionBatchValidationError("batch must contain between 1 and 100 conversations");
    }
    const metadata = new Map(kernel.listConversationMetadata().map((entry) => [entry.id, entry]));
    const groups = new Map(kernel.listGroupChats(true).map((entry) => [entry.id, entry]));
    const missingSession = sessionIds.find((sessionId) => !metadata.has(sessionId));
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
    const session = kernel.archiveConversation(decodeURIComponent(archiveSessionMatch[1]));
    sendJson(input.response, 200, { session });
    return;
  }

  const restoreSessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/restore$/);
  if (restoreSessionMatch && method === "POST") {
    const session = kernel.restoreConversation(decodeURIComponent(restoreSessionMatch[1]));
    sendJson(input.response, 200, { session });
    return;
  }

  const sessionMetadataMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (sessionMetadataMatch && method === "PATCH") {
    const body = asRecord(await readJson(input.request));
    const title = typeof body.title === "string" ? body.title : "";
    const session = kernel.renameConversation(decodeURIComponent(sessionMetadataMatch[1]), title);
    sendJson(input.response, 200, { session });
    return;
  }
  if (sessionMetadataMatch && method === "DELETE") {
    const body = asRecord(await readJson(input.request));
    const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
    sendJson(
      input.response,
      200,
      await kernel.deleteConversation(decodeURIComponent(sessionMetadataMatch[1]), confirmation),
    );
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

  const groupMessagesMatch = pathname.match(/^\/api\/v1\/group-chats\/([^/]+)\/messages$/);
  if (groupMessagesMatch && method === "GET") {
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

  const messageMatch = pathname.match(/^\/api(?:\/v1)?\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && method === "POST") {
    const sessionId = decodeURIComponent(messageMatch[1]);
    const body = requireCharacterBoundMessage(kernel, sessionId, await readJson(input.request));
    const result = await kernel.sendMessage(sessionId, body);
    sendJson(input.response, 200, result);
    return;
  }

  if (messageMatch && method === "GET") {
    const messages = await kernel.getConversationTranscript(decodeURIComponent(messageMatch[1]));
    sendJson(input.response, 200, visibleConversationMessages(messages));
    return;
  }

  const reviseMessageMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/(edit|retract)$/);
  if (reviseMessageMatch && method === "POST") {
    const sessionId = decodeURIComponent(reviseMessageMatch[1]);
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
      const result = await kernel.streamMessage(
        sessionId,
        body,
        (event) => {
          const payload = streamEventPayload(event);
          if (payload) sendStreamEvent(input.response, payload);
        },
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

  const cancelMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/cancel$/);
  if (cancelMatch && method === "POST") {
    sendJson(input.response, 200, {
      cancelled: await kernel.cancelMessage(decodeURIComponent(cancelMatch[1])),
    });
    return;
  }

  const retryMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/retry$/);
  if (retryMatch && method === "POST") {
    const sessionId = decodeURIComponent(retryMatch[1]);
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

  if (pathname === "/api/v1/agent-permissions") {
    if (method === "GET") {
      sendJson(input.response, 200, { permissions: kernel.getAgentPermissions() });
      return;
    }
    if (method === "PATCH") {
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
    sendJson(input.response, 200, {
      detail: kernel.getAgentModuleDetail(decodeURIComponent(moduleMatch[1])),
    });
    return;
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
    const body = asRecord(await readJson(input.request));
    sendJson(input.response, 200, {
      module: kernel.setAgentModuleEnabled(
        decodeURIComponent(moduleMatch[1]),
        requiredBoolean(body.enabled, "enabled"),
      ),
    });
    return;
  }

  if (pathname === "/api/v1/user-profile") {
    if (method === "GET") {
      sendJson(input.response, 200, {
        profile: kernel.getUserProfile(),
        avatarUrl: avatarUrl("/api/v1/avatars/user", kernel.getUserAvatar()),
      });
      return;
    }
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      if (typeof body.markdown !== "string") throw new Error("markdown must be a string");
      sendJson(input.response, 200, { profile: kernel.updateUserProfile(body.markdown) });
      return;
    }
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

  if (pathname === "/api/v1/memory-coordinator/status" && method === "GET") {
    sendJson(input.response, 200, { coordinator: kernel.getMemoryCoordinatorStatus() });
    return;
  }

  if (pathname === "/api/v1/relationship-coordinator/status" && method === "GET") {
    sendJson(input.response, 200, { coordinator: kernel.getRelationshipCoordinatorStatus() });
    return;
  }

  if (pathname === "/api/v1/memory-coordinator/memories" && method === "GET") {
    const stats = new Map(kernel.memoryRetrievalStats().map((entry) => [entry.memoryId, entry]));
    sendJson(input.response, 200, {
      memories: kernel.listMemories({
        realm: optionalMemoryRealm(url.searchParams.get("realm")),
        characterId: optionalString(url.searchParams.get("characterId")),
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

  if (
    method === "GET" &&
    (pathname === "/api/v1/context-plan/preview" || pathname === "/api/v1/memory-retrieval/preview")
  ) {
    const mode = requiredMode(url.searchParams.get("mode"));
    const plan = kernel.previewContextPlan({
      mode,
      sessionId: requiredString(url.searchParams.get("sessionId"), "sessionId"),
      ...(optionalString(url.searchParams.get("characterId"))
        ? { characterId: optionalString(url.searchParams.get("characterId")) }
        : {}),
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
    sendJson(input.response, 200, {
      job: kernel.retryMemoryExtractionJob(decodeURIComponent(memoryJobRetryMatch[1])),
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
        boundaries: optionalStringArray(body.boundaries),
      });
      sendJson(input.response, 201, { character: withCharacterAvatar(kernel, character) });
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

  const characterMatch = pathname.match(/^\/api\/v1\/characters\/([^/]+)$/);
  if (characterMatch) {
    const id = decodeURIComponent(characterMatch[1]);
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
          boundaries: body.boundaries === undefined ? undefined : optionalStringArray(body.boundaries),
        })),
      });
      return;
    }
  }

  const sceneMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/scene$/);
  if (sceneMatch) {
    const sessionId = decodeURIComponent(sceneMatch[1]);
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
    if (method === "GET") {
      sendJson(input.response, 200, {
        memories: kernel.searchRpMemories({
          query: optionalString(url.searchParams.get("query")),
          characterId: optionalString(url.searchParams.get("characterId")),
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
    const id = decodeURIComponent(memoryMatch[1]);
    if (method === "PATCH") {
      const body = asRecord(await readJson(input.request));
      assertImmutableMemoryRealm(body);
      const current = kernel.listMemories().find((memory) => memory.id === id);
      if (current && current.realm !== "legacy") {
        const edit = memoryControlPlaneEdit(body, current.realm);
        const result = current.validity === "pending"
          ? kernel.confirmMemory(id, edit)
          : current.validity === "active"
            ? kernel.correctMemory(id, edit)
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
        }),
      });
      return;
    }
    if (method === "DELETE") {
      const current = kernel.listMemories().find((memory) => memory.id === id);
      sendJson(input.response, 200, {
        memory: current?.realm === "legacy" ? kernel.deleteRpMemory(id) : kernel.forgetMemory(id),
      });
      return;
    }
  }

  const memoryActionMatch = pathname.match(/^\/api\/v1\/memories\/([^/]+)\/(confirm|correct|reject|archive|forget)$/);
  if (memoryActionMatch && method === "POST") {
    const id = decodeURIComponent(memoryActionMatch[1]);
    const action = memoryActionMatch[2];
    const body = asRecord(await readJson(input.request));
    if (action === "confirm") {
      sendJson(input.response, 200, kernel.confirmMemory(id, memoryControlPlaneEdit(body)));
    } else if (action === "correct") {
      sendJson(input.response, 200, kernel.correctMemory(id, memoryControlPlaneEdit(body)));
    } else if (action === "reject") {
      sendJson(input.response, 200, { memory: kernel.rejectMemory(id, optionalString(body.reason)) });
    } else if (action === "archive") {
      sendJson(input.response, 200, { memory: kernel.archiveMemory(id, optionalString(body.reason)) });
    } else {
      sendJson(input.response, 200, { memory: kernel.forgetMemory(id, optionalString(body.reason)) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/debug/context-logs") {
    const limit = Number(url.searchParams.get("limit") ?? "20");
    sendJson(input.response, 200, { logs: kernel.recentContextLogs(limit) });
    return;
  }

  if (method === "GET" && pathname === "/api/debug/model-traces") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    sendJson(input.response, 200, { traces: kernel.recentModelContextTraces(limit) });
    return;
  }

  if (method === "GET" && pathname === "/api/debug/context-economics") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    sendJson(input.response, 200, { economics: kernel.recentContextEconomics(limit) });
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

  if (pathname === "/api/v1/export" && method === "GET") {
    input.response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=rp-agent-export.json",
      "cache-control": "no-store",
    });
    input.response.end(JSON.stringify(await kernel.exportUserData(), null, 2));
    return;
  }

  if (pathname === "/api/v1/data" && method === "DELETE") {
    const body = asRecord(await readJson(input.request));
    if (body.confirm !== "DELETE_ALL_DATA") {
      sendJson(input.response, 400, { error: "confirm must equal DELETE_ALL_DATA" });
      return;
    }
    kernel.deleteAllUserData();
    sendJson(input.response, 200, { deleted: true });
    return;
  }

  if (method === "GET" && !pathname.startsWith("/api/")) {
    sendHtml(input.response, 200, renderAppHtml());
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
  const metadata = kernel.listConversationMetadata().find((entry) => entry.id === sessionId);
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
  const requestedCharacterId = optionalString(body.characterId);
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
  return {
    mode: requestedMode,
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
  const metadata = kernel.listConversationMetadata().find((entry) => entry.id === sessionId);
  if (metadata?.archivedAt) throw new ConversationArchivedError(sessionId);
  if (!metadata?.characterId) {
    throw new CharacterBindingRequiredError(
      `Session ${sessionId} has no selected character; create a new character-bound session`,
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

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`${field} is required`);
  }
  return result;
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

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requiredMode(value: unknown): "sms" | "rp" {
  if (value === "sms" || value === "rp") return value;
  throw new SyntaxError("mode must be sms or rp");
}

function contextPlannerBudgets(search: URLSearchParams) {
  const output: Record<string, number> = {};
  for (const key of [
    "dynamicTokens", "memoryTokens", "realityMemoryTokens", "roleplayMemoryTokens",
    "sceneTokens", "realityItems", "roleplayItems", "bootstrapItems",
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
      : message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join(" ");
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
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
    "content-security-policy": "default-src 'none'; sandbox",
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

function avatarUrl(pathname: string, avatar: AvatarAsset | undefined): string | undefined {
  return avatar ? `${pathname}?v=${encodeURIComponent(avatar.updatedAt)}` : undefined;
}

function withCharacterAvatar(kernel: CompanionKernel, character: CharacterProfile) {
  return {
    ...character,
    avatarUrl: avatarUrl(
      `/api/v1/avatars/characters/${encodeURIComponent(character.id)}`,
      kernel.avatarService.getCharacter(character.id),
    ),
  };
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
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
