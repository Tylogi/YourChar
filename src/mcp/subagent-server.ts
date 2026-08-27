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
  forcedFinalization: boolean;
  /** Frozen per-task result limit, used to budget the parent model's active tool context. */
  maxResultCharacters: number;
};

export const subagentFailureKinds = [
  "capacity",
  "cancelled",
  "timeout",
  "model_budget",
  "finalization_failed",
  "model_unavailable",
  "empty_result",
  "output_guard",
  "runtime_error",
] as const;
export type SubagentFailureKind = typeof subagentFailureKinds[number];

export type SubagentFailureDiagnostic = {
  failureKind: SubagentFailureKind;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  forcedFinalization: boolean;
  retryable: boolean;
};

export class SubagentRunError extends Error {
  readonly diagnostic: SubagentFailureDiagnostic;

  constructor(message: string, diagnostic: SubagentFailureDiagnostic, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SubagentRunError";
    this.diagnostic = diagnostic;
  }
}

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
        "Run one bounded task in an isolated subagent context. Use this for independent research, planning, or review that materially benefits from a separate context. Do not delegate ordinary conversation. Calls in one response may run in parallel up to the configured per-session limit (default four, absolute maximum eight); if more tasks are needed, wait for that batch to finish before starting the next batch. Never include secrets or unnecessary private data.",
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
          forcedFinalization: result.forcedFinalization,
          maxResultCharacters: result.maxResultCharacters,
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
        const failure = safeSubagentFailureDiagnostic(error);
        context.actions().push(context.store.addAction("delegate_subagent", "failed", {
          ...audit,
          ...failure,
        }));
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: publicSubagentFailureMessage(failure),
          }],
          structuredContent: {
            ok: false,
            role: input.role,
            failure,
          },
        };
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

export function safeSubagentFailureDiagnostic(error: unknown): SubagentFailureDiagnostic {
  if (error instanceof SubagentRunError) return { ...error.diagnostic };
  return {
    failureKind: "runtime_error",
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    forcedFinalization: false,
    retryable: true,
  };
}

function publicSubagentFailureMessage(failure: SubagentFailureDiagnostic): string {
  const usage = `${failure.modelCalls} model call(s), ${failure.toolCalls} tool call(s), ` +
    `${failure.inputTokens + failure.outputTokens} tokens, ${failure.durationMs} ms`;
  const guidance = {
    capacity: "The configured per-session Subagent concurrency limit is full. Retry after the current batch finishes.",
    cancelled: "The delegated task was cancelled.",
    timeout: "The delegated task reached its hard wall-clock deadline. Retry with a smaller task.",
    model_budget: "The delegated task exhausted its configured work-call budget and reserved finalization call. Split the task before retrying.",
    finalization_failed: "The reserved no-tool finalization call did not produce a usable final result. Split the task before retrying.",
    model_unavailable: "The delegated model is unavailable. Check the current character model binding.",
    empty_result: "The delegated model returned no usable final text.",
    output_guard: "The delegated result was blocked by the output safety guard.",
    runtime_error: "The delegated task failed inside its isolated runtime. A bounded retry may succeed.",
  }[failure.failureKind];
  return `Subagent failed (${failure.failureKind}; ${usage}). ${guidance}`;
}
