import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { InteractionService } from "../interaction/service.js";
import type { InteractionScope } from "../interaction/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const interactionMcpToolNames = [
  "propose_meeting",
  "begin_meeting",
  "end_meeting",
] as const;

export type InteractionMcpContext = {
  interactionService: InteractionService;
  store: CompanionStore;
  sessionId: string;
  characterId: string;
  scope: InteractionScope;
  currentUserText: () => string;
  actions: () => ActionRecord[];
};

export function createInteractionMcpServer(context: InteractionMcpContext): McpServer {
  assertBoundScope(context.scope, context.characterId);
  const secret = context.scope.conversationSpace === "secret";
  const server = new McpServer(
    { name: "rp-agent-interaction", version: "1.0.0" },
    {
      instructions:
        "This server controls canonical private-conversation meeting state. Confirm in-world facts, never technical modes. " +
        "Use propose_meeting only for a future plan. If the current turn already establishes immediate co-presence, call begin_meeting directly with a concrete location, even from remote state. " +
        "Opening a door to the arriving character, seeing each other at the meeting place, and returning to the shared scene can be valid semantic evidence. " +
        "Never call propose_meeting and begin_meeting together or probe transition state through expected tool errors. " +
        "Never decide the user's location, movement, speech, choice, sensation, or inner state. " +
        (secret
          ? "This is an isolated private interaction: use a human-readable location, never a normal-space World place ID. "
          : "") +
        "Use semantic context when deciding whether co-presence really ends; end_meeting takes effect only after the farewell reply.",
    },
  );

  server.registerTool(
    "propose_meeting",
    {
      title: "Propose an in-world meeting",
      description:
        "Record a future meeting plan while keeping the conversation remote. Do not call this as a prerequisite in the same turn as begin_meeting; immediate established co-presence uses begin_meeting directly.",
      inputSchema: z.object({
        placeId: z.string().max(160).optional().describe("A place ID returned by World State MCP."),
        location: z.string().max(120).optional().describe("A short human-readable location when no place ID is available."),
        note: z.string().max(240).optional().describe("Optional compact meeting detail, not a prompt or transcript."),
      }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const result = context.interactionService.proposeMeeting({
        sessionId: context.sessionId,
        characterId: context.characterId,
        mode: "sms",
        scope: context.scope,
        ...(input.placeId ? { placeId: input.placeId } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.note ? { note: input.note } : {}),
        source: "agent_tool",
        idempotencyKey: `interaction-tool:${context.sessionId}:${toolCallId(extra)}`,
      });
      context.actions().push(context.store.addAction("propose_meeting", "completed", actionPayload(result)));
      return transitionResult(
        "MEETING_PLANNED: Continue as first-person direct messages. Physical co-presence is not confirmed.",
        result,
      );
    },
  );

  server.registerTool(
    "begin_meeting",
    {
      title: "Begin confirmed co-presence",
      description:
        "Begin an observable in-person scene when the current user message and conversation semantically establish immediate co-presence. This works directly from remote state when a concrete location is supplied. Valid evidence can include the user arriving/returning, both seeing each other, or the user opening the door to the arriving character. Do not call for future, hypothetical, negated, or ambiguous arrival, and never pair it with propose_meeting in one assistant tool batch.",
      inputSchema: z.object({
        placeId: z.string().max(160).optional().describe("Use the already agreed World State place ID when available."),
        location: z.string().max(120).optional().describe("Use the already agreed or explicitly named location."),
      }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const result = context.interactionService.beginMeeting({
        sessionId: context.sessionId,
        characterId: context.characterId,
        mode: "sms",
        scope: context.scope,
        ...(input.placeId ? { placeId: input.placeId } : {}),
        ...(input.location ? { location: input.location } : {}),
        source: "agent_tool",
        evidenceText: context.currentUserText(),
        idempotencyKey: `interaction-tool:${context.sessionId}:${toolCallId(extra)}`,
      });
      context.actions().push(context.store.addAction("begin_meeting", "completed", actionPayload(result)));
      const worldId = context.interactionService.meetingSceneWorldId(result.state);
      return transitionResult(
        worldId
          ? `WORLD_SCENE_OPENED: The in-person scene has moved to World ${worldId}. Send only a brief first-person SMS handoff telling the user that the scene is open; do not continue or narrate the physical encounter in this private thread.`
          : "MEETING_BEGUN: For the remainder of this turn, use observable-scene narration. Describe only environment and the character's visible behavior/dialogue; never invent user actions or inner state.",
        result,
      );
    },
  );

  server.registerTool(
    "end_meeting",
    {
      title: "End co-presence after farewell",
      description:
        "Schedule the active meeting to end after this turn's farewell reply. Decide semantically, not by keywords. " +
        "For user or mutual departure, call only when the current real user message clearly commits to or reports ending physical co-presence now. " +
        "Do not call for questions, negation, hypothetical or future possibilities, temporary movement that preserves the meeting, or a generic farewell that does not end the scene. " +
        "Use character only when the character genuinely chooses to leave; never use it to imply that the user moved.",
      inputSchema: z.object({
        initiator: z.enum(["user", "character", "mutual"]),
        summary: z.string().max(500).optional().describe("A compact factual meeting-end summary without hidden reasoning."),
      }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const result = context.interactionService.scheduleEndMeeting({
        sessionId: context.sessionId,
        characterId: context.characterId,
        mode: "sms",
        scope: context.scope,
        source: "agent_tool",
        initiator: input.initiator,
        ...(input.summary ? { summary: input.summary } : {}),
        idempotencyKey: `interaction-tool:${context.sessionId}:${toolCallId(extra)}`,
      });
      return transitionResult(
        "MEETING_END_PENDING: Keep observable-scene style for this final farewell reply. The runtime will switch back to direct messages only after the reply completes.",
        result,
      );
    },
  );

  return server;
}

export async function createInteractionMcpBridge(context: InteractionMcpContext): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createInteractionMcpServer(context),
    `rp-agent-interaction-pi-${context.sessionId}`,
  );
}

function toolCallId(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): string {
  const value = extra._meta?.["rp-agent/tool-call-id"];
  return typeof value === "string" && value ? value : `mcp-${String(extra.requestId)}`;
}

function actionPayload(result: ReturnType<InteractionService["proposeMeeting"]>) {
  return {
    transport: "mcp",
    mcpServer: "rp-agent-interaction",
    sessionId: result.state.sessionId,
    characterId: result.state.characterId,
    conversationSpace: result.state.conversationSpace,
    ...(result.state.secretOwnerCharacterId
      ? { secretOwnerCharacterId: result.state.secretOwnerCharacterId }
      : {}),
    interactionEventId: result.event.id,
    presence: result.state.presence,
    location: result.state.location,
  };
}

function transitionResult(
  text: string,
  result: ReturnType<InteractionService["proposeMeeting"]>,
) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(JSON.stringify({ state: result.state, event: result.event })) as Record<string, unknown>,
  };
}

function assertBoundScope(scope: InteractionScope, characterId: string): void {
  if (
    scope.conversationSpace === "secret" &&
    scope.secretOwnerCharacterId !== characterId
  ) {
    throw new Error("private interaction MCP scope does not match its bound character");
  }
}
