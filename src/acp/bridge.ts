import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type NewSessionRequest,
  type PromptResponse,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type { ConversationSpace, MessageRequest, TurnStatus } from "../domain/types.js";
import { createIdempotencyKey, YourCharClient } from "../sdk/index.js";

const defaultBaseUrl = "http://127.0.0.1:8765";
const defaultMaximumPromptCharacters = 32_000;
const maximumResourceLinks = 32;

export type YourCharAcpBridgeOptions = Readonly<{
  client: YourCharClient;
  characterId: string;
  conversationSpace?: ConversationSpace;
  /** ACP cannot change the server-owned Workspace; the requested cwd must match this admission value. */
  expectedCwd: string;
  timezone?: string;
  maximumPromptCharacters?: number;
  diagnostic?: (message: string, error?: unknown) => void;
}>;

export type YourCharAcpEnvironment = Readonly<{
  client: YourCharClient;
  bridge: Omit<YourCharAcpBridgeOptions, "client">;
}>;

type ActivePrompt = {
  controller: AbortController;
  cancelled: boolean;
  cancellationKey: string;
  cancellationOperation?: Promise<void>;
};

type BridgeSession = {
  acpSessionId: string;
  yourCharSessionId: string;
  message: Omit<MessageRequest, "text">;
  active?: ActivePrompt;
};

/**
 * Builds the deliberately small ACP surface used by automation hosts such as
 * DeepSeek Harness. All product work crosses the authenticated headless SDK.
 */
export function createYourCharAcpAgent(options: YourCharAcpBridgeOptions): AgentApp {
  const characterId = requiredValue(options.characterId, "characterId");
  const expectedCwd = requiredAbsolutePath(options.expectedCwd, "expectedCwd");
  const conversationSpace = options.conversationSpace ?? "normal";
  if (conversationSpace !== "normal" && conversationSpace !== "secret") {
    throw new Error("conversationSpace must be normal or secret");
  }
  const maximumPromptCharacters = options.maximumPromptCharacters ?? defaultMaximumPromptCharacters;
  if (!Number.isSafeInteger(maximumPromptCharacters) || maximumPromptCharacters < 1) {
    throw new Error("maximumPromptCharacters must be a positive safe integer");
  }
  const sessions = new Map<string, BridgeSession>();

  return agent({ name: "yourchar-acp" })
    .onRequest(methods.agent.initialize, async ({ params, signal }) => {
      await options.client.health(signal);
      return {
        protocolVersion: params.protocolVersion === PROTOCOL_VERSION
          ? params.protocolVersion
          : PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
          mcpCapabilities: {},
          sessionCapabilities: {},
        },
        agentInfo: {
          name: "yourchar-acp",
          title: "YourChar ACP bridge",
          version: "0.1.0",
        },
      };
    })
    .onRequest(methods.agent.session.new, async ({ params, signal }) => {
      validateNewSession(params, expectedCwd);
      if (sessions.size > 0) {
        throw RequestError.invalidRequest(
          undefined,
          "this bridge process owns exactly one ACP session",
        );
      }
      const opened = await options.client.openDirectConversation(
        characterId,
        conversationSpace,
        { signal, idempotencyKey: createIdempotencyKey("acp-session") },
      );
      if (
        opened.characterId !== characterId ||
        opened.conversationSpace !== conversationSpace ||
        opened.mode !== "sms" ||
        opened.archivedAt !== undefined
      ) {
        throw new Error("headless API returned an incompatible direct conversation");
      }
      const acpSessionId = `yourchar-acp:${randomUUID()}`;
      sessions.set(acpSessionId, {
        acpSessionId,
        yourCharSessionId: opened.id,
        message: {
          mode: "sms",
          conversationSpace,
          characterId,
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        },
      });
      return { sessionId: acpSessionId };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw unknownSession(params.sessionId);
      if (session.active) {
        throw RequestError.invalidRequest(undefined, "the ACP session already has an active prompt");
      }
      const text = promptText(params.prompt, maximumPromptCharacters);
      const active = activePrompt();
      session.active = active;
      const abortFromRequest = () => {
        void cancelPrompt(options, session, active, signal.reason);
      };
      signal.addEventListener("abort", abortFromRequest, { once: true });
      try {
        return await streamPrompt(options, session, text, active, client);
      } finally {
        signal.removeEventListener("abort", abortFromRequest);
        if (session.active === active) delete session.active;
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session?.active) return;
      await cancelPrompt(options, session, session.active, new Error("ACP session cancelled"));
    });
}

export function yourCharAcpEnvironment(
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): YourCharAcpEnvironment {
  const token = requiredValue(
    environment.YOURCHAR_HEADLESS_API_TOKEN ?? environment.RP_AGENT_HEADLESS_API_TOKEN,
    "YOURCHAR_HEADLESS_API_TOKEN",
  );
  const characterId = requiredValue(environment.YOURCHAR_ACP_CHARACTER_ID, "YOURCHAR_ACP_CHARACTER_ID");
  const conversationSpace = environment.YOURCHAR_ACP_CONVERSATION_SPACE?.trim() || "normal";
  if (conversationSpace !== "normal" && conversationSpace !== "secret") {
    throw new Error("YOURCHAR_ACP_CONVERSATION_SPACE must be normal or secret");
  }
  const expectedCwd = requiredAbsolutePath(environment.YOURCHAR_ACP_CWD?.trim() || cwd, "YOURCHAR_ACP_CWD");
  const timezone = environment.YOURCHAR_ACP_TIMEZONE?.trim();
  if (timezone !== undefined && unicodeLength(timezone) > 200) {
    throw new Error("YOURCHAR_ACP_TIMEZONE must contain at most 200 characters");
  }
  return {
    client: new YourCharClient({
      baseUrl: environment.YOURCHAR_BASE_URL?.trim() || defaultBaseUrl,
      token,
    }),
    bridge: {
      characterId,
      conversationSpace,
      expectedCwd,
      ...(timezone ? { timezone } : {}),
    },
  };
}

export function promptText(blocks: readonly ContentBlock[], maximumCharacters = defaultMaximumPromptCharacters): string {
  const segments: string[] = [];
  let resourceLinks = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      segments.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      resourceLinks += 1;
      if (resourceLinks > maximumResourceLinks) {
        throw RequestError.invalidParams(undefined, `prompt may contain at most ${maximumResourceLinks} resource links`);
      }
      segments.push(`[Resource: ${block.name}] ${block.uri}`);
      continue;
    }
    throw RequestError.invalidParams(
      undefined,
      `unsupported ACP prompt content type: ${block.type}`,
    );
  }
  const text = segments.join("\n").trim();
  if (!text) throw RequestError.invalidParams(undefined, "prompt must contain text or a resource link");
  if (unicodeLength(text) > maximumCharacters) {
    throw RequestError.invalidParams(undefined, `prompt must contain at most ${maximumCharacters} characters`);
  }
  return text;
}

async function streamPrompt(
  options: YourCharAcpBridgeOptions,
  session: BridgeSession,
  text: string,
  active: ActivePrompt,
  client: AgentContext,
): Promise<PromptResponse> {
  const messageId = randomUUID();
  let emittedText = "";
  try {
    for await (const event of options.client.streamMessage(
      session.yourCharSessionId,
      { ...session.message, text },
      { signal: active.controller.signal },
    )) {
      if (event.type === "delta") {
        emittedText += event.delta;
        await notifyText(client, session.acpSessionId, event.delta, messageId);
      } else if (event.type === "tool_start") {
        await client.notify(methods.client.session.update, {
          sessionId: session.acpSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: `YourChar tool: ${boundedLabel(event.toolName)}`,
            name: boundedLabel(event.toolName),
            kind: toolKind(event.toolName),
            status: "in_progress",
          },
        });
      } else if (event.type === "tool_end") {
        await client.notify(methods.client.session.update, {
          sessionId: session.acpSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: event.isError ? "failed" : "completed",
          },
        });
      } else if (event.type === "error") {
        throw new Error(event.error);
      } else if (event.type === "done") {
        const residual = residualReply(emittedText, event.response.reply);
        if (residual) await notifyText(client, session.acpSessionId, residual, messageId);
        return { stopReason: stopReason(event.response.status) };
      }
    }
    if (active.cancelled || active.controller.signal.aborted) return { stopReason: "cancelled" };
    throw new Error("YourChar stream ended before a terminal event");
  } catch (error) {
    if (active.cancelled || active.controller.signal.aborted) return { stopReason: "cancelled" };
    throw error;
  }
}

async function notifyText(
  client: AgentContext,
  sessionId: string,
  text: string,
  messageId: string,
): Promise<void> {
  if (!text) return;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  });
}

function validateNewSession(params: NewSessionRequest, expectedCwd: string): void {
  if (!isAbsolute(params.cwd) || resolve(params.cwd) !== expectedCwd) {
    throw RequestError.invalidParams(undefined, "session cwd is outside the configured ACP admission root");
  }
  if (params.additionalDirectories?.length) {
    throw RequestError.invalidParams(undefined, "additionalDirectories are not mapped by the YourChar ACP bridge");
  }
  if (params.mcpServers.length) {
    throw RequestError.invalidParams(undefined, "ACP-provided MCP servers are not mapped by the YourChar ACP bridge");
  }
}

function activePrompt(): ActivePrompt {
  return {
    controller: new AbortController(),
    cancelled: false,
    cancellationKey: createIdempotencyKey("acp-cancel"),
  };
}

function cancelPrompt(
  options: YourCharAcpBridgeOptions,
  session: BridgeSession,
  active: ActivePrompt,
  reason: unknown,
): Promise<void> {
  if (active.cancellationOperation) return active.cancellationOperation;
  active.cancelled = true;
  active.controller.abort(reason);
  active.cancellationOperation = options.client.cancelMessage(session.yourCharSessionId, {
    idempotencyKey: active.cancellationKey,
  }).then(
    () => undefined,
    (error) => {
      options.diagnostic?.("YourChar cancellation request did not complete", error);
    },
  );
  return active.cancellationOperation;
}

function unknownSession(_sessionId: string): RequestError {
  return new RequestError(-32000, "unknown ACP session");
}

function stopReason(status: TurnStatus): StopReason {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "refusal";
  if (status === "completed") return "end_turn";
  throw new Error("YourChar turn failed");
}

function residualReply(streamed: string, finalReply: string): string {
  if (!streamed) return finalReply;
  return finalReply.startsWith(streamed) ? finalReply.slice(streamed.length) : "";
}

function toolKind(toolName: string): ToolKind {
  const name = toolName.toLowerCase();
  if (/search|reference|definition|implementation/u.test(name)) return "search";
  if (/read|list|preview|status|get_/u.test(name)) return "read";
  if (/delete|remove/u.test(name)) return "delete";
  if (/move|rename/u.test(name)) return "move";
  if (/bash|shell|execute|terminal/u.test(name)) return "execute";
  if (/fetch|web|tavily/u.test(name)) return "fetch";
  if (/write|edit|patch|create|update/u.test(name)) return "edit";
  return "other";
}

function boundedLabel(value: string): string {
  return [...value].slice(0, 120).join("") || "unknown";
}

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function requiredAbsolutePath(value: string, name: string): string {
  const normalized = requiredValue(value, name);
  if (!isAbsolute(normalized)) throw new Error(`${name} must be an absolute path`);
  return resolve(normalized);
}

function unicodeLength(value: string): number {
  return [...value].length;
}
