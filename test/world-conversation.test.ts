import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("world turns use one world narrative model and never invoke character-bound models", async () => {
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
      ? "上午十点半，天台被明亮的日光照着。Alice 抬手压住被风吹乱的发梢，望向用户：\"这里比楼下安静。\" Bob 听完她的话，靠在栏杆旁笑了笑：\"那就在这里聊吧。\""
      : model === "world-analyzer"
        ? JSON.stringify({
                event: {
                  action: "begin",
                  title: "天台交谈",
                  summary: "用户与 Alice、Bob 已经在上午来到天台交谈。",
                  objective: "完成这次坦诚交谈",
                  placeId: roofId,
                  participantIds: [aliceId, bobId],
                  confidence: 0.96,
                },
                runtimeUpdates: [
                  { characterId: aliceId, placeId: roofId, activity: "在天台交谈", availability: "busy", energy: 72, confidence: 0.95 },
                  { characterId: bobId, placeId: roofId, activity: "在天台交谈", availability: "busy", energy: 68, confidence: 0.95 },
                ],
                observations: [
                  { characterId: aliceId, knowledge: "direct", summary: "用户选择在天台与大家谈话。", salience: 0.72 },
                  { characterId: bobId, knowledge: "direct", summary: "Alice 认为天台比楼下安静。", salience: 0.67 },
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
                attributeChanges: [{
                  characterId: aliceId,
                  key: "public_trust",
                  direction: "increase",
                  summary: "Alice 完成了公开的天台会谈",
                  evidence: "Alice 抬手压住被风吹乱的发梢",
                  confidence: 0.94,
                  delta: 999,
                }],
              })
        : "character model must not be called";
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
      clock: new VirtualClock("2026-07-21T02:30:00.000Z"),
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      characterSkillReflector: false,
      postTurnAnalyzer: async () => ({
        relationship: { significant: false, confidence: 1 },
        interaction: { decision: "not_applicable", confidence: 1, reasonCode: "none" },
      }),
    });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    kernel.setAgentModuleEnabled("mcp:relationship-state", true);
    kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "fallback-model" });
    const director = kernel.createModelApiProfile({
      name: "世界导演",
      enabled: true,
      baseUrl,
      model: "world-director",
      maxTokens: 4_096,
      reasoningEffort: "high",
      thinkingTokenBudgetField: "thinking_budget",
      thinkingBudgetTokens: 2_048,
    });
    const analyst = kernel.createModelApiProfile({ name: "世界分析", enabled: true, baseUrl, model: "world-analyzer" });
    const aliceModel = kernel.createModelApiProfile({ name: "Alice 模型", enabled: true, baseUrl, model: "alice-actor" });
    const bobModel = kernel.createModelApiProfile({ name: "Bob 模型", enabled: true, baseUrl, model: "bob-actor" });
    const alice = kernel.createCharacter({ name: "Alice", soulMarkdown: "Alice 冷静、敏锐。", modelProfileId: aliceModel.id });
    const bob = kernel.createCharacter({ name: "Bob", soulMarkdown: "Bob 随和但观察细致。", modelProfileId: bobModel.id });
    aliceId = alice.id;
    bobId = bob.id;
    const world = kernel.createWorld({
      name: "现实杭州",
      directorModelProfileId: director.id,
      analystModelProfileId: analyst.id,
    });
    kernel.createWorldAttribute({
      worldId: world.id,
      key: "public_trust",
      name: "公众信任",
      minValue: 0,
      maxValue: 100,
      defaultValue: 10,
      analysisEnabled: true,
      increaseRule: "角色完成一次公开且可观察的正式会谈",
      increaseDelta: 3,
      decreaseRule: "角色公开违背已经确认的承诺",
      decreaseDelta: 8,
    });
    kernel.createWorldAttribute({
      worldId: world.id,
      key: "global_crisis_level",
      name: "全局危机值",
      scope: "world",
      minValue: 0,
      maxValue: 100,
      defaultValue: 44,
    });
    const lobby = kernel.createWorldPlace({ worldId: world.id, name: "酒店大堂", capabilityIds: ["socialize", "communicate"] });
    const roof = kernel.createWorldPlace({ worldId: world.id, name: "酒店天台", capabilityIds: ["socialize", "observe"] });
    roofId = roof.id;
    kernel.assignCharacterWorld(alice.id, { worldId: world.id, homePlaceId: lobby.id, currentPlaceId: lobby.id });
    kernel.assignCharacterWorld(bob.id, { worldId: world.id, homePlaceId: lobby.id, currentPlaceId: lobby.id });
    kernel.createScheduleItem({
      kind: "event",
      title: "上午整理实验记录",
      startAt: "2026-07-21T02:00:00.000Z",
      endAt: "2026-07-21T03:00:00.000Z",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: alice.id,
    });
    const events: string[] = [];

    const result = await kernel.sendWorldMessage(world.id, "我们去天台聊聊吧。", "Asia/Shanghai", [], (event) => {
      if (event.type === "director_state") events.push(`director:${event.phase}`);
      if (event.type === "participant_state") events.push(`${event.characterId}:${event.phase}`);
      if (event.type === "message") events.push(`${event.message.senderType}:message`);
      if (event.type === "analysis_state") events.push(`analysis:${event.phase}`);
    });

    assert.equal(result.turn.status, "completed");
    assert.equal(result.turn.modelCalls, 2);
    assert.equal(result.turn.actorCount, 0);
    assert.deepEqual(requests.map((entry) => entry.model), [
      "world-director", "world-analyzer",
    ]);
    assert.match(requests[0].body, /2026-07-21 星期二 10:30:00/);
    assert.match(requests[0].body, /period.{0,20}上午/);
    assert.match(requests[0].body, /Alice 冷静、敏锐/);
    assert.match(requests[0].body, /Bob 随和但观察细致/);
    assert.match(requests[0].body, /上午整理实验记录/);
    assert.match(requests[0].body, /global_crisis_level/);
    assert.match(requests[0].body, /全局危机值/);
    assert.match(requests[0].body, /public_trust/);
    const directorPayload = JSON.parse(requests[0].body) as Record<string, unknown>;
    assert.equal(directorPayload.thinking_budget, 2_048);
    assert.equal("reasoning_effort" in directorPayload, false);
    assert.match(requests[1].body, /上午十点半/);
    assert.match(requests[1].body, /角色完成一次公开且可观察的正式会谈/);
    assert.deepEqual(kernel.listWorldConversationMessages(world.id).map((entry) => entry.senderType), [
      "user", "director",
    ]);
    assert.equal(kernel.getWorldConversation(world.id).activeEvent?.title, "天台交谈");
    assert.equal(kernel.getCharacterLife(alice.id).runtime?.placeId, roof.id);
    assert.equal(kernel.getCharacterLife(bob.id).runtime?.activity, "在天台交谈");
    const worldContext = kernel.worldConversationService.characterContext(world.id, bob.id);
    assert.match(worldContext, /Alice 认为天台比楼下安静/);
    assert.match(worldContext, /Bob 接受了 Alice/);
    assert.equal(kernel.getWorldConversation(world.id).relationships[0]?.affinity, 52);
    const aliceLife = kernel.getCharacterLife(alice.id);
    assert.equal(aliceLife.attributes.find((entry) => entry.key === "public_trust")?.value, 13);
    assert.equal(aliceLife.attributeEvents[0]?.source, "world_turn_analysis");
    assert.equal(aliceLife.attributeEvents[0]?.appliedDelta, 3);
    assert.equal(aliceLife.attributeEvents[0]?.analysisDirection, "increase");
    assert.equal(kernel.getWorldConversation(world.id).unreadCount, 1);
    assert.equal(kernel.markWorldConversationRead(world.id).unreadCount, 0);
    assert.deepEqual(events, [
      "director:planning",
      "director:writing",
      "director:message",
      "analysis:analyzing",
      "analysis:applied",
    ]);
    assert.deepEqual(new Set(kernel.recentModelContextTraces(10).map((entry) => entry.turnKind)), new Set([
      "world_director", "world_analysis",
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
    assert.match(streamText, /"reasonCode":"model_unavailable"/);
    assert.match(streamText, /"type":"turn_done"/);
    assert.match(streamText, /"type":"done"/);
    assert.equal(kernel.store.allActions().at(-1)?.actionType, "world_narrative_generation");
    assert.equal(kernel.store.allActions().at(-1)?.payload.reasonCode, "model_unavailable");

    const history = await fetch(`${baseUrl}/api/v1/worlds/${encodeURIComponent(world.id)}/conversation/messages`);
    const historyBody = (await history.json()) as { messages: Array<{ senderType: string; content: string }> };
    assert.deepEqual(historyBody.messages.map((entry) => [entry.senderType, entry.content]), [["user", "继续。"]]);

    const rejectedReset = await fetch(`${baseUrl}/api/v1/worlds/${encodeURIComponent(world.id)}/conversation`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "错误名称" }),
    });
    assert.equal(rejectedReset.status, 409);
    assert.equal(kernel.listWorldConversationMessages(world.id).length, 1);

    const reset = await fetch(`${baseUrl}/api/v1/worlds/${encodeURIComponent(world.id)}/conversation`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: world.name }),
    });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as { reset: { deleted: { messages: number; turns: number } } };
    assert.deepEqual(resetBody.reset.deleted, {
      messages: 1,
      turns: 1,
      narrativeContexts: 0,
      narrativePromptMessages: 0,
      openEventObservations: 0,
      openEventTransitions: 0,
      openEvents: 0,
    });
    assert.deepEqual(kernel.listWorldConversationMessages(world.id), []);
    assert.equal(kernel.listWorldConversations()[0]?.worldId, world.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

test("resetting a world conversation starts a clean timeline without erasing settled continuity", async () => {
  const runtime = createTestRuntime({ now: "2026-07-21T02:00:00.000Z", seed: "world-reset" });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    const character = runtime.kernel.createCharacter({ name: "重置角色" });
    const world = runtime.kernel.createWorld({ name: "重置世界" });
    const place = runtime.kernel.createWorldPlace({ worldId: world.id, name: "河岸" });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "begin",
      source: "user_control",
      title: "已完成事件",
      summary: "角色曾在河岸完成一次交谈。",
      placeId: place.id,
      participantIds: [character.id],
    });
    runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "resolve",
      source: "user_control",
      summary: "先前交谈已经结束。",
      participantIds: [character.id],
    });
    const activeEvent = runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "begin",
      source: "user_control",
      title: "待清理事件",
      summary: "当前会话仍在推进。",
      placeId: place.id,
      participantIds: [character.id],
    });
    runtime.kernel.updateCharacterRuntime(character.id, {
      placeId: place.id,
      activity: "参与待清理事件",
      availability: "busy",
    });
    const started = runtime.kernel.worldConversationService.beginTurn(world.id, "这是一条旧消息。", []);
    const narrativeSessionId = "world-director:reset-test";
    const narrativeContext = runtime.kernel.worldConversationService.repository.createNarrativeContext({
      id: runtime.kernel.store.idGenerator.next("world-narrative-context"),
      worldId: world.id,
      eventId: activeEvent!.id,
      modelProfileId: "reset-profile",
      modelKey: "reset-model-key",
      modelSessionId: narrativeSessionId,
      systemPrompt: "fixed reset test prompt",
      stablePrefixHash: "reset-prefix-hash",
      participantIds: [character.id],
      startMessageSequence: started.message.sequence,
      status: "active",
      createdAt: runtime.clock.now().toISOString(),
      updatedAt: runtime.clock.now().toISOString(),
    });
    runtime.kernel.worldConversationService.repository.appendNarrativePromptMessage({
      id: runtime.kernel.store.idGenerator.next("world-narrative-message"),
      contextId: narrativeContext.id,
      turnId: started.turn.id,
      role: "user",
      payload: { role: "user", content: "old provider input", timestamp: runtime.clock.now().getTime() },
      createdAt: runtime.clock.now().toISOString(),
    });
    runtime.kernel.store.addModelContextTrace({
      sessionId: narrativeSessionId,
      mode: "rp",
      turnKind: "world_director",
      requestText: "旧请求",
      payload: { messages: [{ role: "user", content: "旧请求" }] },
    });

    await assert.rejects(
      runtime.kernel.resetWorldConversation(world.id, "不匹配"),
      /type the world name exactly/,
    );
    assert.equal(runtime.kernel.listWorldConversationMessages(world.id).length, 1);

    const reset = await runtime.kernel.resetWorldConversation(world.id, world.name);
    assert.equal(reset.deleted.messages, 1);
    assert.equal(reset.deleted.turns, 1);
    assert.equal(reset.deleted.narrativeContexts, 1);
    assert.equal(reset.deleted.narrativePromptMessages, 1);
    assert.equal(reset.deleted.openEvents, 1);
    assert.deepEqual(runtime.kernel.listWorldConversationMessages(world.id), []);
    assert.equal(runtime.kernel.getWorldConversation(world.id).activeEvent, undefined);
    assert.deepEqual(
      runtime.kernel.getWorldConversation(world.id).events.map((event) => [event.title, event.status]),
      [["已完成事件", "resolved"]],
    );
    assert.equal(runtime.kernel.getCharacterLife(character.id).runtime?.availability, "free");
    assert.equal(runtime.kernel.getCharacterLife(character.id).membership?.worldId, world.id);
    assert.equal(
      runtime.kernel.recentModelContextTraces(10).some((trace) => trace.sessionId === narrativeSessionId),
      false,
    );
    assert.equal(runtime.kernel.store.allActions().at(-1)?.actionType, "world_conversation_reset");
  } finally {
    runtime.dispose();
  }
});

test("world narrative context is event-scoped, append-only, and replays private reasoning", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-world-prefix-"));
  const requests: Array<{ model: string; body: Record<string, unknown> }> = [];
  let characterId = "";
  let placeId = "";
  let directorCalls = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const model = String(body.model ?? "unknown");
    requests.push({ model, body });
    if (model === "prefix-director") {
      directorCalls += 1;
      writeChatCompletionStream(
        response,
        model,
        directorCalls === 1
          ? "上午的实验室里，Alice 放下记录本，抬眼等待用户继续。"
          : "Alice 仍站在原处，顺着用户的新问题继续解释。",
        {
          reasoning: directorCalls === 1 ? "核对时间、地点与 Alice 的身份。" : "承接上一轮实验室场景。",
          promptTokens: directorCalls === 1 ? 140 : 220,
          cachedTokens: directorCalls === 1 ? 0 : 160,
        },
      );
      return;
    }
    const firstAnalysis = requests.filter((entry) => entry.model === "prefix-analyzer").length === 1;
    writeChatCompletionStream(response, model, JSON.stringify({
      event: {
        action: firstAnalysis ? "begin" : "advance",
        title: "实验室交谈",
        summary: firstAnalysis ? "用户与 Alice 开始在实验室交谈。" : "Alice 正继续向用户解释。",
        objective: "完成这次交流",
        placeId,
        participantIds: [characterId],
        confidence: 0.98,
      },
      runtimeUpdates: [],
      observations: [],
      relationships: [],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  let kernel: CompanionKernel | undefined;
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    kernel = new CompanionKernel({
      stateDir,
      clock: new VirtualClock("2026-07-21T02:30:00.000Z"),
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    const director = kernel.createModelApiProfile({
      name: "前缀世界模型",
      enabled: true,
      baseUrl,
      model: "prefix-director",
      maxTokens: 512,
      contextWindowTokens: 8_192,
    });
    const analyst = kernel.createModelApiProfile({
      name: "前缀分析模型",
      enabled: true,
      baseUrl,
      model: "prefix-analyzer",
    });
    const character = kernel.createCharacter({
      name: "Alice",
      soulMarkdown: "Alice 连续、克制，并会认真承接先前发生的事情。",
    });
    characterId = character.id;
    const world = kernel.createWorld({
      name: "前缀测试世界",
      directorModelProfileId: director.id,
      analystModelProfileId: analyst.id,
    });
    const place = kernel.createWorldPlace({ worldId: world.id, name: "实验室" });
    placeId = place.id;
    kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      currentPlaceId: place.id,
    });

    await kernel.sendWorldMessage(world.id, "Alice，在忙吗？", "Asia/Shanghai");
    await kernel.sendWorldMessage(world.id, "刚才说到哪里了？", "Asia/Shanghai");

    const directorRequests = requests.filter((entry) => entry.model === "prefix-director");
    assert.equal(directorRequests.length, 2);
    const firstMessages = directorRequests[0].body.messages as Array<Record<string, unknown>>;
    const secondMessages = directorRequests[1].body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(firstMessages.map((message) => message.role), ["system", "user"]);
    assert.deepEqual(secondMessages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.deepEqual(secondMessages.slice(0, 2), firstMessages);
    assert.match(String(firstMessages[0].content), /Alice 连续、克制/);
    assert.match(String(firstMessages[1].content), /Alice，在忙吗/);
    assert.match(String(secondMessages[3].content), /刚才说到哪里了/);
    assert.equal(secondMessages[2].reasoning_content, "核对时间、地点与 Alice 的身份。");

    const analyzerRequests = requests.filter((entry) => entry.model === "prefix-analyzer");
    assert.equal(analyzerRequests.length, 2);
    assert.doesNotMatch(JSON.stringify(analyzerRequests[1].body), /Alice 连续、克制/);
    const context = kernel.worldConversationService.repository.getActiveNarrativeContext(world.id);
    assert.ok(context);
    assert.equal(context.eventId, kernel.getWorldConversation(world.id).activeEvent?.id);
    assert.equal(kernel.worldConversationService.repository.listNarrativePromptMessages(context.id).length, 4);

    kernel.dispose();
    kernel = new CompanionKernel({
      stateDir,
      clock: new VirtualClock("2026-07-21T02:35:00.000Z"),
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    await kernel.sendWorldMessage(world.id, "那就接着说吧。", "Asia/Shanghai");
    const thirdDirectorRequest = requests.filter((entry) => entry.model === "prefix-director")[2];
    const thirdMessages = thirdDirectorRequest.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      thirdMessages.map((message) => message.role),
      ["system", "user", "assistant", "user", "assistant", "user"],
    );
    assert.deepEqual(thirdMessages.slice(0, 4), secondMessages);
    assert.match(String(thirdMessages[5].content), /那就接着说吧/);

    const directorTraces = kernel.recentModelContextTraces(10)
      .filter((trace) => trace.turnKind === "world_director");
    assert.equal(new Set(directorTraces.map((trace) => trace.sessionId)).size, 1);
    const cacheActions = kernel.store.allActions()
      .filter((action) => action.actionType === "world_narrative_cache_observation");
    assert.equal(cacheActions.length, 3);
    assert.equal(new Set(cacheActions.map((action) => action.payload.stablePrefixHash)).size, 1);
    const secondCache = cacheActions.find((action) => action.payload.promptMessageCount === 3);
    assert.equal(secondCache?.payload.cacheReadTokens, 160);
    const economics = kernel.recentContextEconomics(10)
      .filter((entry) => entry.turnKind === "world_director");
    assert.equal(economics.length, 3);
    assert.equal(new Set(economics.map((entry) => entry.systemHash)).size, 1);
    assert.equal(economics.find((entry) => entry.messageCount === 3)?.actual.cacheReadTokens, 160);
    assert.equal(economics.find((entry) => entry.messageCount === 5)?.lcpMessageCount, 4);

    const latestEconomics = economics.find((entry) => entry.messageCount === 5)!;
    const rolloverText = "续".repeat(Math.min(
      19_000,
      Math.max(1_000, latestEconomics.plannerBudgetTokens - latestEconomics.estimatedInputTokens + 500),
    ));
    await kernel.sendWorldMessage(world.id, rolloverText, "Asia/Shanghai");
    const rolloverContext = kernel.worldConversationService.repository.getActiveNarrativeContext(world.id);
    assert.ok(rolloverContext);
    assert.notEqual(rolloverContext.id, context.id);
    assert.equal(kernel.worldConversationService.repository.listNarrativePromptMessages(context.id).length, 0);
    assert.equal(
      kernel.store.allActions()
        .filter((action) => action.actionType === "world_narrative_context_closed")
        .at(-1)?.payload.reason,
      "context_checkpoint",
    );

    kernel.transitionWorldStoryEvent(world.id, {
      action: "resolve",
      source: "user_control",
      summary: "实验室交谈结束。",
      participantIds: [character.id],
    });
    assert.equal(kernel.worldConversationService.repository.getActiveNarrativeContext(world.id), undefined);
    assert.equal(kernel.worldConversationService.repository.listNarrativePromptMessages(rolloverContext.id).length, 0);
  } finally {
    kernel?.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("world observations remain provisional until the event closes and then settle per character", () => {
  const runtime = createTestRuntime({ now: "2026-07-21T02:00:00.000Z", seed: "world-event-settlement" });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:memory-coordinator", true);
    runtime.kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
    const alice = runtime.kernel.createCharacter({ name: "Alice" });
    const bob = runtime.kernel.createCharacter({ name: "Bob" });
    const world = runtime.kernel.createWorld({ name: "事件结算世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "天台",
      capabilityIds: ["socialize", "observe"],
    });
    runtime.kernel.assignCharacterWorld(alice.id, { worldId: world.id, currentPlaceId: place.id });
    runtime.kernel.assignCharacterWorld(bob.id, { worldId: world.id, currentPlaceId: place.id });
    const active = runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "begin",
      source: "user_control",
      title: "天台夜谈",
      summary: "Alice、Bob 与用户开始交谈。",
      objective: "把误会说清楚",
      placeId: place.id,
      participantIds: [alice.id, bob.id],
    });
    assert.equal(active?.status, "active");
    runtime.kernel.worldConversationService.createObservation({
      worldId: world.id,
      eventId: active!.id,
      characterId: alice.id,
      knowledge: "direct",
      summary: "Alice 亲耳听见用户解释迟到的原因。",
      salience: 0.84,
    });
    runtime.kernel.updateCharacterRuntime(alice.id, {
      activity: "参与天台夜谈",
      availability: "busy",
    });

    assert.equal(runtime.kernel.searchRpMemories({
      characterId: alice.id,
      type: "plot_event",
      confirmedOnly: true,
    }).length, 0);

    const settled = runtime.kernel.transitionWorldStoryEvent(world.id, {
      action: "resolve",
      source: "user_control",
      summary: "误会已经解释清楚，三人平静地结束谈话。",
      participantIds: [alice.id, bob.id],
    });
    assert.equal(settled?.status, "resolved");
    assert.ok(settled?.settledAt);
    assert.match(settled?.settlementSummary || "", /结算 2 位角色、1 条观察/);
    assert.equal(runtime.kernel.getWorldConversation(world.id).activeEvent, undefined);
    assert.equal(runtime.kernel.getCharacterLife(alice.id).runtime?.availability, "free");
    const aliceMemories = runtime.kernel.searchRpMemories({
      characterId: alice.id,
      type: "plot_event",
      confirmedOnly: true,
    });
    const bobMemories = runtime.kernel.searchRpMemories({
      characterId: bob.id,
      type: "plot_event",
      confirmedOnly: true,
    });
    assert.equal(aliceMemories.length, 1);
    assert.match(aliceMemories[0].content, /亲耳听见/);
    assert.equal(bobMemories.length, 0, "an unobserved outcome must not become Bob's knowledge");
    assert.doesNotMatch(runtime.kernel.worldConversationService.characterContext(world.id, alice.id), /亲耳听见/);
    assert.match(runtime.kernel.worldConversationService.chronicleContext(world.id), /误会已经解释清楚/);
  } finally {
    runtime.dispose();
  }
});

function writeChatCompletionStream(
  response: ServerResponse,
  model: string,
  content: string,
  options: { reasoning?: string; promptTokens?: number; cachedTokens?: number } = {},
): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        ...(options.reasoning ? { reasoning_content: options.reasoning } : {}),
        content,
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(options.promptTokens
      ? {
          usage: {
            prompt_tokens: options.promptTokens,
            completion_tokens: 24,
            total_tokens: options.promptTokens + 24,
            prompt_tokens_details: { cached_tokens: options.cachedTokens ?? 0 },
          },
        }
      : {}),
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
