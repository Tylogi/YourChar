import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import {
  YourCharApiError,
  YourCharClient,
  type CreateSessionGoalInput,
  type CreateSessionWorkflowInput,
  type SessionGoalDetail,
  type SessionWorkflowDetail,
} from "../src/sdk/index.js";
import { createTestRuntime } from "../src/testing/runtime.js";

const token = "contract-test-token-0123456789-abcdef";

type ContractSurface = Readonly<{
  createGoal(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoalDetail>;
  createTodo(
    sessionId: string,
    goalId: string,
    input: { expectedGoalRevision: number; title: string },
  ): Promise<SessionGoalDetail>;
  completeTodo(
    sessionId: string,
    goalId: string,
    todoId: string,
    input: { expectedGoalRevision: number; expectedTodoRevision: number },
  ): Promise<SessionGoalDetail>;
  completeGoal(sessionId: string, goalId: string, expectedRevision: number): Promise<SessionGoalDetail>;
  getGoal(sessionId: string, goalId: string): Promise<SessionGoalDetail>;
  createWorkflow(sessionId: string, input: CreateSessionWorkflowInput): Promise<SessionWorkflowDetail>;
  cancelWorkflow(
    sessionId: string,
    workflowId: string,
    expectedRevision: number,
  ): Promise<SessionWorkflowDetail>;
  startShell(sessionId: string): Promise<unknown>;
  archiveSession(sessionId: string): Promise<unknown>;
}>;

test("Kernel, authenticated HTTP, and SDK preserve one workflow contract", async () => {
  const projections = [];
  for (const kind of ["kernel", "http", "sdk"] as const) {
    projections.push(await runContract(kind));
  }
  assert.deepEqual(projections[1], projections[0]);
  assert.deepEqual(projections[2], projections[0]);
  assert.deepEqual(projections[0], {
    goal: {
      status: "completed",
      priority: "high",
      todoStatuses: ["completed"],
      transitionTypes: [
        "goal_created",
        "todo_created",
        "todo_status_changed",
        "goal_status_changed",
      ],
    },
    workflow: {
      status: "cancelled",
      nodeStatuses: ["skipped"],
      eventTypes: ["workflow_created", "workflow_status_changed"],
    },
    enforcement: {
      foreignGoal: "SESSION_GOAL_NOT_FOUND",
      shellPermission: "EXECUTION_JOB_STATE_CONFLICT",
      archivedLifecycle: "SESSION_ARCHIVED",
    },
  });
});

async function runContract(kind: "kernel" | "http" | "sdk") {
  const root = mkdtempSync(join(tmpdir(), `yourchar-contract-${kind}-`));
  const runtime = createTestRuntime({
    seed: "headless-contract",
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    startPrivateInboxCoordinator: false,
  });
  let server: Server | undefined;
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    const character = runtime.kernel.createCharacter({ name: "契约角色" });
    const otherCharacter = runtime.kernel.createCharacter({ name: "外部角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const otherSession = await runtime.kernel.openCanonicalPrivateConversation(otherCharacter.id);

    let surface: ContractSurface;
    if (kind === "kernel") {
      surface = kernelSurface(runtime.kernel);
    } else {
      server = createHttpServer({ kernel: runtime.kernel, headlessApiToken: token });
      await listen(server);
      const origin = originOf(server);
      surface = kind === "http"
        ? httpSurface(origin)
        : sdkSurface(new YourCharClient({ baseUrl: origin, token }));
    }

    const goal = await surface.createGoal(session.id, {
      title: "完成跨入口契约",
      successCriteria: "三个入口产生相同状态",
      priority: "high",
    });
    const withTodo = await surface.createTodo(session.id, goal.id, {
      expectedGoalRevision: goal.revision,
      title: "执行契约步骤",
    });
    const todo = withTodo.todos[0];
    const todoCompleted = await surface.completeTodo(session.id, goal.id, todo.id, {
      expectedGoalRevision: withTodo.revision,
      expectedTodoRevision: todo.revision,
    });
    const goalCompleted = await surface.completeGoal(
      session.id,
      goal.id,
      todoCompleted.revision,
    );

    const workflow = await surface.createWorkflow(session.id, {
      title: "契约工作流",
      nodes: [{ key: "worker", kind: "subagent", role: "worker", task: "验证入口一致性" }],
    });
    const workflowCancelled = await surface.cancelWorkflow(
      session.id,
      workflow.id,
      workflow.revision,
    );

    const foreignGoal = await capturedCode(() => surface.getGoal(otherSession.id, goal.id));
    const shellPermission = await capturedCode(() => surface.startShell(session.id));
    await surface.archiveSession(session.id);
    const archivedLifecycle = await capturedCode(() => surface.createGoal(session.id, {
      title: "归档后不允许创建",
      successCriteria: "必须被拒绝",
    }));

    return {
      goal: {
        status: goalCompleted.status,
        priority: goalCompleted.priority,
        todoStatuses: goalCompleted.todos.map((entry) => entry.status),
        transitionTypes: goalCompleted.recentTransitions.map((entry) => entry.type),
      },
      workflow: {
        status: workflowCancelled.status,
        nodeStatuses: workflowCancelled.nodes.map((entry) => entry.status),
        eventTypes: workflowCancelled.recentEvents.map((entry) => entry.type),
      },
      enforcement: { foreignGoal, shellPermission, archivedLifecycle },
    };
  } finally {
    if (server) await close(server);
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

function kernelSurface(kernel: CompanionKernel): ContractSurface {
  return {
    createGoal: async (sessionId, input) => kernel.createSessionGoal(sessionId, input),
    createTodo: async (sessionId, goalId, input) =>
      kernel.createSessionGoalTodo(sessionId, goalId, input),
    completeTodo: async (sessionId, goalId, todoId, input) =>
      kernel.transitionSessionGoalTodo(sessionId, goalId, todoId, {
        ...input,
        status: "completed",
        note: "契约步骤完成",
      }),
    completeGoal: async (sessionId, goalId, expectedRevision) =>
      kernel.transitionSessionGoal(sessionId, goalId, {
        expectedRevision,
        status: "completed",
        note: "契约完成",
      }),
    getGoal: async (sessionId, goalId) => kernel.getSessionGoal(sessionId, goalId),
    createWorkflow: async (sessionId, input) => kernel.createSessionWorkflow(sessionId, input),
    cancelWorkflow: async (sessionId, workflowId, expectedRevision) =>
      kernel.cancelSessionWorkflow(sessionId, workflowId, expectedRevision, "契约取消"),
    startShell: async (sessionId) => kernel.startExecutionJob(sessionId, { command: ":" }),
    archiveSession: async (sessionId) => kernel.archiveConversation(sessionId),
  };
}

function httpSurface(origin: string): ContractSurface {
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/headless/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get("x-yourchar-api-version"), "1");
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new ContractError(String(payload.code ?? `HTTP_${response.status}`));
    }
    return payload as T;
  };
  const goal = async (method: string, path: string, body?: unknown) =>
    (await json<{ goal: SessionGoalDetail }>(method, path, body)).goal;
  const workflow = async (method: string, path: string, body?: unknown) =>
    (await json<{ workflow: SessionWorkflowDetail }>(method, path, body)).workflow;
  return {
    createGoal: (sessionId, input) => goal("POST", `/sessions/${id(sessionId)}/goals`, input),
    createTodo: (sessionId, goalId, input) =>
      goal("POST", `/sessions/${id(sessionId)}/goals/${id(goalId)}/todos`, input),
    completeTodo: (sessionId, goalId, todoId, input) => goal(
      "POST",
      `/sessions/${id(sessionId)}/goals/${id(goalId)}/todos/${id(todoId)}/transition`,
      { ...input, status: "completed", note: "契约步骤完成" },
    ),
    completeGoal: (sessionId, goalId, expectedRevision) => goal(
      "POST",
      `/sessions/${id(sessionId)}/goals/${id(goalId)}/transition`,
      { expectedRevision, status: "completed", note: "契约完成" },
    ),
    getGoal: (sessionId, goalId) =>
      goal("GET", `/sessions/${id(sessionId)}/goals/${id(goalId)}`),
    createWorkflow: (sessionId, input) =>
      workflow("POST", `/sessions/${id(sessionId)}/workflows`, input),
    cancelWorkflow: (sessionId, workflowId, expectedRevision) => workflow(
      "POST",
      `/sessions/${id(sessionId)}/workflows/${id(workflowId)}/cancel`,
      { expectedRevision, note: "契约取消" },
    ),
    startShell: (sessionId) =>
      json("POST", `/sessions/${id(sessionId)}/execution-jobs`, { command: ":" }),
    archiveSession: (sessionId) =>
      json("POST", `/sessions/${id(sessionId)}/archive`, {}),
  };
}

function sdkSurface(client: YourCharClient): ContractSurface {
  return {
    createGoal: (sessionId, input) => client.createGoal(sessionId, input),
    createTodo: (sessionId, goalId, input) => client.createGoalTodo(sessionId, goalId, input),
    completeTodo: (sessionId, goalId, todoId, input) =>
      client.transitionGoalTodo(sessionId, goalId, todoId, {
        ...input,
        status: "completed",
        note: "契约步骤完成",
      }),
    completeGoal: (sessionId, goalId, expectedRevision) =>
      client.transitionGoal(sessionId, goalId, {
        expectedRevision,
        status: "completed",
        note: "契约完成",
      }),
    getGoal: (sessionId, goalId) => client.getGoal(sessionId, goalId),
    createWorkflow: (sessionId, input) => client.createWorkflow(sessionId, input),
    cancelWorkflow: (sessionId, workflowId, expectedRevision) =>
      client.cancelWorkflow(sessionId, workflowId, {
        expectedRevision,
        note: "契约取消",
      }),
    startShell: (sessionId) => client.startExecutionJob(sessionId, { command: ":" }),
    archiveSession: (sessionId) => client.archiveSession(sessionId),
  };
}

async function capturedCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    if (error instanceof YourCharApiError) return error.apiCode;
    if (error instanceof Error && error.name === "ConversationArchivedError") {
      return "SESSION_ARCHIVED";
    }
    if (error && typeof error === "object" && "code" in error) {
      return String((error as { code: unknown }).code);
    }
    throw error;
  }
  assert.fail("contract operation unexpectedly succeeded");
}

class ContractError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function id(value: string): string {
  return encodeURIComponent(value);
}

function originOf(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
