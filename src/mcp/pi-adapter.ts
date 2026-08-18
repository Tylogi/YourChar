import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

export type McpPiBridge = {
  readonly client: Client;
  readonly tools: ToolDefinition[];
  readonly serverName: string;
  close(): Promise<void>;
};

export async function connectMcpServerToPi(
  server: McpServer,
  clientName: string,
  options: {
    executionMode?: "sequential" | "parallel";
    requestTimeoutMs?: number;
  } = {},
): Promise<McpPiBridge> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "0.1.0" });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const listing = await client.listTools();
    const tools = listing.tools.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.annotations?.title ?? tool.name,
        description: tool.description ?? `MCP tool ${tool.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as TSchema),
        executionMode: options.executionMode ?? "sequential",
        async execute(toolCallId, input, signal) {
          const result = await client.callTool(
            {
              name: tool.name,
              arguments: input,
              _meta: { "rp-agent/tool-call-id": toolCallId },
            },
            undefined,
            {
              signal,
              ...(options.requestTimeoutMs === undefined
                ? {}
                : {
                    timeout: options.requestTimeoutMs,
                    maxTotalTimeout: options.requestTimeoutMs,
                  }),
            },
          );
          const text = (Array.isArray(result.content) ? result.content : [])
            .map(mcpTextContent)
            .filter(Boolean)
            .join("\n")
            .trim();
          if (result.isError === true) {
            throw new Error(text || `MCP tool ${tool.name} failed`);
          }
          return {
            content: [{ type: "text", text: text || "MCP tool completed." }],
            details: result.structuredContent ?? result,
          };
        },
      }),
    );
    return {
      client,
      tools,
      serverName: client.getServerVersion()?.name ?? clientName,
      async close() {
        await Promise.allSettled([client.close(), server.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()]);
    throw error;
  }
}

function mcpTextContent(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "";
  const record = content as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : "";
}
