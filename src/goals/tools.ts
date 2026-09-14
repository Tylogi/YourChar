import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import {
  maximumSessionGoalDependencies,
  maximumSessionGoalNotesCharacters,
  maximumSessionGoalPlanCharacters,
  maximumSessionGoalSuccessCriteriaCharacters,
  maximumSessionGoalTitleCharacters,
  maximumSessionGoalTransitionNoteCharacters,
  SessionGoalValidationError,
  type CreateSessionGoalInput,
  type SessionGoalDetail,
  type SessionGoalPriority,
  type SessionGoalStatus,
  type SessionGoalSummary,
  type SessionGoalTodoStatus,
  type TransitionSessionGoalInput,
  type TransitionSessionGoalTodoInput,
  type UpdateSessionGoalInput,
  type UpdateSessionGoalTodoInput,
} from "./session-goals.js";

const maximumGoalToolOutputCharacters = 32_000;

const goalIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const revisionSchema = Type.Integer({ minimum: 1 });
const prioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("urgent"),
]);
const statusSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("active"),
  Type.Literal("blocked"),
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const manageGoalParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("transition"),
    Type.Literal("set_dependencies"),
    Type.Literal("create_todo"),
    Type.Literal("update_todo"),
    Type.Literal("transition_todo"),
  ]),
  goalId: Type.Optional(goalIdSchema),
  todoId: Type.Optional(goalIdSchema),
  expectedRevision: Type.Optional(revisionSchema),
  expectedTodoRevision: Type.Optional(revisionSchema),
  title: Type.Optional(Type.String({
    minLength: 1,
    maxLength: maximumSessionGoalTitleCharacters,
  })),
  successCriteria: Type.Optional(Type.String({
    minLength: 1,
    maxLength: maximumSessionGoalSuccessCriteriaCharacters,
  })),
  plan: Type.Optional(Type.String({ maxLength: maximumSessionGoalPlanCharacters })),
  notes: Type.Optional(Type.String({ maxLength: maximumSessionGoalNotesCharacters })),
  priority: Type.Optional(prioritySchema),
  status: Type.Optional(statusSchema),
  dependencyGoalIds: Type.Optional(Type.Array(goalIdSchema, {
    maxItems: maximumSessionGoalDependencies,
    uniqueItems: true,
  })),
  note: Type.Optional(Type.String({
    minLength: 1,
    maxLength: maximumSessionGoalTransitionNoteCharacters,
  })),
});

const listGoalsParameters = Type.Object({
  includeTerminal: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const getGoalParameters = Type.Object({
  goalId: goalIdSchema,
  transitionLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
});

export type SessionGoalToolContext = Readonly<{
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
  create: (input: CreateSessionGoalInput) => SessionGoalDetail;
  list: (options: { includeTerminal?: boolean; limit?: number }) => readonly SessionGoalSummary[];
  get: (goalId: string, transitionLimit?: number) => SessionGoalDetail | undefined;
  update: (goalId: string, input: UpdateSessionGoalInput) => SessionGoalDetail;
  transition: (goalId: string, input: TransitionSessionGoalInput) => SessionGoalDetail;
  setDependencies: (
    goalId: string,
    expectedRevision: number,
    dependencyGoalIds: readonly string[],
    transitionNote?: string,
  ) => SessionGoalDetail;
  createTodo: (
    goalId: string,
    input: { expectedGoalRevision: number; title: string; notes?: string },
  ) => SessionGoalDetail;
  updateTodo: (
    goalId: string,
    todoId: string,
    input: UpdateSessionGoalTodoInput,
  ) => SessionGoalDetail;
  transitionTodo: (
    goalId: string,
    todoId: string,
    input: TransitionSessionGoalTodoInput,
  ) => SessionGoalDetail;
}>;

export const sessionGoalToolNames = Object.freeze([
  "manage_goal",
  "list_goals",
  "get_goal",
] as const);

/** Compact native planning surface backed by strict, revisioned service methods. */
export function createSessionGoalTools(
  context: SessionGoalToolContext,
): readonly ToolDefinition[] {
  return Object.freeze([
    defineTool<typeof manageGoalParameters, unknown>({
      name: "manage_goal",
      label: "Manage durable goal",
      description:
        "Create or mutate this conversation's durable work state. Operations: " +
        "create(title, successCriteria, optional plan/notes/priority/dependencyGoalIds); " +
        "update(goalId, expectedRevision, changed fields); transition(goalId, expectedRevision, status, optional note); " +
        "set_dependencies(goalId, expectedRevision, dependencyGoalIds); create_todo(goalId, expectedRevision, title); " +
        "update_todo or transition_todo(goalId, todoId, expectedRevision, expectedTodoRevision, fields/status). " +
        "Read current revisions first. Completion requires a note and settled dependencies/todos. " +
        "This is planning data, not permission for external actions.",
      parameters: manageGoalParameters,
      executionMode: "sequential",
      async execute(_toolCallId, input) {
        const actionType = mutationActionType(input.operation);
        return mutate(context, actionType, input.goalId, () => {
          assertOperationFields(input as Record<string, unknown>);
          switch (input.operation) {
            case "create":
              return context.create({
                title: requiredText(input.title, "title"),
                successCriteria: requiredText(input.successCriteria, "successCriteria"),
                ...(input.plan === undefined ? {} : { plan: input.plan }),
                ...(input.notes === undefined ? {} : { notes: input.notes }),
                ...(input.priority === undefined
                  ? {}
                  : { priority: input.priority as SessionGoalPriority }),
                ...(input.dependencyGoalIds === undefined
                  ? {}
                  : { dependencyGoalIds: input.dependencyGoalIds }),
              });
            case "update":
              return context.update(
                requiredText(input.goalId, "goalId"),
                {
                  expectedRevision: requiredRevision(input.expectedRevision, "expectedRevision"),
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.successCriteria === undefined
                    ? {}
                    : { successCriteria: input.successCriteria }),
                  ...(input.plan === undefined ? {} : { plan: input.plan }),
                  ...(input.notes === undefined ? {} : { notes: input.notes }),
                  ...(input.priority === undefined
                    ? {}
                    : { priority: input.priority as SessionGoalPriority }),
                  ...(input.note === undefined ? {} : { transitionNote: input.note }),
                },
              );
            case "transition":
              return context.transition(
                requiredText(input.goalId, "goalId"),
                {
                  expectedRevision: requiredRevision(input.expectedRevision, "expectedRevision"),
                  status: requiredGoalStatus(input.status),
                  ...(input.note === undefined ? {} : { note: input.note }),
                },
              );
            case "set_dependencies":
              return context.setDependencies(
                requiredText(input.goalId, "goalId"),
                requiredRevision(input.expectedRevision, "expectedRevision"),
                input.dependencyGoalIds ?? [],
                input.note,
              );
            case "create_todo":
              return context.createTodo(
                requiredText(input.goalId, "goalId"),
                {
                  expectedGoalRevision: requiredRevision(
                    input.expectedRevision,
                    "expectedRevision",
                  ),
                  title: requiredText(input.title, "title"),
                  ...(input.notes === undefined ? {} : { notes: input.notes }),
                },
              );
            case "update_todo":
              return context.updateTodo(
                requiredText(input.goalId, "goalId"),
                requiredText(input.todoId, "todoId"),
                {
                  expectedGoalRevision: requiredRevision(
                    input.expectedRevision,
                    "expectedRevision",
                  ),
                  expectedTodoRevision: requiredRevision(
                    input.expectedTodoRevision,
                    "expectedTodoRevision",
                  ),
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.notes === undefined ? {} : { notes: input.notes }),
                  ...(input.note === undefined ? {} : { transitionNote: input.note }),
                },
              );
            case "transition_todo":
              return context.transitionTodo(
                requiredText(input.goalId, "goalId"),
                requiredText(input.todoId, "todoId"),
                {
                  expectedGoalRevision: requiredRevision(
                    input.expectedRevision,
                    "expectedRevision",
                  ),
                  expectedTodoRevision: requiredRevision(
                    input.expectedTodoRevision,
                    "expectedTodoRevision",
                  ),
                  status: requiredTodoStatus(input.status),
                  ...(input.note === undefined ? {} : { note: input.note }),
                },
              );
          }
        });
      },
    }),
    defineTool<typeof listGoalsParameters, unknown>({
      name: "list_goals",
      label: "List durable goals",
      description:
        "List this conversation's durable goals and remaining todo counts. Use after restart or context reset; terminal goals are hidden unless requested.",
      parameters: listGoalsParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        try {
          const goals = context.list({
            ...(input.includeTerminal === undefined
              ? {}
              : { includeTerminal: input.includeTerminal }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          });
          return {
            content: [{
              type: "text" as const,
              text: goals.length
                ? truncate(goals.map(renderGoalSummary).join("\n"), maximumGoalToolOutputCharacters)
                : "No durable goals are recorded for this conversation.",
            }],
            details: { goals },
          };
        } catch (error) {
          return goalToolError(error, "Goals could not be listed.");
        }
      },
    }),
    defineTool<typeof getGoalParameters, unknown>({
      name: "get_goal",
      label: "Get durable goal",
      description:
        "Read one same-conversation goal, its plan, dependencies, todos, and recent typed transitions.",
      parameters: getGoalParameters,
      executionMode: "parallel",
      async execute(_toolCallId, input) {
        try {
          const goal = context.get(input.goalId, input.transitionLimit ?? 20);
          if (!goal) return goalToolError(undefined, "Goal is unavailable in this conversation.");
          return {
            content: [{ type: "text" as const, text: renderGoalDetail(goal) }],
            details: { goal },
          };
        } catch (error) {
          return goalToolError(error, "Goal is unavailable in this conversation.");
        }
      },
    }),
  ]);
}

async function mutate(
  context: SessionGoalToolContext,
  actionType: string,
  requestedGoalId: string | undefined,
  operation: () => SessionGoalDetail,
) {
  try {
    const goal = operation();
    context.actions().push(context.store.addAction(actionType, "completed", {
      transport: "pi-tool",
      sessionId: context.sessionId,
      goalId: goal.id,
      status: goal.status,
      revision: goal.revision,
      remainingTodos: goal.todoCounts.remaining,
      blockedDependencies: goal.blockedByGoalIds.length,
    }));
    return {
      content: [{ type: "text" as const, text: renderGoalDetail(goal) }],
      details: { goal },
    };
  } catch (error) {
    context.actions().push(context.store.addAction(actionType, "failed", {
      transport: "pi-tool",
      sessionId: context.sessionId,
      ...(requestedGoalId ? { goalId: requestedGoalId } : {}),
      code: goalErrorCode(error),
    }));
    return goalToolError(error, "The durable goal change was rejected.");
  }
}

function mutationActionType(operation: string): string {
  const names: Record<string, string> = {
    create: "create_goal",
    update: "update_goal",
    transition: "transition_goal",
    set_dependencies: "set_goal_dependencies",
    create_todo: "create_goal_todo",
    update_todo: "update_goal_todo",
    transition_todo: "transition_goal_todo",
  };
  return names[operation] ?? "manage_goal";
}

function assertOperationFields(input: Record<string, unknown>): void {
  const common = ["operation"];
  const allowed: Record<string, readonly string[]> = {
    create: [...common, "title", "successCriteria", "plan", "notes", "priority", "dependencyGoalIds"],
    update: [...common, "goalId", "expectedRevision", "title", "successCriteria", "plan", "notes", "priority", "note"],
    transition: [...common, "goalId", "expectedRevision", "status", "note"],
    set_dependencies: [...common, "goalId", "expectedRevision", "dependencyGoalIds", "note"],
    create_todo: [...common, "goalId", "expectedRevision", "title", "notes"],
    update_todo: [...common, "goalId", "todoId", "expectedRevision", "expectedTodoRevision", "title", "notes", "note"],
    transition_todo: [...common, "goalId", "todoId", "expectedRevision", "expectedTodoRevision", "status", "note"],
  };
  const operation = String(input.operation);
  const permitted = new Set(allowed[operation] ?? common);
  const unexpected = Object.keys(input).find((key) => input[key] !== undefined && !permitted.has(key));
  if (unexpected) {
    throw new SessionGoalValidationError(
      `${unexpected} is not valid for goal operation ${operation}`,
    );
  }
}

function requiredText(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionGoalValidationError(`${field} is required`);
  }
  return value;
}

function requiredRevision(value: number | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new SessionGoalValidationError(`${field} is required`);
  }
  return value!;
}

function requiredGoalStatus(value: string | undefined): SessionGoalStatus {
  if (
    value === "planned" || value === "active" || value === "blocked" ||
    value === "completed" || value === "cancelled"
  ) return value;
  throw new SessionGoalValidationError("a goal lifecycle status is required");
}

function requiredTodoStatus(value: string | undefined): SessionGoalTodoStatus {
  if (
    value === "pending" || value === "in_progress" ||
    value === "completed" || value === "cancelled"
  ) return value;
  throw new SessionGoalValidationError("a todo lifecycle status is required");
}

function renderGoalSummary(goal: SessionGoalSummary): string {
  const blocked = goal.blockedByGoalIds.length
    ? ` · blocked by ${goal.blockedByGoalIds.length} goal(s)`
    : "";
  return `${goal.id} · r${goal.revision} · ${goal.status}/${goal.priority} · ` +
    `${goal.todoCounts.remaining}/${goal.todoCounts.total} todo(s) remaining${blocked} · ` +
    truncate(goal.title, 160);
}

function renderGoalDetail(goal: SessionGoalDetail): string {
  const lines = [
    renderGoalSummary(goal),
    `Success criteria: ${truncate(goal.successCriteria, 2_000)}`,
    `Plan: ${goal.plan ? truncate(goal.plan, 4_000) : "(empty)"}`,
    `Notes: ${goal.notes ? truncate(goal.notes, 1_000) : "(empty)"}`,
  ];
  if (goal.terminalNote) lines.push(`Terminal note: ${truncate(goal.terminalNote, 2_000)}`);
  lines.push("Dependencies:");
  lines.push(...(goal.dependencies.length
    ? goal.dependencies.map((entry) =>
        `- ${entry.id} · ${entry.status} · satisfied=${entry.satisfied} · ${truncate(entry.title, 120)}`
      )
    : ["- (none)"]));
  lines.push("Todos:");
  lines.push(...(goal.todos.length
    ? goal.todos.map((todo) => {
        const detail = todo.resultNote || todo.notes;
        return `- #${todo.position} ${todo.id} · r${todo.revision} · ${todo.status} · ` +
          `${truncate(todo.title, 180)}${detail ? ` — ${truncate(detail, 240)}` : ""}`;
      })
    : ["- (none)"]));
  lines.push("Recent transitions:");
  lines.push(...(goal.recentTransitions.length
    ? goal.recentTransitions.map((entry) =>
        `- #${entry.sequence} ${entry.type} via ${entry.source}` +
        `${entry.fromStatus ? ` ${entry.fromStatus}→${entry.toStatus}` : ""}` +
        `${entry.note ? ` — ${truncate(entry.note, 240)}` : ""}`
      )
    : ["- (none requested)"]));
  return truncate(lines.join("\n"), maximumGoalToolOutputCharacters);
}

function truncate(value: string, maximum: number): string {
  return [...value].length <= maximum
    ? value
    : `${[...value].slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function goalToolError(error: unknown, fallback: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: fallback }],
    details: { ok: false, code: goalErrorCode(error) },
  };
}

function goalErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "SESSION_GOAL_UNAVAILABLE";
}
