import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import { CharacterDiaryService } from "../src/diary/service.js";
import { diarySystemPrompt, parseDiaryMemory } from "../src/diary/prompts.js";
import type { DiaryGenerator, DiarySource, RomanceDecision } from "../src/diary/types.js";
import { createHttpServer } from "../src/http/router.js";
import { AppDatabase } from "../src/storage/database.js";

function setup(runtime: TestRuntime) {
  const kernel = runtime.kernel;
  kernel.setAgentModuleEnabled("mcp:memory-coordinator", true);
  kernel.setAgentModuleEnabled("mcp:relationship-state", true);
  kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
  const alice = kernel.createCharacter({ name: "林澈", soulMarkdown: "成年。认真而克制。" });
  const bob = kernel.createCharacter({ name: "顾遥", soulMarkdown: "成年。独立，尊重对方。" });
  const world = kernel.createWorld({ name: "河岸小城", timezone: "Asia/Shanghai" });
  const place = kernel.createWorldPlace({ worldId: world.id, name: "书店", capabilityIds: ["work", "communicate", "rest"] });
  for (const character of [alice, bob]) kernel.assignCharacterWorld(character.id, { worldId: world.id, currentPlaceId: place.id, homePlaceId: place.id });
  const source: DiarySource = { kind: "activity", id: "experience-1", characterId: alice.id, characterName: alice.name,
    worldId: world.id, worldName: world.name, timezone: world.timezone, title: "书店的一天", occurredAt: runtime.clock.now().toISOString(),
    soul: alice.soulMarkdown, observations: ["[direct] 我整理完了书店的新书。"], statements: [] };
  return { kernel, alice, bob, world, place, source };
}

const memoryOf = (source: DiarySource) => ({ points: [{ kind: "fact", text: source.observations[0]!.replace(/^\[direct\] /, ""), evidence: source.observations[0]! }], relationships: [] });
const generate: DiaryGenerator = async input => input.kind === "memory" ? memoryOf(input.source) : "雨停后，我在书店里整理新书。";

test("diary products are independent, owner-scoped, immutable on replay, and literary rewrites never change memory", async () => {
  const calls: Parameters<DiaryGenerator>[0][] = [];
  const runtime = createTestRuntime({ diaryGenerator: async input => { calls.push(input); return input.kind === "memory" ? memoryOf(input.source) : "文学虚构哨兵：我赢得了一艘宇宙飞船。"; } });
  try {
    const { kernel, alice, bob, source, world } = setup(runtime);
    kernel.characterDiaries.updateSettings(alice.id, { narrativeEnabled: true, preset: "克制的第一人称，预设哨兵。" });
    const entry = kernel.characterDiaries.capture(source);
    assert.equal(kernel.characterDiaries.capture({ ...source, observations: ["篡改经历"] }).id, entry.id);
    assert.deepEqual(kernel.characterDiaries.get(alice.id, entry.id).source.observations, source.observations);
    assert.throws(() => kernel.characterDiaries.get(bob.id, entry.id), /不属于/);
    const firstDrain = kernel.characterDiaries.drain();
    assert.equal(kernel.characterDiaries.drain(), firstDrain);
    await firstDrain;
    assert.equal(calls.length, 2);
    assert.equal(calls.find(call => call.kind === "memory")?.preset, "");
    assert.match(calls.find(call => call.kind === "narrative")!.preset, /预设哨兵/);
    assert.doesNotMatch(JSON.stringify(calls), /宇宙飞船/);
    const saved = kernel.characterDiaries.get(alice.id, entry.id);
    assert.ok(saved.jobs.every(job => job.status === "ready"));
    assert.match(saved.narrative!, /宇宙飞船/);
    assert.doesNotMatch(kernel.characterDiaries.memoryContext(alice.id, world.id), /宇宙飞船/);
    assert.equal(kernel.characterDiaries.memoryContext(bob.id, world.id), "");
    assert.equal(kernel.characterDiaries.memoryContext(alice.id, "another-world"), "");
    const memories = kernel.searchRpMemories({ characterId: alice.id, type: "plot_event", confirmedOnly: true });
    assert.equal(memories.filter(memory => memory.key === `diary:${entry.id}`).length, 1);
    assert.doesNotMatch(JSON.stringify(memories), /宇宙飞船/);
    kernel.characterDiaries.retry(alice.id, entry.id, "narrative");
    await kernel.characterDiaries.drain();
    assert.deepEqual(kernel.characterDiaries.get(alice.id, entry.id).memory, saved.memory);
    assert.equal(calls.filter(call => call.kind === "memory").length, 1);
    assert.throws(() => kernel.characterDiaries.retry(alice.id, entry.id, "memory"), /不随长文重写/);
  } finally { runtime.dispose(); }
});

test("memory validation rejects unsupported evidence and uncertain observations promoted to facts", () => {
  const runtime = createTestRuntime();
  try {
    const { source } = setup(runtime);
    assert.throws(() => parseDiaryMemory({ points: [{ kind: "fact", text: "假承诺", evidence: "答应结婚" }] }, source), /依据/);
    const inferred = { ...source, observations: ["[inferred] 我猜她很失落。"] };
    assert.throws(() => parseDiaryMemory({ points: [{ kind: "fact", text: "她很失落", evidence: "她很失落" }] }, inferred), /推测/);
    assert.equal(parseDiaryMemory({ points: [{ kind: "interpretation", text: "我猜她很失落", evidence: "她很失落" }] }, inferred).points[0]!.kind, "interpretation");
    assert.match(diarySystemPrompt("narrative", "文风预设"), /NEVER be used as memory/);
    assert.doesNotMatch(diarySystemPrompt("memory", "文风预设"), /文风预设/);
  } finally { runtime.dispose(); }
});

test("a failed memory task does not block the literary diary and can be retried separately", async () => {
  let failed = false;
  const runtime = createTestRuntime({ diaryGenerator: async input => {
    if (input.kind === "memory" && !failed) { failed = true; throw new Error("private provider failure"); }
    return generate(input);
  } });
  try {
    const { kernel, alice, source } = setup(runtime);
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    assert.equal(kernel.characterDiaries.get(alice.id, entry.id).jobs.find(job => job.kind === "memory")?.status, "failed");
    assert.ok(kernel.characterDiaries.get(alice.id, entry.id).narrative);
    assert.doesNotMatch(JSON.stringify(kernel.getCharacterDiary(alice.id)), /private provider failure/);
    kernel.characterDiaries.retry(alice.id, entry.id, "memory");
    await kernel.characterDiaries.drain();
    assert.ok(kernel.characterDiaries.get(alice.id, entry.id).jobs.every(job => job.status === "ready"));
  } finally { runtime.dispose(); }
});

test("checkpointed memory is replayed unchanged after a partial materialization failure", async () => {
  const runtime = createTestRuntime();
  const { kernel, source, alice } = setup(runtime);
  let generated = 0;
  const materialized: unknown[] = [];
  const service = new CharacterDiaryService(kernel.database, runtime.clock, kernel.store.idGenerator, {
    canRun: () => true,
    generate: async input => { generated++; return generate(input); },
    onMemory: (_entry, memory) => { materialized.push(memory); if (materialized.length === 1) throw new Error("crash after first write"); },
  });
  try {
    service.updateSettings(alice.id, { narrativeEnabled: false, preset: "" });
    const entry = service.capture(source);
    await service.drain();
    service.retry(alice.id, entry.id, "memory");
    await service.drain();
    assert.equal(generated, 1);
    assert.equal(materialized.length, 2);
    assert.deepEqual(materialized[0], materialized[1]);
    assert.equal(service.get(alice.id, entry.id).jobs.find(job => job.kind === "memory")?.status, "ready");
  } finally { service.dispose(); runtime.dispose(); }
});

test("disabling narrative while a model is running fences stale output", async () => {
  let finish!: (value: string) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const runtime = createTestRuntime({ diaryGenerator: async input => {
    if (input.kind === "memory") return memoryOf(input.source);
    began(); return new Promise<string>(resolve => { finish = resolve; });
  } });
  try {
    const { kernel, alice, source } = setup(runtime);
    const entry = kernel.characterDiaries.capture(source);
    const running = kernel.characterDiaries.drain();
    await started;
    kernel.characterDiaries.updateSettings(alice.id, { narrativeEnabled: false, preset: "" });
    finish("不应该落盘的旧输出");
    await running;
    const saved = kernel.characterDiaries.get(alice.id, entry.id);
    assert.equal(saved.narrative, undefined);
    assert.equal(saved.jobs.find(job => job.kind === "narrative")?.status, "paused");
    assert.ok(saved.memory);
  } finally { runtime.dispose(); }
});

test("daily model-call limits survive user retries and resume after a rolling day", async () => {
  const calls: string[] = [];
  const runtime = createTestRuntime({ diaryGenerator: async input => { calls.push(input.kind); return generate(input); } });
  try {
    const { kernel, alice, source } = setup(runtime);
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    for (let n = 0; n < 4; n++) { kernel.characterDiaries.retry(alice.id, entry.id, "narrative"); await kernel.characterDiaries.drain(); }
    assert.equal(calls.filter(kind => kind === "narrative").length, 3);
    runtime.clock.advance(24 * 3600_000 + 1);
    await kernel.characterDiaries.drain();
    assert.equal(calls.filter(kind => kind === "narrative").length, 4);
  } finally { runtime.dispose(); }
});

test("disabled memory and relationship capabilities prevent memory processing and context injection", async () => {
  const calls: string[] = [];
  const runtime = createTestRuntime({ diaryGenerator: async input => { calls.push(input.kind); return generate(input); } });
  try {
    const { kernel, alice, source, world } = setup(runtime);
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    kernel.setAgentModuleEnabled("mcp:relationship-state", false);
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    assert.deepEqual(calls, ["narrative"]);
    assert.equal(kernel.characterDiaries.memoryContext(alice.id, world.id), "");
    assert.throws(() => kernel.characterDiaries.retry(alice.id, entry.id, "memory"), /启用/);
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", true);
    await kernel.characterDiaries.drain();
    assert.equal(calls.at(-1), "memory");
  } finally { runtime.dispose(); }
});

test("event closure captures only owner observations and undo removes them from live memory", async () => {
  const runtime = createTestRuntime({ diaryGenerator: generate });
  try {
    const { kernel, alice, bob, world } = setup(runtime);
    const event = kernel.transitionWorldStoryEvent(world.id, { action: "begin", source: "user_control", title: "书店夜谈", participantIds: [alice.id, bob.id] })!;
    kernel.worldConversationService.createObservation({ worldId: world.id, eventId: event.id, characterId: alice.id, knowledge: "direct", summary: "我听见她说书已经送到了。", salience: 0.8 });
    kernel.transitionWorldStoryEvent(world.id, { action: "resolve", source: "user_control", summary: "全知秘密：她在另一个城市买了房。" });
    assert.equal(kernel.characterDiaries.list(bob.id).length, 0);
    const entry = kernel.characterDiaries.list(alice.id)[0]!;
    assert.doesNotMatch(JSON.stringify(entry.source), /全知秘密|买了房/);
    await kernel.characterDiaries.drain();
    assert.match(kernel.characterDiaries.memoryContext(alice.id, world.id), /书已经送到/);
    kernel.undoWorldStoryEvent(world.id);
    assert.equal(kernel.characterDiaries.memoryContext(alice.id, world.id), "");
    assert.equal(kernel.characterDiaries.get(alice.id, entry.id).invalidated, true);
    assert.ok(kernel.characterDiaries.get(alice.id, entry.id).narrative, "reader history is retained");
    assert.throws(() => kernel.characterDiaries.retry(alice.id, entry.id, "narrative"), /撤销/);
    assert.equal(kernel.searchRpMemories({ characterId: alice.id, type: "plot_event", confirmedOnly: true }).filter(memory => memory.key === `diary:${entry.id}`).length, 0);
    kernel.transitionWorldStoryEvent(world.id, { action: "resolve", source: "user_control", summary: "这次真正结束。" });
    assert.equal(kernel.characterDiaries.list(alice.id).filter(value => !value.invalidated).length, 1);
    assert.notEqual(kernel.characterDiaries.list(alice.id).find(value => !value.invalidated)!.id, entry.id);
  } finally { runtime.dispose(); }
});

test("completed autonomous activities enqueue one diary without replacing the calendar schedule", async () => {
  const runtime = createTestRuntime({ now: "2026-09-07T01:00:00.000Z", diaryGenerator: generate, worldPlanner: async input => ({ activities: [{
    title: "整理新书", placeId: input.places[0]!.id, capabilityId: "work", startLocal: "2026-09-07T09:10:00", endLocal: "2026-09-07T10:00:00", summary: "我整理完了书店的新书。", salience: 0.7,
  }] }) });
  try {
    const { kernel, alice } = setup(runtime);
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: true, proactiveEnabled: false });
    const planned = await kernel.planCharacterLife(alice.id);
    assert.equal(planned.plans.length, 1);
    runtime.clock.advance(61 * 60_000);
    await runtime.worldTick(alice.id);
    assert.equal(kernel.getScheduleItem(planned.plans[0]!.scheduleItemId).status, "completed");
    assert.equal(kernel.characterDiaries.list(alice.id).length, 1);
    assert.equal(kernel.characterDiaries.list(alice.id)[0]!.source.kind, "activity");
    await runtime.worldTick(alice.id);
    assert.equal(kernel.characterDiaries.list(alice.id).length, 1);
  } finally { runtime.dispose(); }
});

test("character exchanges create two scoped diaries and evidence-backed asymmetric interest", async () => {
  let aliceId = "";
  let bobId = "";
  const runtime = createTestRuntime({ characterInteractionActor: async () => "我收到你的心意了，但我还需要时间。", characterInteractionSceneComposer: false,
    diaryGenerator: async input => input.kind === "narrative" ? "我们的聊天结束了。" : { ...memoryOf(input.source), relationships: input.source.characterId === aliceId ? [{
      subjectCharacterId: aliceId, objectCharacterId: bobId, event: "interest", subjectEvidence: "我喜欢你，想认真了解你。", confidence: 0.98,
    }] : [] },
  });
  try {
    const { kernel, alice, bob, world } = setup(runtime); aliceId = alice.id; bobId = bob.id;
    const result = await kernel.sendCharacterChannelMessage({ sourceCharacterId: alice.id, targetCharacterId: bob.id, message: "我喜欢你，想认真了解你。", idempotencyKey: "diary-contact", source: "manual" });
    assert.equal(result.episode.status, "completed");
    assert.equal(kernel.characterDiaries.list(alice.id).length, 1);
    assert.equal(kernel.characterDiaries.list(bob.id).length, 1);
    await kernel.characterDiaries.drain();
    const repository = kernel.worldConversationService.repository;
    assert.equal(repository.getCharacterRelationship(world.id, alice.id, bob.id)?.romanceStatus, "interested");
    assert.equal(repository.getCharacterRelationship(world.id, bob.id, alice.id)?.romanceStatus, "none");
    assert.equal(kernel.getCharacterDiary(alice.id).relationships[0]!.peerRomanceStatus, "none");
  } finally { runtime.dispose(); }
});

test("romance requires attributed bilateral evidence, never score thresholds; breakup and reconciliation retain history", () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, alice, bob, world, source } = setup(runtime);
    const service = kernel.worldConversationService;
    for (let n = 0; n < 30; n++) service.applyRelationshipDelta({ worldId: world.id, subjectCharacterId: alice.id, objectCharacterId: bob.id, affinityDelta: 5, trustDelta: 5, intimacyDelta: 5, tensionDelta: 0, summary: "相处愉快" });
    const status = (a = alice.id, b = bob.id) => service.repository.getCharacterRelationship(world.id, a, b)?.romanceStatus ?? "none";
    assert.equal(status(), "none");
    const interaction: DiarySource = { ...source, kind: "interaction", statements: [
      { characterId: alice.id, name: alice.name, text: "我希望和你正式交往。我们分手吧。我愿意重新开始。" },
      { characterId: bob.id, name: bob.name, text: "我也愿意和你交往。我愿意和你重新交往。" },
    ] };
    const decision: RomanceDecision = { subjectCharacterId: alice.id, objectCharacterId: bob.id, event: "confirm", subjectEvidence: "我希望和你正式交往。", confidence: 0.95 };
    assert.equal(service.applyRomanceDecision(interaction, decision), false);
    assert.equal(service.applyRomanceDecision(interaction, { ...decision, objectEvidence: decision.subjectEvidence }), false);
    assert.equal(service.applyRomanceDecision(interaction, { ...decision, objectEvidence: "我也愿意和你交往。", confidence: 0.5 }), false);
    const mutual = { ...decision, objectEvidence: "我也愿意和你交往。" };
    assert.equal(service.applyRomanceDecision(interaction, mutual), true);
    assert.equal(status(), "dating"); assert.equal(status(bob.id, alice.id), "dating");
    assert.equal(service.applyRomanceDecision(interaction, mutual), false);
    assert.equal(service.applyRomanceDecision({ ...interaction, id: "breakup" }, { ...decision, event: "breakup", subjectEvidence: "我们分手吧。" }), true);
    assert.equal(status(), "former_partners"); assert.equal(status(bob.id, alice.id), "former_partners");
    assert.equal(service.applyRomanceDecision({ ...interaction, id: "cannot-confirm-ex" }, mutual), false);
    assert.equal(service.applyRomanceDecision({ ...interaction, id: "reconcile" }, { ...mutual, event: "reconcile", subjectEvidence: "我愿意重新开始。", objectEvidence: "我愿意和你重新交往。" }), true);
    assert.equal(status(), "dating");
    assert.equal(service.applyRomanceDecision({ ...interaction, id: "late-old-breakup", occurredAt: "2000-01-01T00:00:00.000Z" }, { ...decision, event: "breakup", subjectEvidence: "我们分手吧。" }), false);
    assert.equal((kernel.database.connection.prepare("SELECT count(*) AS n FROM world_character_romance_events").get() as { n: number }).n, 3);
    const elsewhere = kernel.createWorld({ name: "另一世界" });
    kernel.assignCharacterWorld(bob.id, { worldId: elsewhere.id });
    assert.equal(service.applyRomanceDecision({ ...interaction, id: "cross-world" }, { ...mutual, event: "breakup" }), false);
  } finally { runtime.dispose(); }
});

test("diary memories enter only the owner's normal conversation, not another character or secret space", async () => {
  const runtime = createTestRuntime({ diaryGenerator: generate });
  try {
    const { kernel, alice, bob, source } = setup(runtime);
    kernel.characterDiaries.capture({ ...source, observations: ["[direct] OWNER_DIARY_SENTINEL 我收好了那张旧车票。"] });
    await kernel.characterDiaries.drain();
    for (const [id, characterId, conversationSpace] of [["diary-normal", alice.id, "normal"], ["diary-peer", bob.id, "normal"], ["diary-secret", alice.id, "secret"]] as const) {
      runtime.model.enqueue([{ kind: "assistant_text", text: "今天还不错。" }]);
      await kernel.sendMessage(id, { mode: "sms", characterId, conversationSpace, text: "今天怎么样？" });
      const payload = JSON.stringify(runtime.model.requests.at(-1));
      if (id === "diary-normal") assert.match(payload, /OWNER_DIARY_SENTINEL/);
      else assert.doesNotMatch(payload, /OWNER_DIARY_SENTINEL/);
    }
  } finally { runtime.dispose(); }
});

test("the real diary transport selects world-specific profiles, disables supported background thinking, and sends no tools", async () => {
  const requests: Array<Record<string, any>> = [];
  let source!: DiarySource;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const content = body.model === "diary-analyst" ? JSON.stringify(memoryOf(source)) : "只供读者阅读的独立正文。";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "diary-model", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "diary-model", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const runtime = createTestRuntime();
  try {
    const setupResult = setup(runtime); source = setupResult.source;
    const { kernel, alice, world } = setupResult;
    const address = server.address(); assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const director = kernel.createModelApiProfile({ name: "日记导演", enabled: true, baseUrl, model: "mlx-community/Qwen3-8B-4bit" });
    const analyst = kernel.createModelApiProfile({ name: "日记摘要", enabled: true, baseUrl, model: "diary-analyst" });
    kernel.updateWorld(world.id, { directorModelProfileId: director.id, analystModelProfileId: analyst.id });
    kernel.characterDiaries.updateSettings(alice.id, { narrativeEnabled: true, preset: "PRESET_ONLY_FOR_READER" });
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    assert.ok(kernel.characterDiaries.get(alice.id, entry.id).jobs.every(job => job.status === "ready"));
    assert.equal(requests.length, 2);
    const memory = requests.find(request => request.model === "diary-analyst")!;
    const narrative = requests.find(request => request.model !== "diary-analyst")!;
    assert.equal(memory.max_tokens, 2400); assert.equal(narrative.max_tokens, 6000);
    assert.equal(narrative.chat_template_kwargs.enable_thinking, false);
    assert.doesNotMatch(JSON.stringify(memory), /PRESET_ONLY_FOR_READER|只供读者阅读的独立正文/);
    assert.match(JSON.stringify(narrative), /PRESET_ONLY_FOR_READER/);
    assert.ok(requests.every(request => !request.tools?.length));
  } finally { runtime.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("diary HTTP mutations require the local UI, bind entries to their owner, and exports/deletion respect the new data", async () => {
  const runtime = createTestRuntime({ diaryGenerator: generate });
  const { kernel, alice, bob, source } = setup(runtime);
  const entry = kernel.characterDiaries.capture(source);
  const server = createHttpServer({ kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/api/v1/characters/${alice.id}/diary`;
    assert.equal((await fetch(url)).status, 200);
    const patch = { method: "PATCH", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ narrativeEnabled: false, preset: "轻盈自然" }) };
    assert.equal((await fetch(`${url}/settings`, patch)).status, 403);
    const page = await fetch(`${origin}/`);
    const cookie = page.headers.get("set-cookie")!.split(";", 1)[0]!;
    const headers = { ...patch.headers, cookie };
    assert.equal((await fetch(`${url}/settings`, { ...patch, headers })).status, 200);
    assert.equal(kernel.characterDiaries.settings(alice.id).preset, "轻盈自然");
    const wrongOwner = await fetch(`${origin}/api/v1/characters/${bob.id}/diary/${entry.id}/retry`, { method: "POST", headers, body: JSON.stringify({ kind: "memory" }) });
    assert.equal(wrongOwner.status, 400);
    assert.doesNotMatch(JSON.stringify(await (await fetch(url)).json()), /soulMarkdown|observations|soul/);
    const normal = await kernel.exportUserData();
    assert.match(JSON.stringify(normal), /characterDiaries/);
    const secret = await kernel.exportUserData("secret", alice.id);
    assert.doesNotMatch(JSON.stringify(secret), /characterDiaries|书店的一天/);
    await kernel.deleteAllUserData();
    for (const table of ["character_diary_entries", "character_diary_jobs", "character_diary_settings", "character_diary_generations", "world_character_romance_events"]) {
      assert.equal((kernel.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.dispose(); }
});

test("schema 51 upgrades safely to the current diary schema and pending diary work survives restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yourchar-diary-restart-"));
  try {
    const path = join(dir, "migration.sqlite");
    const old = new AppDatabase(path, { maxMigrationVersion: 51 }); old.close();
    const upgraded = new AppDatabase(path);
    assert.equal((upgraded.connection.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 62);
    upgraded.close();
    let owner = ""; let id = "";
    const first = createTestRuntime({ stateDir: dir, seed: "diary-first", diaryGenerator: generate });
    try {
      const { source, alice, kernel } = setup(first); owner = alice.id;
      id = kernel.characterDiaries.capture(source).id;
      kernel.database.connection.prepare("UPDATE character_diary_jobs SET status='running',lease_id='dead-process',lease_until='2000-01-01T00:00:00.000Z' WHERE kind='memory'").run();
    } finally { first.dispose(); }
    const second = createTestRuntime({ stateDir: dir, seed: "diary-second", diaryGenerator: generate });
    try {
      await second.kernel.characterDiaries.drain();
      assert.ok(second.kernel.characterDiaries.get(owner, id).jobs.every(job => job.status === "ready"));
    } finally { second.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
