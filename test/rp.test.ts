import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionKernel } from "../src/domain/index.js";
import { AppDatabase } from "../src/storage/database.js";
import { ScriptedModelController, createTestRuntime } from "../src/testing/index.js";

test("character, scene, and confirmed memory survive restart and enter Pi context", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-rp-"));
  const clock = new VirtualClock("2026-07-12T09:00:00.000Z");
  try {
    const first = new CompanionKernel({
      stateDir,
      clock,
      idGenerator: new SeededIdGenerator("continuity"),
      startScheduler: false,
    });
    const character = first.createCharacter({
      name: "林澈",
      identity: "住在同一座城市的长期伙伴",
      voice: "克制、敏锐",
      narrativePerspective: "third_person",
      behavior: "尊重用户边界",
      relationshipDefaults: "彼此信任",
      boundaries: ["不替用户做现实决定"],
    });
    const soulPath = join(stateDir, "characters", character.id, "SOUL.md");
    assert.match(character.soulMarkdown, /住在同一座城市的长期伙伴/);
    assert.equal(readFileSync(soulPath, "utf8"), character.soulMarkdown);
    assert.equal(statSync(soulPath).mode & 0o777, 0o600);
    first.rpService.ensureRoleSession("continuity-session", character.id);
    first.updateScene("continuity-session", {
      location: "旧书店",
      summary: "两人正在整理旅行照片。",
      openThreads: ["挑选下一次旅行地点"],
    });
    first.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      key: "relationship.shared_music",
      content: "两人约定整理旅行照片时播放爵士乐",
      characterId: character.id,
      confirmed: true,
      salience: 0.9,
    });
    first.dispose();

    const model = new ScriptedModelController("restart-context");
    model.enqueue([{ kind: "assistant_text", text: "她记得这件事。" }]);
    const second = new CompanionKernel({
      stateDir,
      clock,
      idGenerator: new SeededIdGenerator("restart"),
      modelResolver: model.resolver,
      startScheduler: false,
    });
    second.patchModelApiConfig({ enabled: true, baseUrl: "http://test.invalid/v1", model: "scripted" });
    const response = await second.sendMessage("continuity-session", {
      mode: "rp",
      characterId: character.id,
      text: "你还记得我们整理照片时的约定吗？",
    });

    assert.equal(response.reply, "她记得这件事。");
    assert.match(model.requests[0].systemPrompt, /Character: 林澈/);
    assert.match(model.requests[0].systemPrompt, /Character SOUL\.md/);
    assert.match(model.requests[0].systemPrompt, /克制、敏锐/);
    assert.match(JSON.stringify(model.requests[0].messages), /旧书店/);
    assert.match(JSON.stringify(model.requests[0].messages), /播放爵士乐/);
    assert.doesNotMatch(model.requests[0].systemPrompt, /旧书店|播放爵士乐/);
    assert.ok(second.rpService.listAllMemories()[0].lastUsedAt);
    second.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("legacy structured characters lazily migrate to per-character SOUL.md", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-legacy-soul-"));
  const databasePath = join(stateDir, "rp-agent.sqlite");
  try {
    const database = new AppDatabase(databasePath);
    database.connection.prepare(`
      INSERT INTO characters(
        id, name, identity, voice, narrative_perspective, behavior,
        relationship_defaults, boundaries_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "character_legacy",
      "旧角色",
      "守护一座旧图书馆",
      "温和但不含糊",
      "first_person",
      "先倾听再回应",
      "与用户是多年好友",
      JSON.stringify(["不替用户作决定"]),
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    );
    database.close();

    const kernel = new CompanionKernel({ stateDir, startScheduler: false });
    const character = kernel.getCharacter("character_legacy");
    assert.match(character.soulMarkdown, /守护一座旧图书馆/);
    assert.match(character.soulMarkdown, /温和但不含糊/);
    assert.match(character.soulMarkdown, /第一人称/);
    const soulPath = join(stateDir, "characters", character.id, "SOUL.md");
    assert.equal(readFileSync(soulPath, "utf8"), character.soulMarkdown);

    await kernel.deleteAllUserData();
    assert.equal(existsSync(join(stateDir, "characters")), false);
    kernel.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("memory conflicts require confirmation and confirmed corrections supersede old facts", () => {
  const runtime = createTestRuntime({ now: "2026-07-12T09:00:00.000Z", seed: "memory-conflict" });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈" });
    const first = runtime.kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "world.safehouse.drink",
      content: "安全屋吧台固定供应咖啡",
      characterId: character.id,
      confirmed: true,
    });
    const conflict = runtime.kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "world.safehouse.drink",
      content: "安全屋吧台固定供应茶",
      characterId: character.id,
      confirmed: false,
    });
    assert.equal(conflict.needsConfirmation, true);
    assert.equal(runtime.kernel.rpService.listAllMemories().length, 1);

    const correction = runtime.kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "world.safehouse.drink",
      content: "安全屋吧台固定供应茶",
      characterId: character.id,
      confirmed: true,
    });
    assert.equal(correction.memory?.validity, "active");
    assert.equal(runtime.kernel.rpService.getMemory(first.memory!.id).validity, "superseded");
    assert.equal(runtime.kernel.searchRpMemories({ characterId: character.id, confirmedOnly: true })[0].content, "安全屋吧台固定供应茶");
  } finally {
    runtime.dispose();
  }
});

test("RP real reminders require a persisted explicit confirmation", async () => {
  const runtime = createTestRuntime({ now: "2026-07-12T09:00:00.000Z", seed: "rp-confirm" });
  try {
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "5分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "这会创建现实提醒，请先确认。" },
    ]);
    const first = await runtime.kernel.sendMessage("rp-confirm", {
      mode: "rp",
      text: "5分钟后提醒我喝水",
    });
    assert.match(first.reply, /请先确认/);
    assert.equal(first.actions[0].actionType, "request_real_world_confirmation");
    assert.equal(runtime.kernel.listScheduleItems().length, 0);

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "5分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "现实提醒已经创建。" },
    ]);
    const confirmed = await runtime.kernel.sendMessage("rp-confirm", {
      mode: "rp",
      text: "确认创建现实提醒",
    });
    assert.equal(confirmed.reply, "现实提醒已经创建。");
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.deepEqual(
      runtime.kernel.rpService.repository.listPendingMutations().map((entry) => entry.status),
      ["executed"],
    );
  } finally {
    runtime.dispose();
  }
});

test("Pi tool policy blocks unconfirmed real schedule mutation in RP", async () => {
  const runtime = createTestRuntime({ now: "2026-07-12T09:00:00.000Z", seed: "rp-policy" });
  try {
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "event",
          title: "剧情晚宴",
          startAt: "2026-07-12T10:00:00.000Z",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "这只是剧情安排。" },
    ]);
    const response = await runtime.kernel.sendMessage("rp-policy", {
      mode: "rp",
      text: "把剧情里的晚宴安排一下",
    });
    assert.equal(response.reply, "这只是剧情安排。");
    assert.equal(runtime.kernel.listScheduleItems().length, 0);
    assert.equal(response.actions[0].actionType, "request_real_world_confirmation");
    assert.equal(runtime.kernel.rpService.repository.listPendingMutations()[0].status, "pending");

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "event",
          title: "现实晚宴",
          startAt: "2026-07-12T10:00:00.000Z",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "现实日程已经创建。" },
    ]);
    const confirmed = await runtime.kernel.sendMessage("rp-policy", {
      mode: "rp",
      text: "确认执行现实操作",
    });
    assert.equal(confirmed.reply, "现实日程已经创建。");
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.equal(runtime.kernel.rpService.repository.listPendingMutations()[0].status, "executed");
  } finally {
    runtime.dispose();
  }
});

test("RP can maintain the selected character calendar without requesting a real-world confirmation", async () => {
  const runtime = createTestRuntime({ now: "2026-07-12T09:00:00.000Z", seed: "rp-character-calendar" });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          calendar: "character",
          kind: "event",
          title: "傍晚去河岸",
          startAt: "2026-07-12T10:00:00.000Z",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "她把傍晚去河岸的安排记了下来。" },
    ]);
    const response = await runtime.kernel.sendMessage("rp-character-calendar", {
      mode: "rp",
      characterId: character.id,
      text: "记下你傍晚要去河岸",
    });
    assert.equal(response.reply, "她把傍晚去河岸的安排记了下来。");
    const items = runtime.kernel.listScheduleItems({ ownerType: "character", characterId: character.id });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "傍晚去河岸");
    assert.equal(runtime.kernel.rpService.repository.listPendingMutations().length, 0);
    assert.match(runtime.model.requests[0].systemPrompt, /calendar=character/);
    assert.match(runtime.model.requests[0].systemPrompt, /绝不触发现实通知/);
    assert.match(runtime.model.requests[0].systemPrompt, /workspace:相对路径/);
  } finally {
    runtime.dispose();
  }
});

test("Pi update_scene tool persists meaningful RP transitions idempotently", async () => {
  const runtime = createTestRuntime({ now: "2026-07-12T09:00:00.000Z", seed: "scene-tool" });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        id: "same-scene-tool",
        name: "update_scene",
        arguments: {
          location: "河岸",
          summary: "两人结束散步，准备回家。",
          openThreads: ["归还借来的书"],
        },
      },
      { kind: "assistant_text", text: "她在河岸停下脚步。" },
    ]);
    await runtime.kernel.sendMessage("scene-tool", {
      mode: "rp",
      characterId: character.id,
      text: "我们走到河岸，准备回家。",
    });
    assert.equal(runtime.kernel.getScene("scene-tool").location, "河岸");
    assert.equal(runtime.kernel.getScene("scene-tool").openThreads[0], "归还借来的书");
  } finally {
    runtime.dispose();
  }
});
