import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import type { CharacterInteractionActorInput } from "../src/world/index.js";

test("character channels persist exchanges, unread state, relationships, and scoped memories", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-character-channel-"));
  const actorInputs: CharacterInteractionActorInput[] = [];
  const actor = async (input: CharacterInteractionActorInput) => {
    actorInputs.push(input);
    return `${input.peerName}，我收到了。`;
  };
  const first = createTestRuntime({
    stateDir,
    seed: "character-channel-persist",
    characterInteractionActor: actor,
  });
  let channelId = "";
  try {
    const setup = setupSharedWorld(first);
    const result = await first.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "真由理，实验记录整理得怎么样了？",
      idempotencyKey: "direct-message-once",
      source: "manual",
    });
    channelId = result.channel.id;
    assert.equal(result.episode.status, "completed");
    assert.equal(result.responseText, "发起角色，我收到了。");
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages.map((message) => message.senderCharacterId), [
      setup.source.id,
      setup.target.id,
    ]);
    assert.equal(actorInputs.length, 1);
    assert.equal(actorInputs[0].actorCharacterId, setup.target.id);
    assert.equal(actorInputs[0].peerCharacterId, setup.source.id);

    const summary = first.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    assert.equal(summary.id, channelId);
    assert.equal(summary.unreadCount, 2);
    assert.equal(summary.preview, "发起角色，我收到了。");
    assert.deepEqual(summary.characterNames, ["发起角色", "目标角色"]);
    assert.equal(first.kernel.markCharacterChannelRead(channelId).unreadCount, 0);

    const sourceRelationship = first.kernel.worldConversationService.repository.getCharacterRelationship(
      setup.world.id,
      setup.source.id,
      setup.target.id,
    );
    assert.equal(sourceRelationship?.affinity, 51);
    assert.equal(sourceRelationship?.trust, 41);
    assert.equal(sourceRelationship?.intimacy, 16);
    assert.equal(first.kernel.worldConversationService.repository.listObservations(
      setup.source.id,
      setup.world.id,
      10,
    ).length, 1);
    assert.equal(first.kernel.searchRpMemories({
      characterId: setup.target.id,
      type: "relationship_event",
      confirmedOnly: true,
    }).some((memory) => memory.key === `character-channel:${result.episode.id}`), true);
  } finally {
    first.dispose();
  }

  const second = createTestRuntime({
    stateDir,
    seed: "character-channel-restart",
    characterInteractionActor: actor,
  });
  try {
    const snapshot = second.kernel.getCharacterChannel(channelId);
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.episodes[0].status, "completed");
    assert.equal(snapshot.channel.unreadCount, 0);
  } finally {
    second.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("World MCP delegates to another character and returns the result to the parent character", async () => {
  const actorInputs: CharacterInteractionActorInput[] = [];
  const runtime = createTestRuntime({
    seed: "character-collaboration-mcp",
    characterInteractionActor: async (input) => {
      actorInputs.push(input);
      return "我核对过思路了：先按时间排序，再检查缺失项。";
    },
  });
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "request_character_help",
        arguments: {
          targetCharacterId: setup.target.id,
          task: "给出整理实验记录的检查步骤",
          context: "只处理共享的实验记录。",
        },
      },
      {
        kind: "assistant_text",
        text: "真由理建议先按时间排序，再检查缺失项，我就按这个顺序处理。",
      },
    ]);
    const response = await runtime.kernel.sendMessage("source-collaboration-session", {
      mode: "sms",
      characterId: setup.source.id,
      text: "你问问真由理该怎么整理实验记录。",
    });
    assert.equal(response.status, "completed");
    assert.match(response.reply, /真由理建议/);
    assert.equal(actorInputs.length, 1);
    assert.equal(actorInputs[0].purpose, "collaboration_result");
    assert.equal(actorInputs[0].actorCharacterId, setup.target.id);
    assert.match(actorInputs[0].objective ?? "", /整理实验记录/);
    assert.equal(runtime.model.requests[0].toolNames.includes("send_character_message"), true);
    assert.equal(runtime.model.requests[0].toolNames.includes("request_character_help"), true);
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /协作结果/);
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /先按时间排序/);

    const channel = runtime.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    const snapshot = runtime.kernel.getCharacterChannel(channel.id);
    assert.equal(snapshot.episodes[0].kind, "collaboration");
    assert.deepEqual(snapshot.messages.map((message) => message.kind), ["task", "result"]);
    assert.equal(response.actions.some((action) => action.actionType === "request_character_help"), true);
  } finally {
    runtime.dispose();
  }
});

test("autonomous social exchanges honor policy, cooldown, and daily limits", async () => {
  const actorInputs: CharacterInteractionActorInput[] = [];
  const runtime = createTestRuntime({
    now: "2026-07-24T02:00:00.000Z",
    seed: "character-social-policy",
    worldPlanner: async () => ({ activities: [] }),
    characterInteractionActor: async (input) => {
      actorInputs.push(input);
      return input.purpose === "social_opening"
        ? "今天实验室挺安静的，你那边怎么样？"
        : "我也刚忙完，正准备泡杯茶。";
    },
  });
  try {
    const setup = setupSharedWorld(runtime);
    for (const character of [setup.source, setup.target]) {
      runtime.kernel.updateCharacterAutonomyPolicy(character.id, {
        enabled: true,
        socialEnabled: true,
        socialDailyLimit: 1,
        socialCooldownMinutes: 240,
        quietStart: "23:00",
        quietEnd: "08:00",
      });
    }

    const first = await runtime.worldTick(setup.source.id);
    assert.equal(first.socialEpisodes, 1);
    assert.equal(actorInputs.length, 2);
    assert.deepEqual(actorInputs.map((input) => [input.purpose, input.actorCharacterId]), [
      ["social_opening", setup.source.id],
      ["social_reply", setup.target.id],
    ]);
    const channel = runtime.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    assert.equal(runtime.kernel.getCharacterChannel(channel.id).episodes[0].source, "autonomy");
    assert.ok(runtime.kernel.getCharacterLife(setup.source.id).policy.lastSocialAt);
    assert.ok(runtime.kernel.getCharacterLife(setup.target.id).policy.lastSocialAt);

    const second = await runtime.worldTick(setup.source.id);
    assert.equal(second.socialEpisodes, 0);
    assert.equal(actorInputs.length, 2);
  } finally {
    runtime.dispose();
  }
});

test("each character-channel actor uses its own model without receiving private user-thread text", async () => {
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
      model === "source-model" ? "我先问问她今天过得怎么样。" : "我挺好的，你呢？",
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const runtime = createTestRuntime({ seed: "character-channel-model-binding" });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime.kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "source-model" });
    const targetProfile = runtime.kernel.createModelApiProfile({
      name: "目标模型",
      enabled: true,
      baseUrl,
      model: "target-model",
    });
    const setup = setupSharedWorld(runtime, targetProfile.id);

    runtime.model.enqueue([{ kind: "assistant_text", text: "这件事我只在这里说。" }]);
    await runtime.kernel.sendMessage("source-private-secret", {
      mode: "sms",
      characterId: setup.source.id,
      text: "私人暗号是只属于用户会话的内容。",
    });
    await runtime.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "今天过得怎么样？",
      idempotencyKey: "model-binding-direct",
      source: "manual",
    });
    await runtime.kernel.startCharacterSocialExchange({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      idempotencyKey: "model-binding-social",
    });

    assert.deepEqual(requests.map((entry) => entry.model), [
      "target-model",
      "source-model",
      "target-model",
    ]);
    assert.match(requests[0].body, /待人温和/);
    assert.match(requests[1].body, /做事严谨/);
    for (const request of requests) {
      assert.doesNotMatch(request.body, /私人暗号/);
      assert.doesNotMatch(request.body, /这件事我只在这里说/);
    }
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("character-channel HTTP APIs expose exchanges, snapshots, read state, and social policy", async () => {
  const runtime = createTestRuntime({
    seed: "character-channel-http",
    characterInteractionActor: async () => "我收到啦。",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = setupSharedWorld(runtime);
    const exchangeResponse = await fetch(`${baseUrl}/api/v1/character-channels/exchanges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        sourceCharacterId: setup.source.id,
        targetCharacterId: setup.target.id,
        message: "有空聊聊吗？",
        clientRequestId: "http-message-once",
      }),
    });
    assert.equal(exchangeResponse.status, 200);
    const exchange = await exchangeResponse.json() as {
      channel: { id: string };
      episode: { status: string };
    };
    assert.equal(exchange.episode.status, "completed");

    const listResponse = await fetch(
      `${baseUrl}/api/v1/character-channels?worldId=${encodeURIComponent(setup.world.id)}`,
    );
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as { channels: Array<{ id: string; unreadCount: number }> };
    assert.equal(listed.channels[0].id, exchange.channel.id);
    assert.equal(listed.channels[0].unreadCount, 2);

    const snapshotResponse = await fetch(
      `${baseUrl}/api/v1/character-channels/${encodeURIComponent(exchange.channel.id)}`,
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { snapshot: { messages: unknown[] } };
    assert.equal(snapshot.snapshot.messages.length, 2);
    const readResponse = await fetch(
      `${baseUrl}/api/v1/character-channels/${encodeURIComponent(exchange.channel.id)}/read`,
      { method: "POST" },
    );
    assert.equal(readResponse.status, 200);
    assert.equal((await readResponse.json() as { channel: { unreadCount: number } }).channel.unreadCount, 0);

    const policyResponse = await fetch(
      `${baseUrl}/api/v1/characters/${encodeURIComponent(setup.source.id)}/life`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            socialEnabled: false,
            socialDailyLimit: 3,
            socialCooldownMinutes: 360,
          },
        }),
      },
    );
    assert.equal(policyResponse.status, 200);
    const policy = (await policyResponse.json() as {
      life: { policy: { socialEnabled: boolean; socialDailyLimit: number; socialCooldownMinutes: number } };
    }).life.policy;
    assert.equal(policy.socialEnabled, false);
    assert.equal(policy.socialDailyLimit, 3);
    assert.equal(policy.socialCooldownMinutes, 360);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

function setupSharedWorld(runtime: TestRuntime, targetModelProfileId?: string) {
  const source = runtime.kernel.createCharacter({
    name: "发起角色",
    soulMarkdown: "# SOUL.md\n\n做事严谨，会主动向同伴求助。",
  });
  const target = runtime.kernel.createCharacter({
    name: "目标角色",
    soulMarkdown: "# SOUL.md\n\n待人温和，有自己的判断。",
    ...(targetModelProfileId ? { modelProfileId: targetModelProfileId } : {}),
  });
  const world = runtime.kernel.createWorld({
    name: "共同生活世界",
    timezone: "Asia/Shanghai",
    description: "两位角色生活在同一个城市。",
  });
  const place = runtime.kernel.createWorldPlace({
    worldId: world.id,
    name: "共同工作室",
    capabilityIds: ["work", "socialize", "communicate", "rest"],
  });
  for (const character of [source, target]) {
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
  }
  return { source, target, world, place };
}

function writeChatCompletionStream(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-channel",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-channel",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
