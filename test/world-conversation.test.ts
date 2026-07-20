import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("world turns use director, per-character actor, and analyzer model bindings", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-world-conversation-"));
  const requests: Array<{ model: string; body: string }> = [];
  let aliceId = "";
  let bobId = "";
  let roofId = "";
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(body) as { model?: string };
    const model = parsed.model ?? "unknown";
    requests.push({ model, body });
    const content = model === "world-director"
      ? JSON.stringify({
          placeId: roofId,
          openingNarration: "夜风掠过天台，城市的灯光在栏杆外铺开。",
          participants: [
            { characterId: aliceId, cue: "先回应用户的提议。" },
            { characterId: bobId, cue: "听见 Alice 后自然接话。" },
          ],
        })
      : model === "alice-actor"
        ? "Alice 抬手压住被风吹乱的发梢，望向用户：\"这里比楼下安静。\""
        : model === "bob-actor"
          ? "Bob 听完 Alice 的话，靠在栏杆旁笑了笑：\"那就在这里聊吧。\""
          : model === "world-analyzer"
            ? JSON.stringify({
                event: {
                  action: "begin",
                  title: "天台夜谈",
                  summary: "用户与 Alice、Bob 已经来到天台交谈。",
                  objective: "完成这次坦诚的夜谈",
                  placeId: roofId,
                  participantIds: [aliceId, bobId],
                  confidence: 0.96,
                },
                runtimeUpdates: [
                  { characterId: aliceId, placeId: roofId, activity: "在天台交谈", availability: "busy", energy: 72, confidence: 0.95 },
                  { characterId: bobId, placeId: roofId, activity: "在天台交谈", availability: "busy", energy: 68, confidence: 0.95 },
                ],
                observations: [
                  { characterId: aliceId, knowledge: "direct", summary: "用户选择在天台与大家谈话。", salience: 0.72, remember: false },
                  { characterId: bobId, knowledge: "direct", summary: "Alice 认为天台比楼下安静。", salience: 0.67, remember: false },
                ],
                relationships: [{
                  subjectCharacterId: bobId,
                  objectCharacterId: aliceId,
                  affinityDelta: 2,
                  trustDelta: 1,
                  tensionDelta: -1,
                  intimacyDelta: 1,
                  summary: "Bob 接受了 Alice 对谈话地点的判断。",
                  confidence: 0.91,
                }],
              })
            : "unexpected model";
    writeChatCompletionStream(response, model, content);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  let kernel: CompanionKernel | undefined;
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      postTurnAnalyzer: async () => ({
        relationship: { significant: false, confidence: 1 },
        interaction: { decision: "not_applicable", confidence: 1, reasonCode: "none" },
      }),
    });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    kernel.setAgentModuleEnabled("mcp:relationship-state", true);
    kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "fallback-model" });
    const director = kernel.createModelApiProfile({ name: "世界导演", enabled: true, baseUrl, model: "world-director" });
    const analyst = kernel.createModelApiProfile({ name: "世界分析", enabled: true, baseUrl, model: "world-analyzer" });
    const aliceModel = kernel.createModelApiProfile({ name: "Alice 模型", enabled: true, baseUrl, model: "alice-actor" });
    const bobModel = kernel.createModelApiProfile({ name: "Bob 模型", enabled: true, baseUrl, model: "bob-actor" });
    const alice = kernel.createCharacter({ name: "Alice", soulMarkdown: "Alice 冷静、敏锐。", modelProfileId: aliceModel.id });
    const bob = kernel.createCharacter({ name: "Bob", soulMarkdown: "Bob 随和但观察细致。", modelProfileId: bobModel.id });
    aliceId = alice.id;
    bobId = bob.id;
    const world = kernel.createWorld({
      name: "夜间杭州",
      directorModelProfileId: director.id,
      analystModelProfileId: analyst.id,
    });
    const lobby = kernel.createWorldPlace({ worldId: world.id, name: "酒店大堂", capabilityIds: ["socialize", "communicate"] });
    const roof = kernel.createWorldPlace({ worldId: world.id, name: "酒店天台", capabilityIds: ["socialize", "observe"] });
    roofId = roof.id;
    kernel.assignCharacterWorld(alice.id, { worldId: world.id, homePlaceId: lobby.id, currentPlaceId: lobby.id });
    kernel.assignCharacterWorld(bob.id, { worldId: world.id, homePlaceId: lobby.id, currentPlaceId: lobby.id });
    const events: string[] = [];

    const result = await kernel.sendWorldMessage(world.id, "我们去天台聊聊吧。", "Asia/Shanghai", [], (event) => {
      if (event.type === "director_state") events.push(`director:${event.phase}`);
      if (event.type === "participant_state") events.push(`${event.characterId}:${event.phase}`);
      if (event.type === "message") events.push(`${event.message.senderType}:message`);
      if (event.type === "analysis_state") events.push(`analysis:${event.phase}`);
    });

    assert.equal(result.turn.status, "completed");
    assert.equal(result.turn.modelCalls, 4);
    assert.equal(result.turn.actorCount, 2);
    assert.deepEqual(requests.map((entry) => entry.model), [
      "world-director", "alice-actor", "bob-actor", "world-analyzer",
    ]);
    assert.match(requests[2].body, /Alice 抬手压住/);
    assert.match(requests[1].body, /Alice 冷静、敏锐/);
    assert.match(requests[2].body, /Bob 随和但观察细致/);
    assert.deepEqual(kernel.listWorldConversationMessages(world.id).map((entry) => entry.senderType), [
      "user", "director", "character", "character",
    ]);
    assert.equal(kernel.getWorldConversation(world.id).activeEvent?.title, "天台夜谈");
    assert.equal(kernel.getCharacterLife(alice.id).runtime?.placeId, roof.id);
    assert.equal(kernel.getCharacterLife(bob.id).runtime?.activity, "在天台交谈");
    const worldContext = kernel.worldConversationService.characterContext(world.id, bob.id);
    assert.match(worldContext, /Alice 认为天台比楼下安静/);
    assert.match(worldContext, /Bob 接受了 Alice/);
    assert.equal(kernel.getWorldConversation(world.id).relationships[0]?.affinity, 52);
    assert.equal(kernel.getWorldConversation(world.id).unreadCount, 1);
    assert.equal(kernel.markWorldConversationRead(world.id).unreadCount, 0);
    assert.deepEqual(events, [
      "director:planning",
      "director:message",
      `${alice.id}:typing`,
      "character:message",
      `${bob.id}:typing`,
      "character:message",
      "analysis:analyzing",
      "analysis:applied",
    ]);
    assert.deepEqual(new Set(kernel.recentModelContextTraces(10).map((entry) => entry.turnKind)), new Set([
      "world_director", "world_actor", "world_analysis",
    ]));
    await kernel.postTurnCoordinator.drain();
  } finally {
    kernel?.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("world conversation HTTP endpoints expose one timeline per world and stream failures safely", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const character = kernel.createCharacter({ name: "路由角色" });
  const world = kernel.createWorld({ name: "路由世界" });
  kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const listed = await fetch(`${baseUrl}/api/v1/world-conversations`);
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as { conversations: Array<{ worldId: string; characterIds: string[] }> };
    assert.deepEqual(listBody.conversations.map((entry) => entry.worldId), [world.id]);
    assert.deepEqual(listBody.conversations[0]?.characterIds, [character.id]);

    const streamed = await fetch(`${baseUrl}/api/v1/worlds/${encodeURIComponent(world.id)}/conversation/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "继续。" }),
    });
    assert.equal(streamed.status, 200);
    const streamText = await streamed.text();
    assert.match(streamText, /"type":"director_state"/);
    assert.match(streamText, /"phase":"failed"/);
    assert.match(streamText, /"type":"turn_done"/);
    assert.match(streamText, /"type":"done"/);

    const history = await fetch(`${baseUrl}/api/v1/worlds/${encodeURIComponent(world.id)}/conversation/messages`);
    const historyBody = (await history.json()) as { messages: Array<{ senderType: string; content: string }> };
    assert.deepEqual(historyBody.messages.map((entry) => [entry.senderType, entry.content]), [["user", "继续。"]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

function writeChatCompletionStream(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
