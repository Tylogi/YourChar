import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { TavilyService } from "../tavily/service.js";
import type { TavilySearchResponse } from "../tavily/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const tavilyMcpToolNames = ["tavily_search"] as const;

export type TavilyMcpContext = {
  tavilyService: TavilyService;
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
};

export function createTavilyMcpServer(context: TavilyMcpContext): McpServer {
  const server = new McpServer(
    { name: "rp-agent-tavily-search", version: "1.0.0" },
    {
      instructions:
        "Use Tavily Search for current or externally verifiable web information. Search before making time-sensitive claims, preserve source URLs, distinguish retrieved evidence from inference, and do not send secrets or unnecessary private information in queries.",
    },
  );

  server.registerTool(
    "tavily_search",
    {
      title: "Tavily web search",
      description:
        "Search the live web with Tavily and return ranked source titles, URLs, and snippets. Use basic depth unless the request needs higher precision; advanced depth uses more Tavily credits.",
      inputSchema: z.object({
        query: z.string().min(1).max(1_000).describe("A focused web search query without secrets or unnecessary personal data."),
        searchDepth: z.enum(["basic", "advanced", "fast", "ultra-fast"]).optional().describe("Latency and relevance tradeoff. Defaults to basic."),
        topic: z.enum(["general", "news", "finance"]).optional().describe("Search category. Defaults to general."),
        timeRange: z.enum(["day", "week", "month", "year"]).optional().describe("Optional recency filter."),
        maxResults: z.number().int().min(1).max(10).optional().describe("Maximum result count. Defaults to 5."),
        includeDomains: z.array(z.string().min(1)).max(20).optional().describe("Only return results from these domains."),
        excludeDomains: z.array(z.string().min(1)).max(20).optional().describe("Exclude results from these domains."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      const audit = {
        transport: "mcp",
        mcpServer: "rp-agent-tavily-search",
        sessionId: context.sessionId,
        queryLength: [...input.query].length,
        querySha256: createHash("sha256").update(input.query).digest("hex"),
        searchDepth: input.searchDepth ?? "basic",
        topic: input.topic ?? "general",
      };
      try {
        const result = await context.tavilyService.search(input, extra.signal);
        context.actions().push(context.store.addAction("tavily_search", "completed", {
          ...audit,
          resultCount: result.results.length,
          requestId: result.requestId,
          credits: result.credits,
        }));
        return tavilyToolResult(result);
      } catch (error) {
        context.actions().push(context.store.addAction("tavily_search", "failed", audit));
        throw error;
      }
    },
  );

  return server;
}

export async function createTavilyMcpBridge(context: TavilyMcpContext): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createTavilyMcpServer(context),
    `rp-agent-tavily-pi-${context.sessionId}`,
  );
}

function tavilyToolResult(result: TavilySearchResponse) {
  const text = result.results.length
    ? [
        `Tavily results for: ${result.query}`,
        ...result.results.flatMap((item, index) => [
          `\n${index + 1}. ${item.title}`,
          `URL: ${item.url}`,
          item.content,
        ]),
      ].join("\n")
    : `Tavily found no results for: ${result.query}`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ...result },
  };
}
