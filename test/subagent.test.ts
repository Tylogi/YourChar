import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

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
      ["list_workspace", "read"],
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
  } finally {
    runtime.dispose();
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
