import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const subagentMcpToolNames = ["delegate_task"] as const;
const subagentBridgeTimeoutGraceMs = 30_000;
const maximumNodeTimerMs = 2_147_483_647;
export const maximumSubagentRuntimeTimeoutMs = maximumNodeTimerMs - subagentBridgeTimeoutGraceMs;

export const subagentRoles = ["worker", "researcher", "planner", "reviewer"] as const;
export type SubagentRole = typeof subagentRoles[number];

export type SubagentRequest = {
  role: SubagentRole;
  task: string;
  context?: string;
};

export type SubagentResult = {
  role: SubagentRole;
  output: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  truncated: boolean;
};

export type SubagentMcpContext = {
  store: CompanionStore;
  sessionId: string;
  runtimeTimeoutMs: number;
  actions: () => ActionRecord[];
  run: (request: SubagentRequest, signal?: AbortSignal) => Promise<SubagentResult>;
};

export function createSubagentMcpServer(context: SubagentMcpContext): McpServer {
  const server = new McpServer(
    { name: "rp-agent-subagent", version: "1.0.0" },
    {
      instructions:
        "Delegate bounded research, planning, review, or independent work to an isolated subagent. The child has no private transcript, mutation tools, or delegation capability, so provide a complete task and only the context it needs.",
    },
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate isolated task",
      description:
        "Run one bounded task in an isolated subagent context. Use this for independent research, planning, or review that materially benefits from a separate context. Do not delegate ordinary conversation. Multiple calls in one response may run in parallel. Never include secrets or unnecessary private data.",
      inputSchema: z.object({
        role: z.enum(subagentRoles).default("worker").describe(
          "worker for general execution, researcher for evidence gathering, planner for decomposition, or reviewer for independent critique.",
        ),
        task: z.string().min(1).max(4_000).describe("A self-contained task with a concrete expected result."),
        context: z.string().max(8_000).optional().describe(
          "Only the supporting context required for the task. The subagent cannot see the private conversation.",
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      const audit = {
        transport: "mcp",
        mcpServer: "rp-agent-subagent",
        sessionId: context.sessionId,
        role: input.role,
        taskCharacters: [...input.task].length,
        contextCharacters: [...(input.context ?? "")].length,
        taskSha256: createHash("sha256").update(input.task).digest("hex"),
      };
      try {
        const result = await context.run(input, extra.signal);
        context.actions().push(context.store.addAction("delegate_subagent", "completed", {
          ...audit,
          modelCalls: result.modelCalls,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
          truncated: result.truncated,
        }));
        const usage = `${result.modelCalls} model call(s), ${result.toolCalls} tool call(s), ` +
          `${result.inputTokens + result.outputTokens} tokens, ${result.durationMs} ms`;
        return {
          content: [{
            type: "text" as const,
            text: `Subagent result (${result.role}; ${usage}):\n\n${result.output}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        context.actions().push(context.store.addAction("delegate_subagent", "failed", audit));
        throw error;
      }
    },
  );

  return server;
}

export async function createSubagentMcpBridge(context: SubagentMcpContext): Promise<McpPiBridge> {
  subagentMcpRequestTimeoutMs(context.runtimeTimeoutMs);
  return connectMcpServerToPi(
    createSubagentMcpServer(context),
    `rp-agent-subagent-pi-${context.sessionId}`,
    {
      executionMode: "parallel",
      // The child runtime owns the hard deadline. Keep MCP's transport envelope
      // wider so it never replaces the authoritative timeout/cancellation result.
      requestTimeoutMs: () => subagentMcpRequestTimeoutMs(context.runtimeTimeoutMs),
    },
  );
}

export function subagentMcpRequestTimeoutMs(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("subagent runtimeTimeoutMs must be a positive finite number");
  }
  if (value > maximumSubagentRuntimeTimeoutMs) {
    throw new TypeError(
      `subagent runtimeTimeoutMs must not exceed ${maximumSubagentRuntimeTimeoutMs}`,
    );
  }
  return value + subagentBridgeTimeoutGraceMs;
}
