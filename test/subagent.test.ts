import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  maximumSubagentRuntimeTimeoutMs,
  subagentMcpRequestTimeoutMs,
} from "../src/mcp/subagent-server.js";
import { defaultSubagentTimeoutMs } from "../src/pi/session-runtime.js";
import { createTestRuntime } from "../src/testing/index.js";

test("subagent deadlines are finite and the MCP envelope stays 30 seconds wider", () => {
  assert.equal(defaultSubagentTimeoutMs, 600_000);
  assert.equal(subagentMcpRequestTimeoutMs(defaultSubagentTimeoutMs), 630_000);
  assert.equal(
    subagentMcpRequestTimeoutMs(maximumSubagentRuntimeTimeoutMs),
    2_147_483_647,
  );
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => subagentMcpRequestTimeoutMs(invalid),
      /positive finite number/u,
    );
    assert.throws(
      () => createTestRuntime({ seed: `subagent-invalid-${String(invalid)}`, subagentTimeoutMs: invalid }),
      /subagentTimeoutMs must be a positive finite number/u,
    );
  }
  assert.throws(
    () => subagentMcpRequestTimeoutMs(maximumSubagentRuntimeTimeoutMs + 1),
    /must not exceed/u,
  );
});

test("private Pi session delegates to an isolated read-only subagent and resumes with its result", async () => {
  const runtime = createTestRuntime({ seed: "subagent-private" });
  try {
    const character = runtime.kernel.createCharacter({
      name: "林澈",
      soulMarkdown: "# SOUL.md - 林澈\n\n私聊角色秘密：只在父会话中出现。",
    });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "subagent-note.txt",
      bytes: Buffer.from("workspace evidence: pine-17\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.kernel.patchModelApiConfig({ reasoningEffort: "xhigh" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: {
          role: "reviewer",
          task: "Read uploads/subagent-note.txt and report its evidence value.",
          context: "Check the exact value; do not guess.",
        },
      },
      { kind: "tool_call", name: "read", arguments: { path: "uploads/subagent-note.txt" } },
      { kind: "assistant_text", text: "Independent review: the evidence value is pine-17." },
      { kind: "assistant_text", text: "我让独立审查员核对过了，记录值是 pine-17。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-private-session", {
      mode: "sms",
      characterId: character.id,
      text: "请找一个独立审查员核对 workspace 记录。",
    });

    assert.equal(response.status, "completed");
    assert.match(response.reply, /pine-17/);
    assert.equal(runtime.model.requests.length, 4);
    const parentInitial = runtime.model.requests[0];
    const childInitial = runtime.model.requests[1];
    const childAfterRead = runtime.model.requests[2];
    const parentFinal = runtime.model.requests[3];
    assert.ok(parentInitial.toolNames.includes("delegate_task"));
    assert.match(parentInitial.systemPrompt, /私聊角色秘密/);
    assert.match(childInitial.systemPrompt, /isolated reviewer subagent/);
    assert.doesNotMatch(childInitial.systemPrompt, /私聊角色秘密/);
    assert.deepEqual(
      childInitial.toolNames.sort(),
      ["list_workspace", "read", "read_document"],
    );
    for (const forbidden of [
      "delegate_task",
      "write",
      "edit",
      "bash",
      "create_schedule_item",
      "propose_memory",
      "update_user_profile",
      "update_current_character_soul",
      "update_scene",
    ]) {
      assert.equal(childInitial.toolNames.includes(forbidden), false, `child exposed ${forbidden}`);
    }
    assert.match(JSON.stringify(childAfterRead.messages), /workspace evidence: pine-17/);
    assert.match(JSON.stringify(parentFinal.messages), /Independent review: the evidence value is pine-17/);
    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.ok(delegation);
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.payload.role, "reviewer");
    assert.equal(delegation.payload.modelCalls, 2);
    assert.equal(delegation.payload.toolCalls, 1);
    assert.equal("task" in delegation.payload, false);
    const traces = runtime.kernel.recentModelContextTraces(10);
    assert.ok(traces.some((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-private-session:")),
    JSON.stringify(traces.map((trace) => [trace.turnKind, trace.sessionId])));
    const subagentTrace = traces.find((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-private-session:")
    );
    assert.equal(subagentTrace?.payload.reasoning_effort, "xhigh");
  } finally {
    runtime.dispose();
  }
});

test("a short hard deadline times out a subagent without activity-based extension", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-hard-timeout",
    subagentTimeoutMs: 30,
  });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Perform a deliberately slow review." },
      },
      { kind: "assistant_text", text: "This result arrived too late.", delayMs: 90 },
      { kind: "assistant_text", text: "委派超过了固定时限。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-hard-timeout", {
      mode: "sms",
      text: "委派一个会超过测试时限的任务。",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.reply, "委派超过了固定时限。");
    const session = await runtime.kernel.getSession("subagent-hard-timeout");
    assert.match(JSON.stringify(session.messages), /Subagent timed out after 0\.03 seconds/u);
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "failed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "completed").length, 0);
  } finally {
    runtime.dispose();
  }
});

test("a longer hard deadline allows multiple child model rounds and a final result", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-longer-timeout",
    subagentTimeoutMs: 300,
  });
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "deadline-note.txt",
      bytes: Buffer.from("deadline evidence: amber-42\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Read the note and return its evidence." },
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/deadline-note.txt" },
        delayMs: 60,
      },
      { kind: "assistant_text", text: "The evidence is amber-42.", delayMs: 80 },
      { kind: "assistant_text", text: "子任务核对结果是 amber-42。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-longer-timeout", {
      mode: "sms",
      text: "委派核对这条记录。",
    });

    assert.equal(response.status, "completed");
    assert.match(response.reply, /amber-42/u);
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "completed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "failed").length, 0);
    const delegation = delegations.find((action) => action.status === "completed");
    assert.ok(delegation);
    assert.equal(delegation.payload.modelCalls, 2);
    assert.equal(delegation.payload.toolCalls, 1);
  } finally {
    runtime.dispose();
  }
});

test("external cancellation takes precedence over the subagent hard deadline", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-cancel-priority",
    subagentTimeoutMs: 60,
  });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "worker", task: "Wait for external cancellation." },
      },
      { kind: "assistant_text", text: "This must never become a result.", delayMs: 180 },
    ]);
    const controller = new AbortController();
    const pending = runtime.kernel.streamMessage(
      "subagent-cancel-priority",
      { mode: "sms", text: "开始后等待我取消。" },
      () => undefined,
      controller.signal,
    );
    await waitFor(() => runtime.model.requests.length >= 2);
    controller.abort();

    const response = await pending;
    assert.equal(response.status, "cancelled");
    assert.equal(response.reply, "本轮生成已取消。");
    await waitFor(() => runtime.kernel.store.actions.some((action) =>
      action.actionType === "delegate_subagent"));
    const session = await runtime.kernel.getSession("subagent-cancel-priority");
    assert.doesNotMatch(JSON.stringify(session.messages), /Subagent timed out/u);
    const delegations = runtime.kernel.store.actions.filter((action) =>
      action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "failed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "completed").length, 0);
  } finally {
    runtime.dispose();
  }
});

test("MLX reasoning none disables thinking for delegated subagents without a top-level effort", async () => {
  const runtime = createTestRuntime({ seed: "subagent-mlx-none" });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.kernel.patchModelApiConfig({
      model: "scripted-MLX-model",
      reasoningEffort: "none",
    });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Return a short independent check." },
      },
      { kind: "assistant_text", text: "Independent check complete." },
      { kind: "assistant_text", text: "独立检查已完成。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-mlx-none", {
      mode: "sms",
      text: "请委托一次独立检查。",
    });
    assert.equal(response.status, "completed");
    const trace = runtime.kernel.recentModelContextTraces(10).find((entry) =>
      entry.turnKind === "subagent" && entry.sessionId.startsWith("subagent:subagent-mlx-none:")
    );
    assert.ok(trace);
    assert.equal("reasoning_effort" in trace.payload, false);
    assert.deepEqual(trace.payload.chat_template_kwargs, {
      enable_thinking: false,
      preserve_thinking: true,
    });
  } finally {
    runtime.dispose();
  }
});

test("a secret conversation subagent inherits only its character-scoped secret Workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-secret-subagent-"));
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    seed: "subagent-secret-workspace",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密审查角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.kernel.uploadSessionWorkspaceFile(normal.id, {
      directory: "uploads",
      name: "scope.txt",
      bytes: Buffer.from("normal-only-sentinel\n", "utf8"),
    });
    runtime.kernel.uploadSessionWorkspaceFile(secret.id, {
      directory: "uploads",
      name: "scope.txt",
      bytes: Buffer.from("secret-only-sentinel\n", "utf8"),
    });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: {
          role: "reviewer",
          task: "Read uploads/scope.txt and report the exact sentinel.",
        },
      },
      { kind: "tool_call", name: "read", arguments: { path: "uploads/scope.txt" } },
      { kind: "assistant_text", text: "The exact value is secret-only-sentinel." },
      { kind: "assistant_text", text: "独立审查确认值为 secret-only-sentinel。" },
    ]);

    const response = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "让审查员读取私密工作区。",
    });
    assert.equal(response.status, "completed");
    assert.match(response.reply, /secret-only-sentinel/u);
    const childAfterRead = JSON.stringify(runtime.model.requests[2].messages);
    assert.match(childAfterRead, /secret-only-sentinel/u);
    assert.doesNotMatch(childAfterRead, /normal-only-sentinel/u);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent delegation is disabled by default and never enters group actor tools", async () => {
  const runtime = createTestRuntime({ seed: "subagent-boundary" });
  try {
    const first = runtime.kernel.createCharacter({ name: "甲", soulMarkdown: "# 甲" });
    const second = runtime.kernel.createCharacter({ name: "乙", soulMarkdown: "# 乙" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "普通私聊回复。" }]);
    await runtime.kernel.sendMessage("subagent-disabled", {
      mode: "sms",
      characterId: first.id,
      text: "正常聊天",
    });
    assert.equal(runtime.model.requests[0].toolNames.includes("delegate_task"), false);
    assert.match(runtime.model.requests[0].systemPrompt, /Subagent delegation is disabled/);

    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
    ]);
    const group = runtime.kernel.createGroupChat({
      title: "边界测试群",
      mode: "sms",
      characterIds: [first.id, second.id],
      maxSpeakers: 2,
    });
    await runtime.kernel.sendGroupMessage(group.id, "大家先不用回复", "Asia/Shanghai");
    assert.ok(runtime.model.requests.slice(1).every((request) => request.toolNames.length === 0));
  } finally {
    runtime.dispose();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for subagent test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
