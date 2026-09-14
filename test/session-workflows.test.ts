import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/runtime.js";
import {
  SessionWorkflowConflictError,
  SessionWorkflowNotFoundError,
  SessionWorkflowValidationError,
  sessionWorkflowToolNames,
} from "../src/workflows/index.js";

test("workflow tools execute a bounded DAG with reference-only aggregation", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-dag-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir,
    seed: "workflow-dag",
  });
  const privateSentinel = "PRIVATE_WORKFLOW_OUTPUT_SENTINEL";
  try {
    runtime.kernel.patchAgentPermissions({ shellEnabled: true, workspaceAccess: "read_write" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "manage_workflow",
        arguments: {
          operation: "create",
          title: "并行构建后聚合",
          maxConcurrency: 2,
          timeoutSeconds: 30,
          nodes: [
            {
              key: "left",
              kind: "shell",
              command: `sleep 0.35; printf ${privateSentinel}`,
            },
            { key: "right", kind: "shell", command: "sleep 0.35; printf RIGHT" },
            {
              key: "join",
              kind: "shell",
              dependsOn: ["left", "right"],
              command: "printf JOINED",
            },
          ],
        },
      },
      { kind: "assistant_text", text: "工作流已规划。" },
    ]);
    const response = await runtime.kernel.sendMessage("workflow-parent", {
      mode: "sms",
      text: "规划并行工作流",
    });
    for (const toolName of sessionWorkflowToolNames) {
      assert.equal(runtime.model.requests[0].toolNames.includes(toolName), true, toolName);
    }
    const planned = runtime.kernel.listSessionWorkflows("workflow-parent")[0];
    assert.ok(planned);
    assert.equal(planned.status, "planned");
    assert.equal(planned.counts.total, 3);
    assert.doesNotMatch(JSON.stringify(planned), new RegExp(privateSentinel, "u"));
    const createAction = response.actions.find((entry) => entry.actionType === "create_workflow");
    assert.ok(createAction);
    assert.doesNotMatch(JSON.stringify(createAction), new RegExp(privateSentinel, "u"));

    runtime.kernel.startSessionWorkflow("workflow-parent", planned.id, planned.revision);
    await waitFor(() => {
      const current = runtime.kernel.getSessionWorkflow("workflow-parent", planned.id);
      return current.counts.active === 2 &&
        current.nodes.find((node) => node.key === "join")?.status === "pending";
    });
    await waitFor(
      () => runtime.kernel.getSessionWorkflow("workflow-parent", planned.id).status === "completed",
      5_000,
    );
    const completed = runtime.kernel.getSessionWorkflow("workflow-parent", planned.id, 100);
    assert.equal(completed.counts.completed, 3);
    assert.equal(completed.nodes.every((node) => node.status === "completed"), true);
    assert.equal(completed.nodes.every((node) => node.grants.kind === "shell" &&
      node.grants.workspaceAccess === "off" && !node.grants.networkEnabled), true);
    assert.equal(completed.nodes.every((node) => node.resultReference?.jobId), true);
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(privateSentinel, "u"));
    assert.deepEqual(
      completed.recentEvents.filter((entry) => entry.type === "node_launch_reserved").length,
      3,
    );
    const inputRows = runtime.kernel.database.connection.prepare(`
      SELECT input_json FROM session_workflow_nodes WHERE workflow_id = ?
    `).all(planned.id) as Array<{ input_json: string }>;
    assert.equal(inputRows.some((row) => row.input_json.includes(privateSentinel)), true);
    const admissionRows = runtime.kernel.database.connection.prepare(`
      SELECT admission_key FROM execution_jobs WHERE parent_session_id = ?
    `).all("workflow-parent") as Array<{ admission_key: string }>;
    assert.equal(admissionRows.length, 3);
    assert.equal(new Set(admissionRows.map((row) => row.admission_key)).size, 3);

    assert.throws(
      () => runtime.kernel.createSessionWorkflow("workflow-parent", {
        title: "循环 DAG",
        nodes: [
          { key: "a", kind: "shell", command: ":", dependsOn: ["b"] },
          { key: "b", kind: "shell", command: ":", dependsOn: ["a"] },
        ],
      }),
      SessionWorkflowValidationError,
    );
    const metadata = runtime.kernel.getConversationMetadata("workflow-parent");
    assert.ok(metadata);
    await runtime.kernel.deleteConversation(
      "workflow-parent",
      metadata.title || metadata.id,
    );
    for (const table of [
      "session_workflows",
      "session_workflow_nodes",
      "session_workflow_dependencies",
      "session_workflow_events",
    ]) {
      assert.equal(Number((runtime.kernel.database.connection.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get() as { count: number }).count), 0, table);
    }
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow recovery attaches one admitted child and requires trusted explicit replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-recovery-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const parentSessionId = "workflow-recovery-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    first = createTestRuntime({ stateDir, workspaceDir, seed: "workflow-recovery-first" });
    first.kernel.patchAgentPermissions({ shellEnabled: true, workspaceAccess: "read_write" });
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立会话" });
    const workflow = first.kernel.createSessionWorkflow(parentSessionId, {
      title: "恢复挂接窗口",
      timeoutSeconds: 30,
      nodes: [{
        key: "effect",
        kind: "shell",
        workspaceAccess: "read_write",
        command: [
          "if test -f replay-marker.txt",
          "then printf y >> replay-result.txt",
          "else printf x > replay-marker.txt; sleep 10",
          "fi",
        ].join("; "),
      }],
    });
    first.kernel.sessionWorkflows.start(parentSessionId, workflow.id, workflow.revision, "host");
    const reservation = first.kernel.sessionWorkflows.reserveReady(parentSessionId, workflow.id)[0];
    assert.ok(reservation);
    const child = first.kernel.executionJobs.start({
      parentSessionId,
      command: (reservation.input as { command: string }).command,
      mode: "sms",
      conversationSpace: "normal",
      workspaceKey: "normal",
      workspaceDir,
      workspaceAccess: "read_write",
      networkEnabled: false,
      timeoutSeconds: 30,
      admissionKey: reservation.admissionKey,
    });
    await waitFor(() => existsSync(join(workspaceDir, "replay-marker.txt")));
    assert.equal(first.kernel.getSessionWorkflow(parentSessionId, workflow.id).nodes[0].status, "launching");
    assert.throws(
      () => first!.kernel.retryExecutionJob(parentSessionId, child.id),
      SessionWorkflowConflictError,
      "the admission-key crash window must still be workflow-owned",
    );
    first.dispose();
    first = undefined;

    second = createTestRuntime({ stateDir, workspaceDir, seed: "workflow-recovery-second" });
    await waitFor(() =>
      second!.kernel.getSessionWorkflow(parentSessionId, workflow.id).status === "blocked"
    );
    let recovered = second.kernel.getSessionWorkflow(parentSessionId, workflow.id);
    assert.equal(recovered.nodes[0].childJobId, child.id);
    assert.equal(recovered.nodes[0].status, "decision_required");
    assert.equal(recovered.nodes[0].decisionReason, "process_restarted");
    assert.equal(readFileSync(join(workspaceDir, "replay-marker.txt"), "utf8"), "x");
    assert.equal(Number((second.kernel.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM execution_jobs WHERE admission_key = ?
    `).get(reservation.admissionKey) as { count: number }).count), 1);

    server = createHttpServer({ kernel: second.kernel });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const decisionUrl = `${origin}/api/v1/sessions/${parentSessionId}/workflows/${encodeURIComponent(workflow.id)}/nodes/effect/decision`;
    const rejected = await fetch(decisionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ decision: "retry", note: "确认重放" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(second.kernel.getSessionWorkflow(parentSessionId, workflow.id).status, "blocked");

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const httpPrivateCommand = "HTTP_PRIVATE_WORKFLOW_COMMAND_SENTINEL";
    const createdResponse = await fetch(
      `${origin}/api/v1/sessions/${parentSessionId}/workflows`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          title: "HTTP 工作流",
          nodes: [{ key: "http", kind: "shell", command: `printf ${httpPrivateCommand}` }],
        }),
      },
    );
    assert.equal(createdResponse.status, 201);
    const createdBody = await createdResponse.json() as {
      workflow: { id: string; revision: number; status: string };
    };
    assert.equal(createdBody.workflow.status, "planned");
    assert.doesNotMatch(JSON.stringify(createdBody), new RegExp(httpPrivateCommand, "u"));
    const cancelledResponse = await fetch(
      `${origin}/api/v1/sessions/${parentSessionId}/workflows/${encodeURIComponent(createdBody.workflow.id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({
          expectedRevision: createdBody.workflow.revision,
          note: "清理 HTTP 路由夹具",
        }),
      },
    );
    assert.equal(cancelledResponse.status, 202);
    const bypass = await fetch(
      `${origin}/api/v1/sessions/${parentSessionId}/execution-jobs/${encodeURIComponent(child.id)}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: "{}",
      },
    );
    assert.equal(bypass.status, 409);
    assert.equal(second.kernel.getExecutionJob(parentSessionId, child.id).status, "idle");
    const retried = await fetch(decisionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ decision: "retry", note: "用户确认外部效果可以重放" }),
    });
    assert.equal(retried.status, 202);
    await waitFor(() =>
      second!.kernel.getSessionWorkflow(parentSessionId, workflow.id).status === "completed",
      5_000,
    );
    recovered = second.kernel.getSessionWorkflow(parentSessionId, workflow.id);
    assert.equal(recovered.nodes[0].replayCount, 1);
    assert.equal(second.kernel.getExecutionJob(parentSessionId, child.id).currentAttempt, 2);
    assert.equal(readFileSync(join(workspaceDir, "replay-result.txt"), "utf8"), "y");
    assert.equal(Number((second.kernel.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM execution_jobs WHERE admission_key = ?
    `).get(reservation.admissionKey) as { count: number }).count), 1);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    first?.dispose();
    second?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow cancellation and deadlines propagate to descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-cancel-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "workflow-cancel",
  });
  try {
    runtime.kernel.patchAgentPermissions({ shellEnabled: true });
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage("workflow-cancel-parent", { mode: "sms", text: "你好" });
    let workflow = runtime.kernel.createSessionWorkflow("workflow-cancel-parent", {
      title: "取消传播",
      maxConcurrency: 2,
      nodes: [
        { key: "one", kind: "shell", command: "sleep 10" },
        { key: "two", kind: "shell", command: "sleep 10" },
        { key: "later", kind: "shell", command: ":", dependsOn: ["one"] },
      ],
    });
    runtime.kernel.startSessionWorkflow("workflow-cancel-parent", workflow.id, workflow.revision);
    await waitFor(() =>
      runtime.kernel.getSessionWorkflow("workflow-cancel-parent", workflow.id).counts.active === 2
    );
    workflow = runtime.kernel.getSessionWorkflow("workflow-cancel-parent", workflow.id);
    runtime.kernel.cancelSessionWorkflow(
      "workflow-cancel-parent",
      workflow.id,
      workflow.revision,
      "用户停止工作流",
    );
    await waitFor(() =>
      runtime.kernel.getSessionWorkflow("workflow-cancel-parent", workflow.id).status === "cancelled"
    );
    const cancelled = runtime.kernel.getSessionWorkflow("workflow-cancel-parent", workflow.id);
    assert.equal(cancelled.terminalNote, "用户停止工作流");
    assert.equal(cancelled.nodes.find((node) => node.key === "later")?.status, "skipped");
    assert.equal(cancelled.nodes.filter((node) => node.childJobId)
      .every((node) => node.status === "cancelled"), true);

    const deadline = runtime.kernel.createSessionWorkflow("workflow-cancel-parent", {
      title: "截止时间传播",
      timeoutSeconds: 1,
      nodes: [{ key: "slow", kind: "shell", command: "sleep 10", timeoutSeconds: 1 }],
    });
    runtime.kernel.startSessionWorkflow("workflow-cancel-parent", deadline.id, deadline.revision);
    await waitFor(() =>
      runtime.kernel.getSessionWorkflow("workflow-cancel-parent", deadline.id).counts.active === 1
    );
    runtime.clock.advance(2_000);
    await runtime.kernel.workflowCoordinator.pump("workflow-cancel-parent", deadline.id);
    await waitFor(() =>
      runtime.kernel.getSessionWorkflow("workflow-cancel-parent", deadline.id).status === "cancelled"
    );
    const expired = runtime.kernel.getSessionWorkflow("workflow-cancel-parent", deadline.id);
    assert.equal(expired.terminalNote, "Workflow deadline exceeded");
    assert.equal(expired.nodes[0].status, "cancelled");
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancelling workflow survives restart and settles descendants before becoming terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-cancel-restart-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const parentSessionId = "workflow-cancel-restart-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  try {
    first = createTestRuntime({ stateDir, workspaceDir, seed: "workflow-cancel-restart-first" });
    first.kernel.patchAgentPermissions({ shellEnabled: true });
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "你好" });
    const planned = first.kernel.createSessionWorkflow(parentSessionId, {
      title: "跨重启取消",
      nodes: [{ key: "slow", kind: "shell", command: "sleep 10" }],
    });
    first.kernel.startSessionWorkflow(parentSessionId, planned.id, planned.revision);
    await waitFor(() =>
      first!.kernel.getSessionWorkflow(parentSessionId, planned.id).counts.active === 1
    );
    const running = first.kernel.getSessionWorkflow(parentSessionId, planned.id);
    const childJobId = running.nodes[0].childJobId;
    assert.ok(childJobId);
    const cancelling = first.kernel.sessionWorkflows.requestCancel(
      parentSessionId,
      planned.id,
      running.revision,
      "跨重启保留的取消原因",
      "host",
    );
    assert.equal(cancelling.status, "cancelling");
    first.dispose();
    first = undefined;

    second = createTestRuntime({ stateDir, workspaceDir, seed: "workflow-cancel-restart-second" });
    await waitFor(() =>
      second!.kernel.getSessionWorkflow(parentSessionId, planned.id).status === "cancelled"
    );
    const recovered = second.kernel.getSessionWorkflow(parentSessionId, planned.id, 100);
    assert.equal(recovered.terminalNote, "跨重启保留的取消原因");
    assert.equal(recovered.counts.active, 0);
    assert.equal(recovered.counts.pending, 0);
    assert.equal(recovered.counts.decisionRequired, 0);
    assert.equal(recovered.nodes[0].status, "cancelled");
    assert.equal(second.kernel.getExecutionJob(parentSessionId, childJobId).status, "cancelled");
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependent Subagents receive bounded references, not predecessor output bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-subagent-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "workflow-subagent",
  });
  const outputSentinel = "PRIVATE_PREDECESSOR_BODY_SENTINEL";
  try {
    runtime.kernel.patchAgentPermissions({ shellEnabled: true, workspaceAccess: "read_only" });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage("workflow-subagent-parent", { mode: "sms", text: "你好" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "已按引用完成聚合。" }]);
    const workflow = runtime.kernel.createSessionWorkflow("workflow-subagent-parent", {
      title: "引用聚合",
      maxConcurrency: 1,
      nodes: [
        { key: "produce", kind: "shell", command: `printf ${outputSentinel}` },
        {
          key: "consume",
          kind: "subagent",
          role: "reviewer",
          task: "根据依赖引用确认前置任务状态",
          workspaceAccess: "off",
          moduleIds: [],
          skillNames: [],
          dependsOn: ["produce"],
        },
      ],
    });
    runtime.kernel.startSessionWorkflow(
      "workflow-subagent-parent",
      workflow.id,
      workflow.revision,
    );
    await waitFor(() =>
      runtime.kernel.getSessionWorkflow("workflow-subagent-parent", workflow.id).status === "completed",
      5_000,
    );
    const completed = runtime.kernel.getSessionWorkflow("workflow-subagent-parent", workflow.id);
    const consume = completed.nodes.find((node) => node.key === "consume");
    assert.ok(consume?.childJobId);
    const child = runtime.kernel.getSubagentJob("workflow-subagent-parent", consume.childJobId);
    assert.equal(child.grants.workspaceAccess, "off");
    assert.deepEqual(child.grants.moduleIds, []);
    assert.deepEqual(child.grants.skillNames, []);
    assert.equal(Number((runtime.kernel.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM subagent_job_deliveries WHERE job_id = ?
    `).get(child.id) as { count: number }).count), 0);
    const childRequest = runtime.model.requests.find((request) =>
      JSON.stringify(request.messages).includes("Dependency result references")
    );
    assert.ok(childRequest);
    assert.match(JSON.stringify(childRequest.messages), /execution_job/u);
    assert.doesNotMatch(JSON.stringify(childRequest.messages), new RegExp(outputSentinel, "u"));
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(outputSentinel, "u"));

    runtime.model.enqueue([{ kind: "assistant_text", text: "另一个会话。" }]);
    await runtime.kernel.sendMessage("other-workflow-parent", { mode: "sms", text: "你好" });
    assert.throws(
      () => runtime.kernel.getSessionWorkflow("other-workflow-parent", workflow.id),
      SessionWorkflowNotFoundError,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret workflows remain owner-scoped and incognito exposes no workflow surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-workflow-space-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "workflow-space",
  });
  const sentinel = "SECRET_WORKFLOW_TITLE_SENTINEL";
  try {
    runtime.kernel.patchAgentPermissions({ shellEnabled: true });
    const character = runtime.kernel.createCharacter({ name: "工作流隔离角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    const workflow = runtime.kernel.createSessionWorkflow(secret.id, {
      title: sentinel,
      nodes: [{ key: "private", kind: "shell", command: "printf PRIVATE_BODY" }],
    });
    assert.equal(workflow.conversationSpace, "secret");
    assert.equal(workflow.secretOwnerCharacterId, character.id);
    assert.throws(
      () => runtime.kernel.getSessionWorkflow(normal.id, workflow.id),
      SessionWorkflowNotFoundError,
    );
    const actions = runtime.kernel.store.actions.filter((entry) =>
      entry.payload.workflowId === workflow.id
    );
    assert.ok(actions.length > 0);
    assert.equal(actions.every((entry) =>
      entry.conversationSpace === "secret" &&
      entry.secretOwnerCharacterId === character.id
    ), true);
    assert.doesNotMatch(JSON.stringify(actions), new RegExp(sentinel, "u"));

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "无痕回复" }]);
    await runtime.kernel.sendMessage(incognito.id, { text: "查看工具" });
    const toolNames = runtime.model.requests.at(-1)?.toolNames ?? [];
    for (const toolName of sessionWorkflowToolNames) {
      assert.equal(toolNames.includes(toolName), false, toolName);
    }
    assert.throws(
      () => runtime.kernel.createSessionWorkflow(incognito.id, {
        title: "无痕工作流",
        nodes: [{ key: "x", kind: "shell", command: ":" }],
      }),
      /incognito|无痕|unsupported/iu,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
