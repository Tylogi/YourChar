import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("TestRuntime serializes concurrent turns and returns a canonical snapshot", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-11T09:00:00.000Z",
    seed: "concurrent",
  });
  try {
    runtime.model.enqueue([
      { kind: "assistant_text", text: "first reply" },
      { kind: "assistant_text", text: "second reply" },
    ]);

    const [first, second] = await Promise.all([
      runtime.kernel.sendMessage("queue", { mode: "sms", text: "first" }),
      runtime.kernel.sendMessage("queue", { mode: "sms", text: "second" }),
    ]);

    assert.equal(first.reply, "first reply");
    assert.equal(second.reply, "second reply");
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.sessions[0].messages.length, 6);
    assert.equal(snapshot.modelRequests.length, 2);
    assert.equal(snapshot.modelRequests[1].messages.filter(isUserPrompt).length, 2);
    assert.equal(JSON.stringify(snapshot).includes("timestamp"), false);
    assert.doesNotMatch(snapshot.modelRequests[0].systemPrompt, /Current time:/);
    assert.match(JSON.stringify(snapshot.modelRequests[0].messages), /2026-07-11 17:00 Asia\/Shanghai/);
  } finally {
    runtime.dispose();
  }
});

test("realm-bound memory proposals execute through the original Pi AgentSession", async () => {
  const runtime = createTestRuntime({ seed: "tool" });
  try {
    const character = runtime.kernel.createCharacter({
      name: "林澈",
      soulMarkdown: "# SOUL.md - 林澈\n\n## 核心身份\n\n用户信任的同行者。\n",
    });
    runtime.kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "propose_memory",
        arguments: {
          type: "relationship_event",
          key: "relationship.jazz_club",
          content: "用户与角色曾在爵士酒吧见面",
          tags: ["relationship"],
        },
      },
      { kind: "assistant_text", text: "我记住了。" },
    ]);

    const response = await runtime.kernel.sendMessage("tool-session", {
      mode: "rp",
      characterId: character.id,
      text: "把这段角色经历列为候选",
    });

    assert.equal(response.reply, "我记住了。");
    assert.equal(response.actions[0].actionType, "propose_memory");
    assert.equal(runtime.kernel.rpService.listAllMemories()[0].characterId, character.id);
    assert.equal(runtime.kernel.rpService.listAllMemories()[0].realm, "roleplay");
    assert.equal(runtime.kernel.rpService.listAllMemories()[0].scope, "character");
    assert.equal(runtime.kernel.rpService.listAllMemories()[0].validity, "pending");
    assert.equal(runtime.kernel.rpService.listAllMemories()[0].confirmed, false);
    assert.equal(runtime.model.requests[0].toolNames.includes("propose_memory"), true);
    assert.ok(response.events.some((event) => event.type === "tool_execution_end"));
  } finally {
    runtime.dispose();
  }
});

test("roleplay propose_memory rejects reality-only types even if a provider bypasses its schema", async () => {
  const runtime = createTestRuntime({ seed: "tool-profile-type-rejection" });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈" });
    runtime.kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "propose_memory",
        arguments: {
          type: "user_fact",
          content: "用户来自杭州",
        },
      },
      { kind: "assistant_text", text: "这类现实信息只能进入用户画像。" },
    ]);

    const response = await runtime.kernel.sendMessage("tool-profile-type-rejection", {
      mode: "rp",
      characterId: character.id,
      text: "记住我来自杭州",
    });

    assert.equal(response.reply, "这类现实信息只能进入用户画像。");
    assert.equal(runtime.kernel.rpService.listAllMemories().length, 0);
    assert.equal(response.actions.some((action) => action.actionType === "propose_memory"), false);
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /invalid|option|user_fact/i);
  } finally {
    runtime.dispose();
  }
});

test("agent resolves reminder intent through the schedule MCP tool", async () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "pi-schedule" });
  try {
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "五分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "提醒已经创建。" },
    ]);

    const response = await runtime.kernel.sendMessage("pi-schedule", {
      mode: "sms",
      text: "五分钟后提醒我喝水",
    });
    assert.equal(response.actions[0].actionType, "create_schedule_item");
    assert.equal(response.actions[0].payload.transport, "mcp");
    assert.equal(runtime.kernel.listScheduleItems()[0].title, "喝水");
    assert.equal(runtime.kernel.listScheduleItems()[0].startAt, "2026-07-11T09:05:00.000Z");
    assert.equal(runtime.kernel.listScheduleItems()[0].sourceSessionId, "pi-schedule");
    assert.match(JSON.stringify(runtime.model.requests[0].messages), /五分钟后提醒我喝水/);
    assert.ok(runtime.model.requests[0].toolNames.includes("snooze_reminder"));
  } finally {
    runtime.dispose();
  }
});

test("due reminder resumes its Pi context and sends an agent-authored message", async () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "proactive" });
  try {
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "一分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "好，一分钟后提醒你。" },
      { kind: "assistant_text", text: "到时间了，先喝几口水吧。" },
    ]);

    await runtime.kernel.sendMessage("proactive-session", {
      mode: "sms",
      text: "一分钟后提醒我喝水",
    });
    runtime.clock.advance(60_000);

    assert.deepEqual(await runtime.schedulerTick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(runtime.notifications[0].body, "到时间了，先喝几口水吧。");
    assert.equal(runtime.notifications[0].agentGenerated, true);
    assert.equal(runtime.notifications[0].sourceSessionId, "proactive-session");
    assert.equal(runtime.kernel.listNotificationHistory()[0].deliveryBody, "到时间了，先喝几口水吧。");
    assert.equal(runtime.kernel.listNotificationHistory()[0].agentGenerated, true);
    assert.match(runtime.model.requests[2].systemPrompt, /reminder_due system event/);
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /好，一分钟后提醒你/);

    const session = await runtime.kernel.getSession("proactive-session");
    const assistantTexts = session.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((content) => content.type === "text")
      .map((content) => content.text);
    assert.deepEqual(assistantTexts, ["好，一分钟后提醒你。", "到时间了，先喝几口水吧。"]);
    assert.deepEqual(await runtime.schedulerTick(), { claimed: 0, delivered: 0, failed: 0 });
  } finally {
    runtime.dispose();
  }
});

function isRole(value: unknown, role: string): boolean {
  return Boolean(value && typeof value === "object" && "role" in value && value.role === role);
}

function isUserPrompt(value: unknown): boolean {
  return isRole(value, "user") && !JSON.stringify(value).includes("[RP_AGENT_");
}
