import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionGoalConflictError,
  SessionGoalNotFoundError,
  SessionGoalValidationError,
  sessionGoalToolNames,
} from "../src/goals/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("durable goal tools track plans and todos through typed revisioned transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-session-goals-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "session-goal-tools",
  });
  const privateSentinel = "PRIVATE_GOAL_PLAN_SENTINEL";
  try {
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "manage_goal",
        arguments: {
          operation: "create",
          title: `交付 ${privateSentinel}`,
          successCriteria: "所有验收测试通过",
          plan: "先实现，再验证",
          notes: "仅属于当前会话",
          priority: "high",
        },
      },
      { kind: "assistant_text", text: "目标已经建立。" },
    ]);
    const response = await runtime.kernel.sendMessage("goal-parent", {
      mode: "sms",
      text: "请记录这个开发目标。",
    });
    assert.equal(response.status, "completed");
    for (const toolName of sessionGoalToolNames) {
      assert.equal(runtime.model.requests[0].toolNames.includes(toolName), true, toolName);
    }

    let goal = runtime.kernel.listSessionGoals("goal-parent")[0];
    assert.ok(goal);
    assert.equal(goal.status, "planned");
    assert.equal(goal.priority, "high");
    assert.equal(goal.revision, 1);
    assert.equal(goal.todoCounts.remaining, 0);
    const createAction = response.actions.find((entry) => entry.actionType === "create_goal");
    assert.ok(createAction);
    assert.doesNotMatch(JSON.stringify(createAction), new RegExp(privateSentinel, "u"));

    let detail = runtime.kernel.transitionSessionGoal("goal-parent", goal.id, {
      expectedRevision: goal.revision,
      status: "active",
    });
    detail = runtime.kernel.createSessionGoalTodo("goal-parent", goal.id, {
      expectedGoalRevision: detail.revision,
      title: "实现持久化投影",
      notes: "同时写 transition",
    });
    const todoId = detail.todos[0].id;
    assert.throws(
      () => runtime.kernel.transitionSessionGoal("goal-parent", goal.id, {
        expectedRevision: detail.revision,
        status: "completed",
        note: "尚未真的完成",
      }),
      /unfinished todo/u,
    );
    detail = runtime.kernel.transitionSessionGoalTodo("goal-parent", goal.id, todoId, {
      expectedGoalRevision: detail.revision,
      expectedTodoRevision: detail.todos[0].revision,
      status: "in_progress",
    });
    assert.throws(
      () => runtime.kernel.updateSessionGoal("goal-parent", goal.id, {
        expectedRevision: detail.revision - 1,
        notes: "stale write",
      }),
      SessionGoalConflictError,
    );
    detail = runtime.kernel.transitionSessionGoalTodo("goal-parent", goal.id, todoId, {
      expectedGoalRevision: detail.revision,
      expectedTodoRevision: detail.todos[0].revision,
      status: "completed",
      note: "代码和测试均已落盘",
    });
    goal = runtime.kernel.transitionSessionGoal("goal-parent", goal.id, {
      expectedRevision: detail.revision,
      status: "completed",
      note: "验收测试通过",
    });
    assert.equal(goal.status, "completed");
    assert.equal(goal.revision, 6);
    assert.equal(goal.todoCounts.remaining, 0);
    assert.equal(runtime.kernel.listSessionGoals("goal-parent").length, 0);
    assert.equal(runtime.kernel.listSessionGoals("goal-parent", { includeTerminal: true }).length, 1);

    const completed = runtime.kernel.getSessionGoal("goal-parent", goal.id, 20);
    assert.deepEqual(
      completed.recentTransitions.map((entry) => [entry.sequence, entry.type]),
      [
        [1, "goal_created"],
        [2, "goal_status_changed"],
        [3, "todo_created"],
        [4, "todo_status_changed"],
        [5, "todo_status_changed"],
        [6, "goal_status_changed"],
      ],
    );
    assert.equal(completed.todos[0].status, "completed");
    assert.equal(completed.todos[0].resultNote, "代码和测试均已落盘");
    assert.throws(
      () => runtime.kernel.updateSessionGoal("goal-parent", goal.id, {
        expectedRevision: completed.revision,
        plan: "不能重开已完成目标",
      }),
      SessionGoalConflictError,
    );
    assert.throws(
      () => runtime.kernel.sessionGoals.createTodo("goal-parent", goal.id, {
        expectedGoalRevision: completed.revision,
        title: "x".repeat(241),
      }),
      SessionGoalConflictError,
    );

    const ledger = runtime.kernel.database.connection.prepare(`
      SELECT sequence, transition_type, payload_json
      FROM session_goal_transitions WHERE goal_id = ? ORDER BY sequence
    `).all(goal.id) as Array<{
      sequence: number;
      transition_type: string;
      payload_json: string;
    }>;
    assert.deepEqual(ledger.map((entry) => Number(entry.sequence)), [1, 2, 3, 4, 5, 6]);
    assert.equal(ledger.every((entry) => JSON.parse(entry.payload_json) !== null), true);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal dependencies are same-session DAG edges and gate completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-goal-dependencies-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "session-goal-dependencies",
  });
  try {
    runtime.model.enqueue([{ kind: "assistant_text", text: "主会话已建立。" }]);
    await runtime.kernel.sendMessage("dependency-parent", { mode: "sms", text: "你好" });
    const prerequisite = runtime.kernel.createSessionGoal("dependency-parent", {
      title: "完成基础能力",
      successCriteria: "基础验收通过",
      priority: "urgent",
    });
    let dependent = runtime.kernel.createSessionGoal("dependency-parent", {
      title: "交付编排能力",
      successCriteria: "端到端验收通过",
      dependencyGoalIds: [prerequisite.id],
    });
    assert.equal(dependent.ready, false);
    assert.deepEqual(dependent.blockedByGoalIds, [prerequisite.id]);
    assert.throws(
      () => runtime.kernel.setSessionGoalDependencies(
        "dependency-parent",
        prerequisite.id,
        {
          expectedRevision: prerequisite.revision,
          dependencyGoalIds: [dependent.id],
        },
      ),
      /cycle/u,
    );
    assert.throws(
      () => runtime.kernel.transitionSessionGoal("dependency-parent", dependent.id, {
        expectedRevision: dependent.revision,
        status: "completed",
        note: "越过依赖",
      }),
      /depends on incomplete goals/u,
    );

    const completedPrerequisite = runtime.kernel.transitionSessionGoal(
      "dependency-parent",
      prerequisite.id,
      {
        expectedRevision: prerequisite.revision,
        status: "completed",
        note: "基础验收已通过",
      },
    );
    assert.equal(completedPrerequisite.status, "completed");
    dependent = runtime.kernel.getSessionGoal("dependency-parent", dependent.id);
    assert.equal(dependent.ready, true);
    dependent = runtime.kernel.transitionSessionGoal("dependency-parent", dependent.id, {
      expectedRevision: dependent.revision,
      status: "completed",
      note: "依赖和验收均满足",
    });
    assert.equal(dependent.status, "completed");

    runtime.model.enqueue([{ kind: "assistant_text", text: "隔离会话已建立。" }]);
    await runtime.kernel.sendMessage("other-goal-parent", { mode: "sms", text: "你好" });
    assert.throws(
      () => runtime.kernel.getSessionGoal("other-goal-parent", prerequisite.id),
      SessionGoalNotFoundError,
    );
    assert.throws(
      () => runtime.kernel.createSessionGoal("other-goal-parent", {
        title: "非法跨会话依赖",
        successCriteria: "不应创建",
        dependencyGoalIds: [prerequisite.id],
      }),
      SessionGoalNotFoundError,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal projections survive restart, expose guarded HTTP mutations, and cascade on deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-goal-restart-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const sessionId = "resumable-goal-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    first = createTestRuntime({ stateDir, workspaceDir, seed: "goal-restart-first" });
    first.model.enqueue([{ kind: "assistant_text", text: "会话已建立。" }]);
    await first.kernel.sendMessage(sessionId, { mode: "sms", text: "你好" });
    let durable = first.kernel.createSessionGoal(sessionId, {
      title: "跨重启开发任务",
      successCriteria: "两个步骤均有结果",
      plan: "完成第一步后重启，再继续第二步",
    });
    durable = first.kernel.createSessionGoalTodo(sessionId, durable.id, {
      expectedGoalRevision: durable.revision,
      title: "重启前步骤",
    });
    durable = first.kernel.createSessionGoalTodo(sessionId, durable.id, {
      expectedGoalRevision: durable.revision,
      title: "重启后步骤",
    });
    durable = first.kernel.transitionSessionGoalTodo(
      sessionId,
      durable.id,
      durable.todos[0].id,
      {
        expectedGoalRevision: durable.revision,
        expectedTodoRevision: durable.todos[0].revision,
        status: "completed",
        note: "第一步已提交",
      },
    );
    const goalId = durable.id;
    first.dispose();
    first = undefined;

    second = createTestRuntime({ stateDir, workspaceDir, seed: "goal-restart-second" });
    const restored = second.kernel.getSessionGoal(sessionId, goalId);
    assert.equal(restored.todoCounts.completed, 1);
    assert.equal(restored.todoCounts.remaining, 1);
    assert.deepEqual(restored.todos.map((todo) => todo.status), ["completed", "pending"]);
    assert.deepEqual(
      restored.recentTransitions.map((entry) => entry.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(
      Number((second.kernel.database.connection.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version),
      69,
    );

    server = createHttpServer({ kernel: second.kernel });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const collection = `${origin}/api/v1/sessions/${sessionId}/goals`;
    const listed = await fetch(collection);
    assert.equal(listed.status, 200);
    assert.match(await listed.text(), /跨重启开发任务/u);

    const untrusted = await fetch(collection, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ title: "非法目标", successCriteria: "不应创建" }),
    });
    assert.equal(untrusted.status, 403);
    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const created = await fetch(collection, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        title: "HTTP 目标",
        successCriteria: "本地控制面成功创建",
        priority: "low",
      }),
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json() as { goal: { id: string; revision: number } };
    const patched = await fetch(`${collection}/${encodeURIComponent(createdPayload.goal.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        expectedRevision: createdPayload.goal.revision,
        plan: "通过 HTTP 更新",
      }),
    });
    assert.equal(patched.status, 200);
    const patchedPayload = await patched.json() as { goal: { revision: number } };
    const dependencies = await fetch(
      `${collection}/${encodeURIComponent(createdPayload.goal.id)}/dependencies`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          expectedRevision: patchedPayload.goal.revision,
          dependencyGoalIds: [goalId],
        }),
      },
    );
    assert.equal(dependencies.status, 200);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const metadata = second.kernel.getConversationMetadata(sessionId);
    assert.ok(metadata);
    await second.kernel.deleteConversation(sessionId, metadata.title || metadata.id);
    for (const table of [
      "session_goals",
      "session_goal_dependencies",
      "session_goal_todos",
      "session_goal_transitions",
    ]) {
      const count = second.kernel.database.connection.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get() as { count: number };
      assert.equal(Number(count.count), 0, table);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    second?.dispose();
    first?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret goals and audits stay private while incognito mounts no durable goal tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-goal-space-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "session-goal-space",
  });
  const sentinel = "SECRET_GOAL_SENTINEL";
  try {
    const character = runtime.kernel.createCharacter({ name: "目标隔离角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "manage_goal",
        arguments: {
          operation: "create",
          title: sentinel,
          successCriteria: "只在私密空间中可见",
          notes: "不得进入普通空间审计",
        },
      },
      { kind: "assistant_text", text: "私密目标已记录。" },
    ]);
    const response = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "记录私密目标",
    });
    const goal = runtime.kernel.listSessionGoals(secret.id)[0];
    assert.ok(goal);
    assert.equal(goal.conversationSpace, "secret");
    assert.equal(goal.secretOwnerCharacterId, character.id);
    assert.throws(
      () => runtime.kernel.getSessionGoal(normal.id, goal.id),
      SessionGoalNotFoundError,
    );
    const actions = response.actions.filter((entry) => entry.payload.goalId === goal.id);
    assert.ok(actions.length > 0);
    assert.equal(actions.every((entry) =>
      entry.conversationSpace === "secret" &&
      entry.secretOwnerCharacterId === character.id
    ), true);
    assert.doesNotMatch(JSON.stringify(actions), new RegExp(sentinel, "u"));

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "无痕回复" }]);
    await runtime.kernel.sendMessage(incognito.id, { text: "查看可用工具" });
    const incognitoTools = runtime.model.requests.at(-1)?.toolNames ?? [];
    for (const toolName of sessionGoalToolNames) {
      assert.equal(incognitoTools.includes(toolName), false, toolName);
    }
    assert.throws(
      () => runtime.kernel.createSessionGoal(incognito.id, {
        title: "无痕目标",
        successCriteria: "不应持久化",
      }),
      /incognito|无痕|unsupported/iu,
    );
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(
        "SELECT COUNT(*) AS count FROM session_goals",
      ).get() as { count: number }).count),
      1,
    );
    assert.throws(
      () => runtime.kernel.createSessionGoal(secret.id, {
        title: "x".repeat(241),
        successCriteria: "invalid",
      }),
      SessionGoalValidationError,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
