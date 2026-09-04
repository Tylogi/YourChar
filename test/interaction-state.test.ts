import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { hasExplicitArrivalEvidence } from "../src/interaction/index.js";
import { interactionStateMcpModuleId } from "../src/modules/catalog.js";
import { createTestRuntime } from "../src/testing/index.js";

test("arrival evidence rejects prospective and unbound generic statements in Chinese and English", () => {
  assert.equal(hasExplicitArrivalEvidence("我还没到，马上过去。", "车站", true), false);
  assert.equal(hasExplicitArrivalEvidence("我到了。", "车站", true), true);
  assert.equal(hasExplicitArrivalEvidence("I'm here.", "Central Station", false), false);
  assert.equal(hasExplicitArrivalEvidence("I'm at Central Station.", "Central Station", false), true);
  assert.equal(hasExplicitArrivalEvidence("I've arrived.", "Central Station", true), true);
});

test("SMS receives bounded canonical interaction context and meeting tools while RP remains sandboxed", async () => {
  const runtime = createTestRuntime({ seed: "interaction-context" });
  try {
    const character = runtime.kernel.createCharacter({ name: "会面角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "我在这里。" },
      { kind: "assistant_text", text: "她抬起眼，安静地看向门边。" },
    ]);

    await runtime.kernel.sendMessage("interaction-sms", {
      mode: "sms",
      characterId: character.id,
      text: "你在做什么？",
    });
    const sms = runtime.model.requests[0];
    assert.deepEqual(
      ["propose_meeting", "begin_meeting", "end_meeting"].every((name) => sms.toolNames.includes(name)),
      true,
    );
    const smsMessages = JSON.stringify(sms.messages);
    assert.match(smsMessages, /continuity=\\"canonical\\"/);
    assert.match(smsMessages, /presence=\\"remote\\"/);
    assert.match(smsMessages, /first-person direct messages/);

    await runtime.kernel.sendMessage("interaction-rp", {
      mode: "rp",
      characterId: character.id,
      text: "继续场景。",
    });
    const rp = runtime.model.requests[1];
    assert.equal(rp.toolNames.some((name) => ["propose_meeting", "begin_meeting", "end_meeting"].includes(name)), false);
    const rpMessages = JSON.stringify(rp.messages);
    assert.match(rpMessages, /continuity=\\"sandbox\\"/);
    assert.match(rpMessages, /presence=\\"co_present\\"/);
    assert.match(rpMessages, /close third-person narration/);
  } finally {
    runtime.dispose();
  }
});

test("agent tools move a private chat from a plan to confirmed co-presence and back after farewell", async () => {
  const runtime = createTestRuntime({ seed: "interaction-tool-flow" });
  try {
    const character = runtime.kernel.createCharacter({ name: "见面角色" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "propose_meeting", arguments: { location: "未来道具研究所" } },
      { kind: "assistant_text", text: "那就在研究所见。" },
      { kind: "tool_call", name: "begin_meeting", arguments: {} },
      { kind: "assistant_text", text: "她从工作台旁抬起头，朝门口看过来。\n\n“你来了。”" },
      { kind: "tool_call", name: "end_meeting", arguments: { initiator: "user", summary: "用户告别离开研究所" } },
      { kind: "assistant_text", text: "她停在门边，轻轻挥了挥手。\n\n“路上小心。”" },
    ]);

    const proposed = await runtime.kernel.sendMessage("interaction-flow", {
      mode: "sms",
      characterId: character.id,
      text: "我们一会儿在未来道具研究所见吧。",
    });
    assert.equal(proposed.status, "completed");
    assert.equal(proposed.actions.some((action) => action.actionType === "propose_meeting"), true);
    assert.equal(runtime.kernel.getConversationInteraction("interaction-flow").state.presence, "meeting_pending");

    const begun = await runtime.kernel.sendMessage("interaction-flow", {
      mode: "sms",
      characterId: character.id,
      text: "我到了。",
    });
    assert.equal(begun.status, "completed");
    assert.equal(begun.actions.some((action) => action.actionType === "begin_meeting"), true);
    const together = runtime.kernel.getConversationInteraction("interaction-flow");
    assert.equal(together.state.presence, "co_present");
    assert.equal(together.state.lens, "observable_scene");
    assert.equal(together.state.location, "未来道具研究所");

    const ended = await runtime.kernel.sendMessage("interaction-flow", {
      mode: "sms",
      characterId: character.id,
      text: "时间不早了，今天就到这里吧。",
    });
    assert.equal(ended.status, "completed");
    assert.equal(ended.actions.some((action) => action.actionType === "end_meeting"), true);
    const remote = runtime.kernel.getConversationInteraction("interaction-flow");
    assert.equal(remote.state.presence, "remote");
    assert.equal(remote.state.pendingEventId, undefined);
    assert.equal(remote.events.at(-1)?.type, "end_meeting");
    assert.equal(remote.events.at(-1)?.status, "applied");
  } finally {
    runtime.dispose();
  }
});

test("immediate semantic co-presence begins directly from remote without a probe or plan call", async () => {
  const runtime = createTestRuntime({ seed: "interaction-direct-begin" });
  try {
    const character = runtime.kernel.createCharacter({ name: "到门角色" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "begin_meeting", arguments: { location: "我家" } },
      { kind: "assistant_text", text: "门打开后，她抬眼看过来。\n\n“终于开门了。”" },
    ]);

    const response = await runtime.kernel.sendMessage("interaction-direct-begin", {
      mode: "sms",
      characterId: character.id,
      text: "开门咯",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.actions.filter((action) => action.actionType === "begin_meeting").length, 1);
    assert.equal(response.actions.some((action) => action.actionType === "propose_meeting"), false);
    const interaction = runtime.kernel.getConversationInteraction("interaction-direct-begin");
    assert.equal(interaction.state.presence, "co_present");
    assert.deepEqual(interaction.events.map((event) => event.type), ["begin_meeting"]);
    assert.equal(interaction.events[0]?.fromPresence, "remote");
  } finally {
    runtime.dispose();
  }
});

test("begin_meeting rejects prospective arrival and keeps the planned meeting remote", async () => {
  const runtime = createTestRuntime({ seed: "interaction-evidence" });
  try {
    const character = runtime.kernel.createCharacter({ name: "证据角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "好，到时见。" }]);
    await runtime.kernel.sendMessage("interaction-evidence", {
      mode: "sms",
      characterId: character.id,
      text: "晚点聊。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-evidence", {
      action: "propose",
      location: "车站北口",
    });

    runtime.model.enqueue([
      { kind: "tool_call", name: "begin_meeting", arguments: {} },
      { kind: "assistant_text", text: "不急，你到了再告诉我。" },
    ]);
    const response = await runtime.kernel.sendMessage("interaction-evidence", {
      mode: "sms",
      characterId: character.id,
      text: "我还没到，马上过去。",
    });
    assert.equal(response.status, "completed");
    assert.equal(response.actions.some((action) => action.actionType === "begin_meeting"), false);
    assert.equal(runtime.kernel.getConversationInteraction("interaction-evidence").state.presence, "meeting_pending");

    runtime.model.enqueue([{ kind: "assistant_text", text: "好，我继续等你。" }]);
    await runtime.kernel.sendMessage("interaction-evidence", {
      mode: "sms",
      characterId: character.id,
      text: "知道了。",
    });
    const nextTurnContext = JSON.stringify(runtime.model.requests.at(-1)?.messages ?? []);
    assert.doesNotMatch(nextTurnContext, /explicitly contradicts immediate co-presence/);
  } finally {
    runtime.dispose();
  }
});

test("a failed farewell turn cancels its pending end transition", async () => {
  const runtime = createTestRuntime({ seed: "interaction-failed-end" });
  try {
    const character = runtime.kernel.createCharacter({ name: "告别角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我在。" }]);
    await runtime.kernel.sendMessage("interaction-failed-end", {
      mode: "sms",
      characterId: character.id,
      text: "你好。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-failed-end", {
      action: "propose",
      location: "河岸",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-failed-end", {
      action: "begin",
      userConfirmed: true,
    });

    runtime.model.enqueue([
      { kind: "tool_call", name: "end_meeting", arguments: { initiator: "user" } },
      { kind: "provider_error", message: "temporary failure" },
    ]);
    const response = await runtime.kernel.sendMessage("interaction-failed-end", {
      mode: "sms",
      characterId: character.id,
      text: "我先走了，再见。",
    });
    assert.equal(response.status, "failed");
    const interaction = runtime.kernel.getConversationInteraction("interaction-failed-end");
    assert.equal(interaction.state.presence, "co_present");
    assert.equal(interaction.state.pendingEventId, undefined);
    assert.equal(interaction.events.at(-1)?.status, "cancelled");
  } finally {
    runtime.dispose();
  }
});

test("departure is model-decided and omission does not trigger a hidden text fallback", async () => {
  const runtime = createTestRuntime({ seed: "interaction-departure-no-fallback" });
  try {
    const character = runtime.kernel.createCharacter({ name: "离场角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我在。" }]);
    await runtime.kernel.sendMessage("interaction-departure-no-fallback", {
      mode: "sms",
      characterId: character.id,
      text: "你好。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-departure-no-fallback", {
      action: "propose",
      location: "酒店",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-departure-no-fallback", {
      action: "begin",
      userConfirmed: true,
    });

    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "她在门边停下，轻声说：\"快点回来。\"",
    }]);
    const response = await runtime.kernel.sendMessage("interaction-departure-no-fallback", {
      mode: "sms",
      characterId: character.id,
      text: "我出去了",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.actions.some((action) => action.actionType === "end_meeting"), false);
    const interaction = runtime.kernel.getConversationInteraction("interaction-departure-no-fallback");
    assert.equal(interaction.state.presence, "co_present");
    assert.equal(interaction.events.at(-1)?.type, "begin_meeting");
  } finally {
    runtime.dispose();
  }
});

test("co-present SMS keeps explicit user reminders on the user calendar", async () => {
  const runtime = createTestRuntime({ seed: "interaction-user-reminder" });
  try {
    const character = runtime.kernel.createCharacter({ name: "日程角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我在。" }]);
    await runtime.kernel.sendMessage("interaction-user-reminder", {
      mode: "sms",
      characterId: character.id,
      text: "你好。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-user-reminder", {
      action: "propose",
      location: "我家",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-user-reminder", {
      action: "begin",
      userConfirmed: true,
    });

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          calendar: "character",
          kind: "reminder",
          title: "喝水",
          timeExpression: "五分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "她点点头：\"好，五分钟后提醒你。\"" },
    ]);
    const response = await runtime.kernel.sendMessage("interaction-user-reminder", {
      mode: "sms",
      characterId: character.id,
      text: "五分钟后提醒我喝水。",
    });

    assert.equal(response.status, "completed");
    assert.equal(runtime.kernel.listScheduleItems({ ownerType: "user" }).length, 1);
    assert.equal(runtime.kernel.listScheduleItems({ ownerType: "character", characterId: character.id }).length, 0);
    const action = response.actions.find((entry) => entry.actionType === "create_schedule_item");
    assert.equal(action?.payload.ownerType, "user");
    assert.equal(action?.payload.calendarCorrectedFromCharacter, true);
    const request = runtime.model.requests.at(-2);
    assert.match(JSON.stringify(request?.providerPayload.tools), /kind=reminder always belongs to calendar=user/);
    assert.match(JSON.stringify(request?.messages), /Co-presence changes only the narrative lens/);
  } finally {
    runtime.dispose();
  }
});

test("interaction HTTP controls require explicit confirmation and expose transition history", async () => {
  const runtime = createTestRuntime({ seed: "interaction-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const character = runtime.kernel.createCharacter({ name: "控制面角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "好。" }]);
    await runtime.kernel.sendMessage("interaction-http", {
      mode: "sms",
      characterId: character.id,
      text: "聊聊吧。",
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/sessions/interaction-http/interaction`;
    const post = (body: Record<string, unknown>) => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal((await post({ action: "propose", location: "咖啡店" })).status, 200);
    const unconfirmed = await post({ action: "begin" });
    assert.equal(unconfirmed.status, 422);
    assert.equal((await unconfirmed.json() as { code: string }).code, "INTERACTION_EVIDENCE_REQUIRED");
    assert.equal((await post({ action: "begin", userConfirmed: true })).status, 200);

    const body = await (await fetch(endpoint)).json() as {
      state: { presence: string };
      events: Array<{ type: string; status: string }>;
      canUndo: boolean;
    };
    assert.equal(body.state.presence, "co_present");
    assert.deepEqual(body.events.map((event) => event.type), ["propose_meeting", "begin_meeting"]);
    assert.equal(body.canUndo, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

test("normal meetings move into the character's World scene with co-located characters", async () => {
  const runtime = createTestRuntime({ seed: "interaction-world-scene" });
  try {
    const primary = runtime.kernel.createCharacter({ name: "见面主角" });
    const nearby = runtime.kernel.createCharacter({ name: "同地点角色" });
    const elsewhere = runtime.kernel.createCharacter({ name: "异地角色" });
    const world = runtime.kernel.createWorld({ name: "见面世界" });
    const cafe = runtime.kernel.createWorldPlace({ worldId: world.id, name: "咖啡店" });
    const station = runtime.kernel.createWorldPlace({ worldId: world.id, name: "车站" });
    runtime.kernel.assignCharacterWorld(primary.id, {
      worldId: world.id,
      currentPlaceId: station.id,
    });
    runtime.kernel.assignCharacterWorld(nearby.id, {
      worldId: world.id,
      currentPlaceId: cafe.id,
    });
    runtime.kernel.assignCharacterWorld(elsewhere.id, {
      worldId: world.id,
      currentPlaceId: station.id,
    });
    const conversation = await runtime.kernel.openCanonicalPrivateConversation(primary.id);

    await runtime.kernel.transitionConversationInteraction(conversation.id, {
      action: "propose",
      placeId: cafe.id,
    });
    const begun = await runtime.kernel.transitionConversationInteraction(conversation.id, {
      action: "begin",
      userConfirmed: true,
    });

    assert.equal(begun.state.presence, "co_present");
    assert.equal(begun.meetingScene?.worldId, world.id);
    assert.equal(begun.meetingScene?.sessionId, conversation.id);
    assert.deepEqual(
      new Set(begun.meetingScene?.participantIds),
      new Set([primary.id, nearby.id]),
    );
    const activeEvent = runtime.kernel.getWorldConversation(world.id).activeEvent;
    assert.equal(activeEvent?.meetingSessionId, conversation.id);
    assert.equal(activeEvent?.placeId, cafe.id);
    assert.equal(runtime.kernel.listWorldConversations()[0]?.meetingScene?.location, "咖啡店");

    runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "resolve",
      source: "user_control",
      summary: "咖啡店的见面已经结束。",
      participantIds: activeEvent?.participantIds,
    });
    assert.equal(
      runtime.kernel.getConversationInteraction(conversation.id).state.presence,
      "remote",
    );
    assert.equal(runtime.kernel.getWorldConversation(world.id).meetingScene, undefined);
  } finally {
    runtime.dispose();
  }
});

test("world autonomy retains proactive work while the character is co-present and delivers it after separation", async () => {
  let deliveries = 0;
  const runtime = createTestRuntime({
    seed: "interaction-proactive",
    worldMessenger: async (input) => {
      deliveries += 1;
      return { sessionId: input.sessionId, text: "刚才还有件事想告诉你。" };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "主动角色" });
    const world = runtime.kernel.createWorld({ name: "连续世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "书店",
      capabilityIds: ["observe", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.updateCharacterAutonomyPolicy(character.id, {
      enabled: false,
      proactiveEnabled: true,
      dailyMessageLimit: 3,
    });
    runtime.kernel.updateCharacterRuntime(character.id, {
      activity: "整理书架",
      availability: "busy",
      expectedUntil: "2026-01-01T02:00:00.000Z",
    });
    runtime.model.enqueue([{ kind: "assistant_text", text: "一会儿见。" }]);
    await runtime.kernel.sendMessage("interaction-proactive", {
      mode: "sms",
      characterId: character.id,
      text: "待会见。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-proactive", {
      action: "propose",
      placeId: place.id,
    });
    await runtime.kernel.transitionConversationInteraction("interaction-proactive", {
      action: "begin",
      userConfirmed: true,
    });
    assert.equal(runtime.kernel.getCharacterLife(character.id).runtime?.activity, "与用户见面");

    const together = await runtime.kernel.simulateCharacterMoment(character.id);
    assert.equal(together.proactiveMessage?.status, "pending");
    assert.equal(deliveries, 0);

    await runtime.kernel.transitionConversationInteraction("interaction-proactive", {
      action: "end",
      userConfirmed: true,
    });
    const restored = runtime.kernel.getCharacterLife(character.id).runtime;
    assert.equal(restored?.activity, "整理书架");
    assert.equal(restored?.availability, "busy");
    assert.equal(restored?.expectedUntil, "2026-01-01T02:00:00.000Z");
    runtime.clock.advance(1_000);
    await runtime.kernel.simulateCharacterMoment(character.id);
    assert.equal(deliveries, 1);
    assert.equal(runtime.kernel.listProactiveMessages({ characterId: character.id, status: "delivered" }).length, 1);
  } finally {
    runtime.dispose();
  }
});

test("interaction state, transition history, and export survive a process restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-interaction-restart-"));
  let characterId = "";
  const first = createTestRuntime({ stateDir, seed: "interaction-restart-first" });
  try {
    const character = first.kernel.createCharacter({ name: "持久角色" });
    characterId = character.id;
    first.model.enqueue([{ kind: "assistant_text", text: "一会儿见。" }]);
    await first.kernel.sendMessage("interaction-restart", {
      mode: "sms",
      characterId,
      text: "稍后见。",
    });
    await first.kernel.transitionConversationInteraction("interaction-restart", {
      action: "propose",
      location: "图书馆门口",
    });
  } finally {
    first.dispose();
  }

  const second = createTestRuntime({ stateDir, seed: "interaction-restart-second" });
  try {
    const restored = second.kernel.getConversationInteraction("interaction-restart");
    assert.equal(restored.state.characterId, characterId);
    assert.equal(restored.state.presence, "meeting_pending");
    assert.equal(restored.state.location, "图书馆门口");
    assert.equal(restored.events.length, 1);
    const exported = await second.kernel.exportUserData();
    assert.equal(exported.interactionStates.some((state) => state.sessionId === "interaction-restart"), true);
    assert.equal(exported.interactionEvents.some((event) => event.type === "propose_meeting"), true);
  } finally {
    second.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("canonical transitions require a planned meeting and support deterministic multi-step undo", async () => {
  const runtime = createTestRuntime({ seed: "interaction-undo-order" });
  try {
    const character = runtime.kernel.createCharacter({ name: "撤销角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "你好。" }]);
    await runtime.kernel.sendMessage("interaction-undo", {
      mode: "sms",
      characterId: character.id,
      text: "你好。",
    });
    await assert.rejects(
      runtime.kernel.transitionConversationInteraction("interaction-undo", {
        action: "begin",
        location: "车站",
        userConfirmed: true,
      }),
      /must be planned/,
    );

    await runtime.kernel.transitionConversationInteraction("interaction-undo", {
      action: "propose",
      location: "车站",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-undo", {
      action: "begin",
      userConfirmed: true,
    });
    await runtime.kernel.transitionConversationInteraction("interaction-undo", {
      action: "end",
      userConfirmed: true,
    });
    assert.equal(runtime.kernel.getConversationInteraction("interaction-undo").state.presence, "remote");

    assert.equal((await runtime.kernel.transitionConversationInteraction("interaction-undo", { action: "undo" })).state.presence, "co_present");
    assert.equal((await runtime.kernel.transitionConversationInteraction("interaction-undo", { action: "undo" })).state.presence, "meeting_pending");
    const remote = await runtime.kernel.transitionConversationInteraction("interaction-undo", { action: "undo" });
    assert.equal(remote.state.presence, "remote");
    assert.equal(remote.canUndo, false);
    assert.equal(remote.events.filter((event) => event.type === "undo_transition").length, 3);
  } finally {
    runtime.dispose();
  }
});

test("disabling Interaction State MCP removes model tools but preserves trusted state context and UI repair", async () => {
  const runtime = createTestRuntime({ seed: "interaction-module-toggle" });
  try {
    const character = runtime.kernel.createCharacter({ name: "开关角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "先约好。" }]);
    await runtime.kernel.sendMessage("interaction-toggle", {
      mode: "sms",
      characterId: character.id,
      text: "你好。",
    });
    await runtime.kernel.transitionConversationInteraction("interaction-toggle", {
      action: "propose",
      location: "公园门口",
    });
    runtime.kernel.setAgentModuleEnabled(interactionStateMcpModuleId, false);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我会等你。" }]);
    await runtime.kernel.sendMessage("interaction-toggle", {
      mode: "sms",
      characterId: character.id,
      text: "我还在路上。",
    });
    const request = runtime.model.requests.at(-1)!;
    assert.equal(request.toolNames.some((name) => ["propose_meeting", "begin_meeting", "end_meeting"].includes(name)), false);
    assert.match(JSON.stringify(request.messages), /presence=\\"meeting_pending\\"/);

    const cancelled = await runtime.kernel.transitionConversationInteraction("interaction-toggle", { action: "cancel" });
    assert.equal(cancelled.state.presence, "remote");
  } finally {
    runtime.dispose();
  }
});
