import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { MemoryLifecycleService } from "../memory-coordinator/lifecycle.js";
import type { MemoryTargetRealm } from "../memory-coordinator/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const memoryMcpToolNames = ["search_memory", "propose_memory"] as const;

export type MemoryMcpContext = {
  lifecycle: MemoryLifecycleService;
  store: CompanionStore;
  sessionId: string;
  realm: MemoryTargetRealm;
  characterId?: string;
  actions: () => ActionRecord[];
  allowPropose: boolean;
};

const realityType = z.enum(["user_fact", "preference", "goal", "person", "project", "boundary"]);
const roleplayType = z.enum(["relationship_event", "world_fact", "plot_event", "boundary"]);

export function createMemoryMcpServer(context: MemoryMcpContext): McpServer {
  if (context.realm === "roleplay" && !context.characterId) {
    throw new Error("roleplay memory MCP requires a bound character");
  }
  const server = new McpServer(
    { name: "rp-agent-memory", version: "1.0.0" },
    {
      instructions:
        `This server is fixed to realm=${context.realm}. Search returns confirmed active memory only. ` +
        "Proposals are always pending and unconfirmed. There are no confirm, reject, archive, or delete tools.",
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search confirmed memory",
      description: "Search confirmed active memory in the server-bound realm only.",
      inputSchema: z.object({
        query: z.string().min(1).max(2_000),
        limit: z.number().int().min(1).max(20).optional(),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const memories = context.lifecycle.searchConfirmed({
        realm: context.realm,
        ...(context.characterId ? { characterId: context.characterId } : {}),
        query,
        limit: limit ?? 8,
      });
      return {
        content: [{
          type: "text" as const,
          text: memories.length
            ? memories.map((memory) => `[${memory.type}] ${memory.content}`).join("\n")
            : "No confirmed memory matched.",
        }],
        structuredContent: {
          realm: context.realm,
          characterId: context.characterId ?? null,
          memories,
        },
      };
    },
  );

  if (context.allowPropose) {
    server.registerTool(
      "propose_memory",
      {
        title: "Propose pending memory",
        description: "Propose one unconfirmed pending memory in the server-bound realm.",
        inputSchema: z.object({
          type: context.realm === "reality" ? realityType : roleplayType,
          key: z.string().max(240).optional(),
          content: z.string().min(1).max(2_000),
          salience: z.number().min(0).max(1).optional(),
          confidence: z.number().min(0).max(1).optional(),
          tags: z.array(z.string().max(80)).max(20).optional(),
        }).strict(),
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async (input, extra) => {
        const toolCallId = mcpToolCallId(extra);
        const memory = context.lifecycle.propose({
          realm: context.realm,
          type: input.type,
          key: input.key,
          content: input.content,
          ...(context.characterId ? { characterId: context.characterId } : {}),
          sourceSessionId: context.sessionId,
          sourceMessageId: toolCallId,
          salience: input.salience,
          confidence: input.confidence,
          tags: input.tags,
          idempotencyKey: `mcp:${context.sessionId}:${toolCallId}`,
        });
        context.actions().push(context.store.addAction("propose_memory", "completed", {
          transport: "mcp",
          mcpServer: "rp-agent-memory",
          sessionId: context.sessionId,
          realm: context.realm,
          characterId: context.characterId,
          memoryId: memory.id,
          validity: memory.validity,
          confirmed: memory.confirmed,
        }));
        return {
          content: [{ type: "text" as const, text: "Memory proposal saved as pending for user review." }],
          structuredContent: { memory },
        };
      },
    );
  }

  return server;
}

export async function createMemoryMcpBridge(context: MemoryMcpContext): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createMemoryMcpServer(context),
    `rp-agent-memory-pi-${context.sessionId}`,
  );
}

function mcpToolCallId(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): string {
  const value = extra._meta?.["rp-agent/tool-call-id"];
  return typeof value === "string" && value ? value : `mcp-${String(extra.requestId)}`;
}
