import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { RelationshipService } from "../relationship/service.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const relationshipMcpToolNames = ["get_relationship_state"] as const;

export type RelationshipMcpContext = {
  relationshipService: RelationshipService;
  sessionId: string;
  characterId: string;
};

export function createRelationshipMcpServer(context: RelationshipMcpContext): McpServer {
  const server = new McpServer(
    { name: "rp-agent-relationship", version: "1.0.0" },
    {
      instructions:
        "This server exposes a read-only qualitative relationship, explicit bond, romantic status, and affect snapshot for the bound character. " +
        "There are no score, delta, event, or mutation tools. Never reveal internal state mechanics to the user.",
    },
  );
  server.registerTool(
    "get_relationship_state",
    {
      title: "Read relationship state",
      description: "Read the trusted qualitative relationship, established bonds, romantic status, and current affect for this character.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snapshot = context.relationshipService.snapshot(context.characterId, 3);
      return {
        content: [{ type: "text" as const, text: snapshot.qualitative }],
        structuredContent: {
          characterId: context.characterId,
          qualitative: snapshot.qualitative,
          bondFacets: snapshot.state.bondFacets,
          romanceStatus: snapshot.state.romanceStatus,
          recentCauses: snapshot.recentEvents.map((event) => ({
            type: event.type,
            summary: event.summary,
            semanticChange: event.semanticChange,
            createdAt: event.createdAt,
          })),
        },
      };
    },
  );
  return server;
}

export async function createRelationshipMcpBridge(context: RelationshipMcpContext): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createRelationshipMcpServer(context),
    `rp-agent-relationship-pi-${context.sessionId}`,
  );
}
