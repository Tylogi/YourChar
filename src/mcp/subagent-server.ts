import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import {
  maximumSubagentFollowupCharacters,
  type SubagentJobDetail,
  type SubagentJobSummary,
} from "../modules/subagent-jobs.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const subagentMcpToolNames = [
  "delegate_task",
  "list_subagent_jobs",
  "get_subagent_job",
  "start_subagent_job",
  "interrupt_subagent_job",
  "send_subagent_message",
] as const;
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
  jobId: string;
  childSessionId: string;
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
  "interrupted",
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
  readonly jobId?: string;
  readonly childSessionId?: string;

  constructor(
    message: string,
    diagnostic: SubagentFailureDiagnostic,
    cause?: unknown,
    identity?: { jobId: string; childSessionId: string },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SubagentRunError";
    this.diagnostic = diagnostic;
    this.jobId = identity?.jobId;
    this.childSessionId = identity?.childSessionId;
  }
}

export type SubagentMcpContext = {
  store: CompanionStore;
  sessionId: string;
  runtimeTimeoutMs: number;
  actions: () => ActionRecord[];
  run: (request: SubagentRequest, signal?: AbortSignal) => Promise<SubagentResult>;
  startJob: (request: SubagentRequest) => SubagentJobSummary;
  interruptJob: (jobId: string) => Promise<SubagentJobSummary>;
  sendMessage: (jobId: string, prompt: string) => SubagentJobSummary;
  listJobs: (limit: number) => readonly SubagentJobSummary[];
  getJob: (jobId: string) => SubagentJobDetail | undefined;
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
          jobId: result.jobId,
          childSessionId: result.childSessionId,
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
        const identity = subagentFailureIdentity(error);
        context.actions().push(context.store.addAction("delegate_subagent", "failed", {
          ...audit,
          ...identity,
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
            ...identity,
            failure,
          },
        };
      }
    },
  );

  server.registerTool(
    "list_subagent_jobs",
    {
      title: "List durable Subagent jobs",
      description:
        "List recent Subagent jobs owned by this parent session. The list contains durable identity, lifecycle, frozen budgets and grants, and usage metadata, but never delegated task/context text or result bodies.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const jobs = context.listJobs(input.limit);
      return {
        content: [{
          type: "text" as const,
          text: jobs.length
            ? jobs.map((job) => `${job.id} · ${job.role} · ${job.status} · revision ${job.revision}`).join("\n")
            : "No Subagent jobs have been recorded for this session.",
        }],
        structuredContent: { jobs },
      };
    },
  );

  server.registerTool(
    "get_subagent_job",
    {
      title: "Get durable Subagent job",
      description:
        "Read one Subagent job owned by this parent session. Delegated task/context text stays hidden. A completed result can be included explicitly; lifecycle and grant metadata are always returned.",
      inputSchema: z.object({
        jobId: z.string().min(1).max(256),
        includeResult: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const job = context.getJob(input.jobId);
      if (!job) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Subagent job is unavailable in this session." }],
          structuredContent: { ok: false, code: "SUBAGENT_JOB_NOT_FOUND" },
        };
      }
      const { output, ...summary } = job;
      const projected = input.includeResult && output !== undefined
        ? { ...summary, output }
        : summary;
      return {
        content: [{
          type: "text" as const,
          text: output !== undefined && input.includeResult
            ? `Subagent job ${job.id} (${job.role}; ${job.status}):\n\n${output}`
            : `Subagent job ${job.id} is ${job.status} (revision ${job.revision}).`,
        }],
        structuredContent: { job: projected },
      };
    },
  );

  server.registerTool(
    "start_subagent_job",
    {
      title: "Start background Subagent job",
      description:
        "Start one isolated Subagent job without waiting for its model result. The job keeps frozen read-only grants and budgets after this parent turn returns. Use list/get to observe it and interrupt_subagent_job to cancel it.",
      inputSchema: z.object({
        role: z.enum(subagentRoles).default("worker"),
        task: z.string().min(1).max(4_000),
        context: z.string().max(8_000).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
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
        const job = context.startJob(input);
        context.actions().push(context.store.addAction("start_subagent_job", "completed", {
          ...audit,
          jobId: job.id,
          childSessionId: job.childSessionId,
          status: job.status,
          revision: job.revision,
        }));
        return {
          content: [{
            type: "text" as const,
            text: `Subagent job ${job.id} accepted (${job.role}; ${job.status}).`,
          }],
          structuredContent: { job },
        };
      } catch (error) {
        const failure = safeSubagentFailureDiagnostic(error);
        context.actions().push(context.store.addAction("start_subagent_job", "failed", {
          ...audit,
          ...failure,
        }));
        return {
          isError: true,
          content: [{ type: "text" as const, text: publicSubagentFailureMessage(failure) }],
          structuredContent: { ok: false, failure },
        };
      }
    },
  );

  server.registerTool(
    "interrupt_subagent_job",
    {
      title: "Interrupt background Subagent job",
      description:
        "Cancel one queued or running background Subagent job owned by this parent session. The cancellation propagates to its model and provider transport and leaves a durable cancelled terminal record.",
      inputSchema: z.object({
        jobId: z.string().min(1).max(256),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const job = await context.interruptJob(input.jobId);
        context.actions().push(context.store.addAction("interrupt_subagent_job", "completed", {
          sessionId: context.sessionId,
          jobId: job.id,
          childSessionId: job.childSessionId,
          status: job.status,
          revision: job.revision,
        }));
        return {
          content: [{
            type: "text" as const,
            text: `Subagent job ${job.id} is ${job.status}.`,
          }],
          structuredContent: { job },
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Subagent job is unavailable in this session." }],
          structuredContent: { ok: false, code: "SUBAGENT_JOB_NOT_FOUND" },
        };
      }
    },
  );

  server.registerTool(
    "send_subagent_message",
    {
      title: "Continue completed Subagent job",
      description:
        "Queue one bounded follow-up turn on a completed same-session Subagent job whose private transcript was retained. Returns immediately; use get_subagent_job to observe the new result.",
      inputSchema: z.object({
        jobId: z.string().min(1).max(256),
        message: z.string().min(1).max(maximumSubagentFollowupCharacters),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const audit = {
        sessionId: context.sessionId,
        jobIdSha256: createHash("sha256").update(input.jobId).digest("hex"),
        messageCharacters: [...input.message].length,
        messageSha256: createHash("sha256").update(input.message).digest("hex"),
      };
      try {
        const job = context.sendMessage(input.jobId, input.message);
        context.actions().push(context.store.addAction("send_subagent_message", "completed", {
          ...audit,
          jobId: job.id,
          childSessionId: job.childSessionId,
          status: job.status,
          revision: job.revision,
          followupCount: job.continuation.followupCount,
        }));
        return {
          content: [{
            type: "text" as const,
            text: `Subagent job ${job.id} accepted follow-up ${job.continuation.followupCount} (${job.status}).`,
          }],
          structuredContent: { job },
        };
      } catch {
        context.actions().push(context.store.addAction("send_subagent_message", "failed", audit));
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Subagent job is unavailable for continuation in this session.",
          }],
          structuredContent: { ok: false, code: "SUBAGENT_CONTINUATION_UNAVAILABLE" },
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

function subagentFailureIdentity(error: unknown): { jobId?: string; childSessionId?: string } {
  if (!(error instanceof SubagentRunError)) return {};
  return {
    ...(error.jobId ? { jobId: error.jobId } : {}),
    ...(error.childSessionId ? { childSessionId: error.childSessionId } : {}),
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
    interrupted: "The application stopped before the durable job reached a terminal state. Review it before retrying.",
  }[failure.failureKind];
  return `Subagent failed (${failure.failureKind}; ${usage}). ${guidance}`;
}
