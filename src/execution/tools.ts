import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import {
  defaultExecutionOutputPageBytes,
  maximumExecutionCommandCharacters,
  maximumExecutionOutputPageBytes,
  maximumExecutionTimeoutSeconds,
  type ExecutionJobDetail,
  type ExecutionJobSummary,
  type ExecutionOutputPage,
} from "./shell-jobs.js";

const startParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: maximumExecutionCommandCharacters }),
  timeoutSeconds: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: maximumExecutionTimeoutSeconds,
  })),
});

const listParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const getParameters = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 256 }),
  includeOutput: Type.Optional(Type.Boolean()),
  attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limitBytes: Type.Optional(Type.Integer({
    minimum: 4 * 1_024,
    maximum: maximumExecutionOutputPageBytes,
  })),
});

const interruptParameters = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 256 }),
});

export type BackgroundExecutionToolContext = Readonly<{
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
  start: (input: { command: string; timeoutSeconds?: number }) => ExecutionJobSummary;
  list: (limit: number) => readonly ExecutionJobSummary[];
  get: (jobId: string) => ExecutionJobDetail | undefined;
  output: (
    jobId: string,
    options: { attempt?: number; cursor?: number; limitBytes?: number },
  ) => ExecutionOutputPage;
  interrupt: (jobId: string) => Promise<ExecutionJobSummary>;
}>;

export const executionJobToolNames = Object.freeze([
  "start_shell_job",
  "list_execution_jobs",
  "get_execution_job",
  "interrupt_execution_job",
] as const);

/** Native tools contributed through the handle-scoped capability registry. */
export function createExecutionJobTools(
  context: BackgroundExecutionToolContext,
): readonly ToolDefinition[] {
  return Object.freeze([
    defineTool<typeof startParameters, unknown>({
      name: "start_shell_job",
      label: "Start background shell job",
      description:
        "Start a durable sandboxed Bash job without waiting for it to finish. " +
        "The job retains the current Workspace/network grant, survives conversation-handle eviction, " +
        "and stores up to 8 MiB of output outside active model context. Use get_execution_job to page output.",
      parameters: startParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        const audit = {
          transport: "pi-tool",
          sessionId: context.sessionId,
          commandCharacters: [...input.command].length,
          commandSha256: createHash("sha256").update(input.command).digest("hex"),
          timeoutSeconds: input.timeoutSeconds ?? 300,
        };
        try {
          const job = context.start({
            command: input.command,
            ...(input.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: input.timeoutSeconds }),
          });
          context.actions().push(context.store.addAction("start_shell_job", "completed", {
            ...audit,
            jobId: job.id,
            status: job.status,
            revision: job.revision,
            workspaceAccess: job.grants.workspaceAccess,
            networkEnabled: job.grants.networkEnabled,
          }));
          return {
            content: [{
              type: "text" as const,
              text: `Execution job ${job.id} accepted (${job.status}; attempt ${job.currentAttempt}).`,
            }],
            details: { job },
          };
        } catch (error) {
          context.actions().push(context.store.addAction("start_shell_job", "failed", audit));
          return executionToolError(error, "The background shell job could not be started.");
        }
      },
    }),
    defineTool<typeof listParameters, unknown>({
      name: "list_execution_jobs",
      label: "List background execution jobs",
      description:
        "List recent durable shell jobs owned by this conversation. Commands and output bodies are omitted.",
      parameters: listParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        const jobs = context.list(input.limit ?? 20);
        return {
          content: [{
            type: "text" as const,
            text: jobs.length
              ? jobs.map((job) =>
                  `${job.id} · ${job.status} · attempt ${job.currentAttempt}/${job.maxAttempts} · ` +
                  `${job.run?.outputBytes ?? 0} byte(s) · command ${job.commandSha256.slice(0, 12)}`
                ).join("\n")
              : "No background execution jobs have been recorded for this conversation.",
          }],
          details: { jobs },
        };
      },
    }),
    defineTool<typeof getParameters, unknown>({
      name: "get_execution_job",
      label: "Get background execution job",
      description:
        "Inspect one same-conversation shell job and optionally read one bounded output page. " +
        "Continue from nextCursor to avoid loading large output into active context.",
      parameters: getParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        const job = context.get(input.jobId);
        if (!job) {
          return executionToolError(undefined, "Execution job is unavailable in this conversation.");
        }
        const includeOutput = input.includeOutput ?? true;
        const page = includeOutput
          ? context.output(input.jobId, {
              ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              limitBytes: input.limitBytes ?? defaultExecutionOutputPageBytes,
            })
          : undefined;
        const output = page ? renderOutputPage(page) : "";
        return {
          content: [{
            type: "text" as const,
            text: [
              `Execution job ${job.id} is ${job.status} (attempt ${job.currentAttempt}/${job.maxAttempts}).`,
              page
                ? `Output page ${page.cursor}→${page.nextCursor}; ${page.returnedBytes}/${page.totalBytes} byte(s); eof=${page.eof}.`
                : "Output was not requested.",
              output,
            ].filter(Boolean).join("\n"),
          }],
          details: { job, ...(page ? { output: page } : {}) },
        };
      },
    }),
    defineTool<typeof interruptParameters, unknown>({
      name: "interrupt_execution_job",
      label: "Interrupt background execution job",
      description:
        "Cancel one queued, idle, or running same-conversation shell job and keep its captured output.",
      parameters: interruptParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        try {
          const job = await context.interrupt(input.jobId);
          context.actions().push(context.store.addAction("interrupt_shell_job", "completed", {
            sessionId: context.sessionId,
            jobId: job.id,
            status: job.status,
            revision: job.revision,
          }));
          return {
            content: [{
              type: "text" as const,
              text: `Execution job ${job.id} is ${job.status}.`,
            }],
            details: { job },
          };
        } catch (error) {
          return executionToolError(error, "Execution job is unavailable in this conversation.");
        }
      },
    }),
  ]);
}

function renderOutputPage(page: ExecutionOutputPage): string {
  if (!page.chunks.length) return "(No output in this page.)";
  const sections: string[] = [];
  let previousStream: "stdout" | "stderr" | undefined;
  for (const chunk of page.chunks) {
    if (chunk.stream !== previousStream) {
      sections.push(`[${chunk.stream}]\n`);
      previousStream = chunk.stream;
    }
    sections.push(chunk.text);
  }
  return sections.join("");
}

function executionToolError(error: unknown, fallback: string) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "EXECUTION_JOB_UNAVAILABLE";
  return {
    isError: true,
    content: [{ type: "text" as const, text: fallback }],
    details: { ok: false, code },
  };
}
