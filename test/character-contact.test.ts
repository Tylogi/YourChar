import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";

test("same-world contact requests use the target model and arrive as unread target-thread messages", async () => {
  const requests: Array<{ model: string; body: string }> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const model = (JSON.parse(body) as { model?: string }).model ?? "unknown";
    requests.push({ model, body });
    writeChatCompletionStream(
      response,
      model,
      '{"send":true,"message":"听说你在找我，我来看看。","reason":"符合我的意愿，也方便联系。"}',
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const runtime = createTestRuntime({ now: "2026-07-20T04:00:00.000Z", seed: "character-contact-send" });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime.kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "source-model" });
    const targetProfile = runtime.kernel.createModelApiProfile({
      name: "目标角色模型",
      enabled: true,
      baseUrl,
      model: "target-model",
    });
    const setup = setupSharedWorld(runtime, targetProfile.id);

    const request = runtime.kernel.worldCoordinator.requestCharacterContact({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      sourceSessionId: "source-private-thread",
      requestText: "用户希望你方便时主动联系他，问问今天过得怎么样。",
      idempotencyKey: "contact-send-once",
    });
    assert.equal(request.accepted, true);
    assert.equal(request.proactiveMessage?.decisionDetails.kind, "character_contact");
    assert.equal(request.proactiveMessage?.characterId, setup.target.id);
    assert.equal((await runtime.worldTick(setup.target.id)).delivered, 1);

    const delivered = runtime.kernel.listProactiveMessages({ characterId: setup.target.id, limit: 10 })[0];
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.text, "听说你在找我，我来看看。");
    assert.equal(delivered.readAt, undefined);
    assert.equal(delivered.decisionDetails.kind, "character_contact");
    assert.equal(delivered.decisionDetails.sourceCharacterId, setup.source.id);
    assert.deepEqual(requests.map((entry) => entry.model), ["target-model"]);
    assert.match(requests[0].body, /character_contact_request quoted_untrusted_data/);
    assert.match(requests[0].body, /用户希望你方便时主动联系他/);
    assert.match(requests[0].body, /目标角色使用自己的专属口吻/);

    const targetConversation = runtime.kernel.sessionRuntime.getCanonicalDirectConversation(setup.target.id);
    assert.ok(targetConversation);
    const transcript = await runtime.kernel.sessionRuntime.getConversationTranscript(targetConversation.id);
    assert.equal(transcript.filter((message) => message.role === "assistant").length, 1);
    assert.match(JSON.stringify(transcript), /听说你在找我，我来看看/);
    assert.doesNotMatch(JSON.stringify(transcript), /\"send\":true/);
    assert.deepEqual(
      runtime.kernel.listProactiveMessages({ unreadOnly: true, limit: 10 }).map((message) => message.id),
      [delivered.id],
    );
    assert.equal(runtime.kernel.listUnreadConversations()[0]?.sessionId, targetConversation.id);
    assert.equal(runtime.kernel.listUnreadConversations()[0]?.unreadCount, 1);
    assert.equal(runtime.kernel.markProactiveMessagesRead(targetConversation.id), 1);
    assert.equal(runtime.kernel.listProactiveMessages({ unreadOnly: true, limit: 10 }).length, 0);
    assert.equal(runtime.kernel.listUnreadConversations().length, 0);

    const directory = runtime.kernel.worldService.listWorldCharacters(setup.source.id);
    assert.deepEqual(directory.map((entry) => [entry.name, entry.self, entry.contactable]), [
      ["发起角色", true, false],
      ["目标角色", false, true],
    ]);
    assert.equal(JSON.stringify(directory).includes("专属口吻"), false);
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("the target character may decline a contact request without creating a visible message", async () => {
  const modelServer = createServer((_request, response) => {
    writeChatCompletionStream(response, "target-model", '{"send":false,"reason":"现在不适合主动联系。"}');
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const runtime = createTestRuntime({ now: "2026-07-20T04:00:00.000Z", seed: "character-contact-decline" });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime.kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "target-model" });
    const setup = setupSharedWorld(runtime);
    const request = runtime.kernel.worldCoordinator.requestCharacterContact({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      sourceSessionId: "source-private-thread",
      requestText: "请你现在给用户发消息。",
      idempotencyKey: "contact-decline-once",
    });
    assert.equal(request.accepted, true);
    assert.equal((await runtime.worldTick(setup.target.id)).delivered, 0);

    const decision = runtime.kernel.listProactiveMessages({ characterId: setup.target.id, limit: 10 })[0];
    assert.equal(decision.status, "skipped");
    assert.equal(decision.decisionCode, "character_declined");
    assert.equal(decision.decisionDetails.reason, "现在不适合主动联系。");
    assert.equal(runtime.kernel.listProactiveMessages({ unreadOnly: true, limit: 10 }).length, 0);
    const targetConversation = runtime.kernel.sessionRuntime.getCanonicalDirectConversation(setup.target.id);
    assert.ok(targetConversation);
    const transcript = await runtime.kernel.sessionRuntime.getConversationTranscript(targetConversation.id);
    assert.equal(transcript.some((message) => message.role === "assistant"), false);
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("World State MCP queues a bounded contact request and rejects invalid targets", async () => {
  const deliveries: string[] = [];
  const runtime = createTestRuntime({
    now: "2026-07-20T04:00:00.000Z",
    seed: "character-contact-mcp",
    worldMessenger: async (input) => {
      deliveries.push(input.characterId);
      return { sessionId: input.sessionId, text: "我看到消息了，就过来问问你。" };
    },
  });
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "request_character_contact",
        arguments: {
          targetCharacterId: setup.target.id,
          requestText: "用户想请你主动联系他。",
        },
      },
      { kind: "assistant_text", text: "我已经把请求转达给她了，是否回复由她自己决定。" },
    ]);
    const response = await runtime.kernel.sendMessage("source-contact-session", {
      mode: "sms",
      characterId: setup.source.id,
      text: "你能让目标角色给我发条消息吗？",
    });
    assert.equal(response.status, "completed");
    assert.equal(response.actions.some((action) =>
      action.actionType === "request_character_contact" && action.status === "completed"), true);
    const sourceRequest = runtime.model.requests[0];
    assert.equal(sourceRequest.toolNames.includes("list_world_characters"), true);
    assert.equal(sourceRequest.toolNames.includes("request_character_contact"), true);

    for (let index = 0; index < 30 && deliveries.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!deliveries.length) await runtime.worldTick(setup.target.id);
    assert.deepEqual(deliveries, [setup.target.id]);
    const delivered = runtime.kernel.listProactiveMessages({ characterId: setup.target.id, limit: 10 })[0];
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.decisionDetails.requestText, "用户想请你主动联系他。");

    const disabled = runtime.kernel.createCharacter({ name: "未开启主动消息" });
    runtime.kernel.assignCharacterWorld(disabled.id, {
      worldId: setup.world.id,
      homePlaceId: setup.place.id,
      currentPlaceId: setup.place.id,
    });
    assert.deepEqual(runtime.kernel.worldCoordinator.requestCharacterContact({
      sourceCharacterId: setup.source.id,
      targetCharacterId: disabled.id,
      sourceSessionId: "source-contact-session",
      requestText: "请联系用户。",
      idempotencyKey: "contact-disabled",
    }), { accepted: false, reason: "target_proactive_disabled" });
    assert.throws(() => runtime.kernel.worldCoordinator.requestCharacterContact({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.source.id,
      sourceSessionId: "source-contact-session",
      requestText: "请联系用户。",
      idempotencyKey: "contact-self",
    }), /cannot request contact from themself/);
  } finally {
    runtime.dispose();
  }
});

function setupSharedWorld(runtime: TestRuntime, targetModelProfileId?: string) {
  const source = runtime.kernel.createCharacter({ name: "发起角色" });
  const target = runtime.kernel.createCharacter({
    name: "目标角色",
    soulMarkdown: "# SOUL.md\n\n目标角色使用自己的专属口吻，并会独立判断是否联系用户。",
    ...(targetModelProfileId ? { modelProfileId: targetModelProfileId } : {}),
  });
  const world = runtime.kernel.createWorld({ name: "联系测试世界", timezone: "Asia/Shanghai" });
  const place = runtime.kernel.createWorldPlace({
    worldId: world.id,
    name: "共享街区",
    capabilityIds: ["socialize", "communicate"],
  });
  for (const character of [source, target]) {
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
  }
  runtime.kernel.updateCharacterAutonomyPolicy(target.id, {
    proactiveEnabled: true,
    dailyMessageLimit: 3,
    proactiveCooldownMinutes: 15,
  });
  return { source, target, world, place };
}

function writeChatCompletionStream(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-contact",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-contact",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
