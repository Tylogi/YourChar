import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import type { DiaryGenerator, DiarySource } from "../src/diary/types.js";
import { AppDatabase } from "../src/storage/database.js";
import { createHttpServer } from "../src/http/router.js";

const fixture = () => ({
  temperature: 0.65, top_p: 0.8, frequency_penalty: 0.15, presence_penalty: -0.2, openai_max_tokens: 9000, seed: 42,
  extensions: { regex_scripts: [{ script: "PRIVATE_EXTENSION_SENTINEL" }] },
  prompts: [
    { identifier: "vars", name: "变量", role: "system", content: "{{setvar::tone::克制}}" },
    { identifier: "before", name: "文风", role: "system", enabled: false, content: "PRESET_BEFORE char={{char}} user={{user}} tone={{getvar::tone}} date={{date}} previous={{lastcharmessage}}" },
    { identifier: "charDescription", name: "角色", role: "system", marker: true },
    { identifier: "personaDescription", name: "用户", role: "system", marker: true },
    { identifier: "scenario", name: "场景", role: "user", marker: true },
    { identifier: "chatHistory", name: "历史", role: "user", marker: true },
    { identifier: "in-chat", name: "局部", role: "user", content: "IN_CHAT", injection_position: 1, injection_depth: 0, injection_order: 100 },
    { identifier: "after", name: "结尾", role: "assistant", content: "PRESET_AFTER tone={{getvar::tone}}" },
    { identifier: "disabled", name: "停用", role: "system", enabled: true, content: "DISABLED_SENTINEL" },
  ],
  prompt_order: [{ character_id: 100001, order: ["vars", "before", "charDescription", "personaDescription", "scenario", "chatHistory", "in-chat", "after"].map(identifier => ({ identifier, enabled: true })).concat([{ identifier: "disabled", enabled: false }]) }],
});

function setup(runtime: TestRuntime) {
  const kernel = runtime.kernel;
  kernel.setAgentModuleEnabled("mcp:memory-coordinator", true);
  kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
  const preset = kernel.importMeetingPreset({ name: "共用的创作预设", source: fixture() });
  const character = kernel.createCharacter({ name: "林澈", soulMarkdown: "OWNER_SOUL 细心而独立。", meetingPresetId: preset.id });
  const world = kernel.createWorld({ name: "河岸小城" });
  kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const source: DiarySource = { kind: "activity", id: "diary-preset-experience", characterId: character.id, characterName: character.name,
    worldId: world.id, worldName: world.name, timezone: "Asia/Shanghai", title: "书店的一天", occurredAt: "2026-09-07T02:00:00.000Z", soul: character.soulMarkdown,
    observations: ["我整理了新书。"], statements: [{ characterId: character.id, name: character.name, text: "我把新书整理好了。" }] };
  return { kernel, preset, character, world, source };
}

test("diaries share the preset library but have independent inherit/custom/none bindings", () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, preset, character } = setup(runtime);
    assert.equal(kernel.getCharacterDiary(character.id).settings.presetMode, "inherit");
    assert.equal(kernel.getCharacterDiary(character.id).activePreset?.id, preset.id);
    const custom = kernel.importMeetingPreset({ name: "独立日记文风", source: fixture() });
    kernel.characterDiaries.updateSettings(character.id, { narrativeEnabled: true, preset: "已有补充", presetMode: "custom", presetId: custom.id });
    assert.equal(kernel.getCharacterDiary(character.id).activePreset?.id, custom.id);
    assert.equal(kernel.getCharacter(character.id).meetingPresetId, preset.id);
    assert.throws(() => kernel.characterDiaries.updateSettings(character.id, { narrativeEnabled: true, preset: "", presetMode: "custom", presetId: "missing" }), /不存在/);
    kernel.deleteMeetingPreset(custom.id);
    assert.equal(kernel.getCharacterDiary(character.id).settings.presetId, null);
    assert.equal(kernel.getCharacterDiary(character.id).activePreset, null, "deleted explicit binding must not silently inherit another preset");
    assert.equal(kernel.getCharacterDiary(character.id).settings.preset, "已有补充");
    kernel.characterDiaries.updateSettings(character.id, { narrativeEnabled: true, preset: "", presetMode: "none" });
    assert.equal(kernel.getCharacterDiary(character.id).activePreset, null);
    kernel.characterDiaries.updateSettings(character.id, { narrativeEnabled: true, preset: "", presetMode: "inherit" });
    assert.equal(kernel.getCharacterDiary(character.id).activePreset?.id, preset.id);
    kernel.updateCharacter(character.id, { meetingPresetId: null });
    assert.equal(kernel.getCharacterDiary(character.id).activePreset, null);
  } finally { runtime.dispose(); }
});

test("only narrative jobs receive a shared preset; rewrites resolve the latest version without revising memory", async () => {
  const calls: Parameters<DiaryGenerator>[0][] = [];
  const runtime = createTestRuntime({ diaryGenerator: async input => {
    calls.push(input);
    return input.kind === "memory" ? { points: [{ kind: "fact", text: "我整理了新书。", evidence: "我整理了新书。" }], relationships: [] } : "我想记住书店的这一天。";
  } });
  try {
    const { kernel, preset, character, source } = setup(runtime);
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    assert.equal(calls.find(call => call.kind === "memory")?.narrativePreset, undefined);
    assert.equal(calls.find(call => call.kind === "narrative")?.narrativePreset?.id, preset.id);
    const before = kernel.characterDiaries.get(character.id, entry.id).memory;
    const prompt = preset.prompts.find(prompt => prompt.identifier === "before")!;
    kernel.updateMeetingPreset(preset.id, { prompts: [{ id: prompt.id, content: "新的共享文风" }] });
    kernel.characterDiaries.retry(character.id, entry.id, "narrative");
    await kernel.characterDiaries.drain();
    assert.match(JSON.stringify(calls.at(-1)!.narrativePreset), /新的共享文风/);
    assert.deepEqual(kernel.characterDiaries.get(character.id, entry.id).memory, before);
    assert.equal(calls.filter(call => call.kind === "memory").length, 1);
  } finally { runtime.dispose(); }
});

test("diary assembly reuses roles, order, in-chat placement and macros while supplying only owner-scoped slots", async () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, preset, character, source } = setup(runtime);
    kernel.updateUserProfile("GLOBAL_PROFILE_SECRET 用户的私事");
    const peer = kernel.createCharacter({ name: "顾遥", soulMarkdown: "OTHER_SOUL_SECRET" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "PRIVATE_CHAT_SECRET" }]);
    await kernel.sendMessage("private-history", { mode: "sms", characterId: character.id, text: "USER_THREAD_SECRET" });
    const payload = { messages: [{ role: "system", content: "MANDATORY_DIARY_CONTRACT" }, { role: "user", content: JSON.stringify(source) }] };
    const result = kernel.meetingPresetService.orchestrateDiaryPayload({ preset, source, payload });
    const messages = result.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]!.content, "MANDATORY_DIARY_CONTRACT");
    assert.ok(messages.some(message => message.role === "system" && /PRESET_BEFORE char=林澈 user=读者 tone=克制 date=2026\/09\/07 previous=我把新书整理好了。/.test(message.content)));
    assert.ok(messages.some(message => message.content === source.soul));
    const sourceIndex = messages.findIndex(message => message.content === JSON.stringify(source));
    const inChatIndex = messages.findIndex(message => message.content === "IN_CHAT");
    const afterIndex = messages.findIndex(message => message.role === "assistant" && message.content.includes("PRESET_AFTER"));
    assert.ok(sourceIndex > 0 && inChatIndex > sourceIndex && afterIndex > inChatIndex);
    assert.doesNotMatch(JSON.stringify(result), /GLOBAL_PROFILE_SECRET|OTHER_SOUL_SECRET|PRIVATE_CHAT_SECRET|USER_THREAD_SECRET|DISABLED_SENTINEL|PRIVATE_EXTENSION_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(peer.id));
    const noHistory = { ...preset, prompts: preset.prompts.map(prompt => ({ ...prompt, enabled: prompt.identifier !== "chatHistory" && prompt.enabled })) };
    const missingMarker = kernel.meetingPresetService.orchestrateDiaryPayload({ preset: noHistory, source, payload });
    assert.ok((missingMarker.messages as Array<{ content: string }>).some(message => message.content === JSON.stringify(source)), "a disabled marker cannot erase confirmed source");
  } finally { runtime.dispose(); }
});

test("diary provider payload uses shared preset parameters only for narrative and keeps the output ceiling", async () => {
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const memory = JSON.stringify(body.messages).includes("Produce a compact memory from SOURCE ONLY");
    const content = memory ? JSON.stringify({ points: [{ kind: "fact", text: "我整理了新书。", evidence: "我整理了新书。" }], relationships: [] }) : "我把今天记了下来。";
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of [{ role: "assistant", content }, {}]) response.write(`data: ${JSON.stringify({ id: "diary-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: part, finish_reason: "content" in part ? null : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const runtime = createTestRuntime();
  try {
    const { kernel, preset, character, source } = setup(runtime);
    const address = server.address(); assert.ok(address && typeof address === "object");
    kernel.patchModelApiConfig({ enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "mlx-community/Qwen3-8B-4bit" });
    const entry = kernel.characterDiaries.capture(source);
    await kernel.characterDiaries.drain();
    assert.ok(kernel.characterDiaries.get(character.id, entry.id).jobs.every(job => job.status === "ready"));
    assert.equal(requests.length, 2);
    const memory = requests[0]!; const narrative = requests[1]!;
    assert.equal(memory.temperature, 0); assert.equal(memory.max_tokens, 2400); assert.equal(memory.top_p, undefined);
    assert.doesNotMatch(JSON.stringify(memory), /PRESET_BEFORE|PRESET_AFTER/);
    assert.equal(narrative.temperature, 0.65); assert.equal(narrative.top_p, 0.8);
    assert.equal(narrative.frequency_penalty, 0.15); assert.equal(narrative.presence_penalty, -0.2); assert.equal(narrative.seed, 42);
    assert.equal(narrative.max_tokens, 6000); assert.equal(narrative.chat_template_kwargs.enable_thinking, false);
    assert.match(JSON.stringify(narrative), /PRESET_BEFORE char=林澈 user=读者/);
    assert.ok(requests.every(request => !request.tools?.length));
    kernel.updateMeetingPreset(preset.id, { parametersEnabled: false });
    kernel.characterDiaries.retry(character.id, entry.id, "narrative");
    await kernel.characterDiaries.drain();
    assert.equal(requests[2]!.temperature, 0.7); assert.equal(requests[2]!.top_p, undefined); assert.equal(requests[2]!.seed, undefined);
    assert.match(JSON.stringify(requests[2]), /PRESET_BEFORE/);
  } finally { runtime.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("schema 52 migration preserves old diary instructions and enables inheritance only without existing custom text", () => {
  const dir = mkdtempSync(join(tmpdir(), "yourchar-diary-presets-migration-"));
  try {
    const path = join(dir, "state.sqlite");
    const legacy = new AppDatabase(path, { maxMigrationVersion: 52 });
    for (const id of ["custom", "default"]) legacy.connection.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, id, "2026-09-07", "2026-09-07");
    legacy.connection.prepare("INSERT INTO character_diary_settings VALUES (?,?,?,?)").run("custom", 0, "我之前精心写的文风", "2026-09-07");
    legacy.connection.prepare("INSERT INTO character_diary_settings VALUES (?,?,?,?)").run("default", 1, "", "2026-09-07");
    legacy.close();
    const current = new AppDatabase(path);
    try {
      const old = current.connection.prepare("SELECT * FROM character_diary_settings WHERE character_id='custom'").get()!;
      assert.equal(old.preset, "我之前精心写的文风"); assert.equal(old.narrative_enabled, 0); assert.equal(old.preset_mode, "none");
      assert.equal(current.connection.prepare("SELECT preset_mode FROM character_diary_settings WHERE character_id='default'").get()!.preset_mode, "inherit");
      assert.equal(current.connection.prepare("SELECT max(version) AS v FROM schema_migrations").get()!.v, 61);
    } finally { current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diary preset bindings persist and HTTP settings reject invalid choices without affecting the meeting binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yourchar-diary-presets-restart-"));
  const runtime = createTestRuntime({ stateDir: dir });
  const { kernel, character, preset } = setup(runtime);
  const server = createHttpServer({ kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const cookie = (await fetch(origin)).headers.get("set-cookie")!.split(";", 1)[0]!;
    const headers = { "content-type": "application/json", origin, cookie };
    const url = `${origin}/api/v1/characters/${character.id}/diary/settings`;
    for (const fields of [{ presetMode: "invalid" }, { presetMode: null }, { presetMode: "custom", presetId: "missing" }]) {
      const response = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ narrativeEnabled: true, preset: "", ...fields }) });
      assert.equal(response.status, 400);
    }
    const response = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ narrativeEnabled: true, preset: "补充", presetMode: "custom", presetId: preset.id }) });
    assert.equal(response.status, 200);
    assert.equal(kernel.getCharacter(character.id).meetingPresetId, preset.id);
    assert.equal(kernel.characterDiaries.exportForCharacter(character.id).settings.presetId, preset.id);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.dispose(); }
  const second = createTestRuntime({ stateDir: dir, seed: "diary-preset-reopened" });
  try {
    assert.equal(second.kernel.getCharacterDiary(character.id).settings.presetId, preset.id);
    assert.equal(second.kernel.getCharacterDiary(character.id).settings.presetMode, "custom");
  } finally { second.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
