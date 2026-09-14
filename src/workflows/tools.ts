import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import {
  maximumWorkflowCommandCharacters,
  maximumWorkflowConcurrency,
  maximumWorkflowContextCharacters,
  maximumWorkflowDependenciesPerNode,
  maximumWorkflowDurationSeconds,
  maximumWorkflowNodeKeyCharacters,
  maximumWorkflowNodes,
  maximumWorkflowNodeTimeoutSeconds,
  maximumWorkflowTaskCharacters,
  maximumWorkflowTerminalNoteCharacters,
  maximumWorkflowTitleCharacters,
  SessionWorkflowValidationError,
  type CreateSessionWorkflowInput,
  type SessionWorkflowDetail,
  type SessionWorkflowSummary,
} from "./session-workflows.js";

const maximumWorkflowToolOutputCharacters = 32_000;
const idSchema = Type.String({ minLength: 1, maxLength: 256 });
const nodeKeySchema = Type.String({ minLength: 1, maxLength: maximumWorkflowNodeKeyCharacters });
const dependenciesSchema = Type.Optional(Type.Array(nodeKeySchema, {
  maxItems: maximumWorkflowDependenciesPerNode,
  uniqueItems: true,
}));
const timeoutSchema = Type.Optional(Type.Integer({
  minimum: 1,
  maximum: maximumWorkflowNodeTimeoutSeconds,
}));
const workspaceSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("read_only"),
  Type.Literal("read_write"),
]);
const subagentNodeSchema = Type.Object({
  key: nodeKeySchema,
  kind: Type.Literal("subagent"),
  dependsOn: dependenciesSchema,
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("researcher"),
    Type.Literal("planner"),
    Type.Literal("reviewer"),
  ]),
  task: Type.String({ minLength: 1, maxLength: maximumWorkflowTaskCharacters }),
  context: Type.Optional(Type.String({ maxLength: maximumWorkflowContextCharacters })),
  timeoutSeconds: timeoutSchema,
  workspaceAccess: Type.Optional(Type.Union([
    Type.Literal("off"),
    Type.Literal("read_only"),
  ])),
  moduleIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: 32,
    uniqueItems: true,
  })),
  skillNames: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 64,
    uniqueItems: true,
  })),
});
const shellNodeSchema = Type.Object({
  key: nodeKeySchema,
  kind: Type.Literal("shell"),
  dependsOn: dependenciesSchema,
  command: Type.String({ minLength: 1, maxLength: maximumWorkflowCommandCharacters }),
  timeoutSeconds: timeoutSchema,
  workspaceAccess: Type.Optional(workspaceSchema),
  networkEnabled: Type.Optional(Type.Boolean()),
});

const manageWorkflowParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("create"),
    Type.Literal("start"),
    Type.Literal("cancel"),
  ]),
  workflowId: Type.Optional(idSchema),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: maximumWorkflowTitleCharacters })),
  nodes: Type.Optional(Type.Array(Type.Union([subagentNodeSchema, shellNodeSchema]), {
    minItems: 1,
    maxItems: maximumWorkflowNodes,
  })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumWorkflowConcurrency })),
  timeoutSeconds: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: maximumWorkflowDurationSeconds,
  })),
  note: Type.Optional(Type.String({
    minLength: 1,
    maxLength: maximumWorkflowTerminalNoteCharacters,
  })),
});

const listWorkflowParameters = Type.Object({
  includeTerminal: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const getWorkflowParameters = Type.Object({
  workflowId: idSchema,
  eventLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
});

export type SessionWorkflowToolContext = Readonly<{
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
  create: (input: CreateSessionWorkflowInput) => SessionWorkflowDetail;
  start: (workflowId: string, expectedRevision: number) => SessionWorkflowDetail;
  cancel: (workflowId: string, expectedRevision: number, note: string) => SessionWorkflowDetail;
  list: (options: { includeTerminal?: boolean; limit?: number }) => readonly SessionWorkflowSummary[];
  get: (workflowId: string, eventLimit?: number) => SessionWorkflowDetail | undefined;
}>;

export const sessionWorkflowToolNames = Object.freeze([
  "manage_workflow",
  "list_workflows",
  "get_workflow",
] as const);

/** Compact model surface; ambiguous replay remains trusted-control-plane only. */
export function createSessionWorkflowTools(
  context: SessionWorkflowToolContext,
): readonly ToolDefinition[] {
  return Object.freeze([
    defineTool<typeof manageWorkflowParameters, unknown>({
      name: "manage_workflow",
      label: "Manage durable workflow",
      description:
        "Create, start, or cancel a bounded durable DAG for this conversation. " +
        "Create accepts 1-16 shell/Subagent nodes with acyclic dependsOn keys, an optional 1-4 concurrency budget, and a deadline. " +
        "Shell nodes default to no Workspace/network access; Subagent modules and skills must be explicitly listed. " +
        "Creation only plans work: call start with the returned revision. Results are references; inspect child jobs explicitly. " +
        "A node interrupted after an ambiguous external effect blocks until the trusted local control plane chooses retry, skip, or cancel.",
      parameters: manageWorkflowParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        try {
          assertManageFields(input as Record<string, unknown>);
          const workflow = input.operation === "create"
            ? context.create({
                title: requiredText(input.title, "title"),
                nodes: input.nodes ?? [],
                ...(input.maxConcurrency === undefined
                  ? {}
                  : { maxConcurrency: input.maxConcurrency }),
                ...(input.timeoutSeconds === undefined
                  ? {}
                  : { timeoutSeconds: input.timeoutSeconds }),
              } as CreateSessionWorkflowInput)
            : input.operation === "start"
              ? context.start(
                  requiredText(input.workflowId, "workflowId"),
                  requiredRevision(input.expectedRevision),
                )
              : context.cancel(
                  requiredText(input.workflowId, "workflowId"),
                  requiredRevision(input.expectedRevision),
                  requiredText(input.note, "note"),
                );
          context.actions().push(context.store.addAction(
            `${input.operation}_workflow`,
            "completed",
            workflowAudit(context.sessionId, workflow),
          ));
          return {
            content: [{ type: "text" as const, text: renderWorkflow(workflow) }],
            details: { workflow },
          };
        } catch (error) {
          context.actions().push(context.store.addAction(`${input.operation}_workflow`, "failed", {
            transport: "pi-tool",
            sessionId: context.sessionId,
            ...(input.workflowId ? { workflowId: input.workflowId } : {}),
            code: errorCode(error),
          }));
          return workflowError(error, "The workflow change was rejected.");
        }
      },
    }),
    defineTool<typeof listWorkflowParameters, unknown>({
      name: "list_workflows",
      label: "List durable workflows",
      description:
        "List this conversation's workflow states and node counts. Private tasks, commands, and outputs are omitted.",
      parameters: listWorkflowParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        try {
          const workflows = context.list({
            ...(input.includeTerminal === undefined
              ? {}
              : { includeTerminal: input.includeTerminal }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          });
          return {
            content: [{
              type: "text" as const,
              text: workflows.length
                ? truncate(workflows.map(renderWorkflowSummary).join("\n"), maximumWorkflowToolOutputCharacters)
                : "No durable workflows are recorded for this conversation.",
            }],
            details: { workflows },
          };
        } catch (error) {
          return workflowError(error, "Workflows could not be listed.");
        }
      },
    }),
    defineTool<typeof getWorkflowParameters, unknown>({
      name: "get_workflow",
      label: "Get durable workflow",
      description:
        "Inspect one same-conversation DAG, grants, dependencies, safe child references, and recent typed events. Private inputs and output bodies are omitted.",
      parameters: getWorkflowParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        try {
          const workflow = context.get(input.workflowId, input.eventLimit ?? 20);
          if (!workflow) return workflowError(undefined, "Workflow is unavailable in this conversation.");
          return {
            content: [{ type: "text" as const, text: renderWorkflow(workflow) }],
            details: { workflow },
          };
        } catch (error) {
          return workflowError(error, "Workflow is unavailable in this conversation.");
        }
      },
    }),
  ]);
}

function assertManageFields(input: Record<string, unknown>): void {
  const allowed: Record<string, readonly string[]> = {
    create: ["operation", "title", "nodes", "maxConcurrency", "timeoutSeconds"],
    start: ["operation", "workflowId", "expectedRevision"],
    cancel: ["operation", "workflowId", "expectedRevision", "note"],
  };
  const operation = String(input.operation);
  const permitted = new Set(allowed[operation] ?? ["operation"]);
  const unexpected = Object.keys(input)
    .find((key) => input[key] !== undefined && !permitted.has(key));
  if (unexpected) {
    throw new SessionWorkflowValidationError(
      `${unexpected} is not valid for workflow operation ${operation}`,
    );
  }
}

function requiredText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionWorkflowValidationError(`${label} is required`);
  }
  return value;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new SessionWorkflowValidationError("expectedRevision is required");
  }
  return value!;
}

function renderWorkflowSummary(workflow: SessionWorkflowSummary): string {
  return `${workflow.id} · r${workflow.revision} · ${workflow.status} · ` +
    `${workflow.counts.completed}/${workflow.counts.total} complete · ` +
    `${workflow.counts.active} active · ${workflow.counts.decisionRequired} decision(s) · ` +
    truncate(workflow.title, 160);
}

function renderWorkflow(workflow: SessionWorkflowDetail): string {
  const lines = [renderWorkflowSummary(workflow)];
  if (workflow.deadlineAt) lines.push(`Deadline: ${workflow.deadlineAt}`);
  if (workflow.terminalNote) lines.push(`Terminal note: ${truncate(workflow.terminalNote, 500)}`);
  lines.push("Nodes:");
  for (const node of workflow.nodes) {
    const dependency = node.dependsOn.length ? ` depends=${node.dependsOn.join(",")}` : "";
    const child = node.childJobId ? ` child=${node.childJobId}` : "";
    const reference = node.resultReference
      ? ` ref=${node.resultReference.kind}:${node.resultReference.jobId ?? node.resultReference.status}`
      : "";
    const decision = node.decisionReason ? ` decision=${node.decisionReason}` : "";
    lines.push(
      `- ${node.key} · ${node.kind}/${node.status} · r${node.revision}${dependency}${child}${reference}${decision}`,
    );
  }
  return truncate(lines.join("\n"), maximumWorkflowToolOutputCharacters);
}

function workflowAudit(sessionId: string, workflow: SessionWorkflowSummary) {
  return {
    transport: "pi-tool",
    sessionId,
    workflowId: workflow.id,
    status: workflow.status,
    revision: workflow.revision,
    nodeCount: workflow.counts.total,
    activeNodes: workflow.counts.active,
    decisionRequired: workflow.counts.decisionRequired,
  };
}

function workflowError(error: unknown, fallback: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: fallback }],
    details: { ok: false, code: errorCode(error) },
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "SESSION_WORKFLOW_UNAVAILABLE";
}

function truncate(value: string, maximum: number): string {
  return [...value].length <= maximum
    ? value
    : `${[...value].slice(0, Math.max(0, maximum - 1)).join("")}…`;
}
