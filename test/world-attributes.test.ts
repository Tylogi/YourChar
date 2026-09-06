import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/index.js";
import { WorldRepository, WorldValidationError } from "../src/world/index.js";

test("schema 44 world attributes migrate disabled into separate post-turn rules", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-world-attribute-v46-"));
  const path = join(root, "state.sqlite");
  try {
    const legacy = new AppDatabase(path, { maxMigrationVersion: 44 });
    legacy.connection.prepare(`
      INSERT INTO role_worlds(
        id, name, timezone, description, rules_markdown,
        director_model_profile_id, analyst_model_profile_id,
        status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, '', '', NULL, NULL, 'active', 1, ?, ?)
    `).run("world-v44", "旧世界", "Asia/Shanghai", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    legacy.connection.prepare(`
      INSERT INTO world_attribute_definitions(
        id, world_id, attribute_key, name, description,
        min_value, max_value, default_value,
        agent_mutable, agent_can_increase, agent_can_decrease, agent_max_delta,
        visible_to_agent, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', 0, 100, 20, 1, 1, 1, 9, 1, 'active', ?, ?)
    `).run(
      "attribute-v44",
      "world-v44",
      "legacy_score",
      "旧数值",
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    );
    legacy.close();

    const migrated = new AppDatabase(path);
    try {
      const version = migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      assert.equal(Number(version.version), 53);
      const definition = new WorldRepository(migrated).getAttributeDefinition("attribute-v44");
      assert.ok(definition);
      assert.equal(definition.analysisEnabled, false);
      assert.equal(definition.increaseRule, "");
      assert.equal(definition.increaseDelta, 1);
      assert.equal(definition.decreaseRule, "");
      assert.equal(definition.decreaseDelta, 1);
      assert.equal(definition.scope, "character");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("world attribute control-plane routes require the local UI capability", async () => {
  const runtime = createTestRuntime({ seed: "world-attribute-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const character = runtime.kernel.createCharacter({ name: "HTTP 属性角色" });
    const world = runtime.kernel.createWorld({ name: "HTTP 世界" });
    runtime.kernel.assignCharacterWorld(character.id, { worldId: world.id });

    const rejected = await fetch(`${origin}/api/v1/worlds/${world.id}/attributes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        key: "rank", name: "等级", minValue: 0, maxValue: 10, defaultValue: 1,
      }),
    });
    assert.equal(rejected.status, 403);

    const page = await fetch(`${origin}/`);
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const created = await fetch(`${origin}/api/v1/worlds/${world.id}/attributes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        key: "rank", name: "等级", minValue: 0, maxValue: 10, defaultValue: 1,
        analysisEnabled: true,
        increaseRule: "完成公开任务",
        increaseDelta: 2,
        decreaseRule: "被证实任务失败",
        decreaseDelta: 3,
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as {
      attribute: {
        id: string;
        analysisEnabled: boolean;
        increaseRule: string;
        increaseDelta: number;
        decreaseRule: string;
        decreaseDelta: number;
      };
    };
    assert.deepEqual({
      analysisEnabled: createdBody.attribute.analysisEnabled,
      increaseRule: createdBody.attribute.increaseRule,
      increaseDelta: createdBody.attribute.increaseDelta,
      decreaseRule: createdBody.attribute.decreaseRule,
      decreaseDelta: createdBody.attribute.decreaseDelta,
    }, {
      analysisEnabled: true,
      increaseRule: "完成公开任务",
      increaseDelta: 2,
      decreaseRule: "被证实任务失败",
      decreaseDelta: 3,
    });
    const patched = await fetch(`${origin}/api/v1/world-attributes/${createdBody.attribute.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ decreaseRule: "", increaseDelta: 4 }),
    });
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json() as { attribute: { decreaseRule: string; increaseDelta: number } };
    assert.equal(patchedBody.attribute.decreaseRule, "");
    assert.equal(patchedBody.attribute.increaseDelta, 4);
    const rejectedScopeChange = await fetch(`${origin}/api/v1/world-attributes/${createdBody.attribute.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ scope: "world" }),
    });
    assert.equal(rejectedScopeChange.status, 400);
    const changed = await fetch(`${origin}/api/v1/characters/${character.id}/life/attributes`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ values: { rank: 7 } }),
    });
    assert.equal(changed.status, 200);
    const body = await changed.json() as { life: { attributes: Array<{ key: string; value: number }> } };
    assert.equal(body.life.attributes.find((entry) => entry.key === "rank")?.value, 7);

    const sharedCreated = await fetch(`${origin}/api/v1/worlds/${world.id}/attributes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        key: "world_heat", name: "世界热度", scope: "world",
        minValue: 0, maxValue: 100, defaultValue: 20,
      }),
    });
    assert.equal(sharedCreated.status, 201);
    const sharedChanged = await fetch(`${origin}/api/v1/worlds/${world.id}/attributes`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ values: { world_heat: 36 } }),
    });
    assert.equal(sharedChanged.status, 200);
    const sharedBody = await sharedChanged.json() as {
      worldAttributes: { attributes: Array<{ key: string; scope: string; value: number }> };
    };
    assert.deepEqual(
      sharedBody.worldAttributes.attributes.map(({ key, scope, value }) => ({ key, scope, value })),
      [{ key: "world_heat", scope: "world", value: 36 }],
    );
    const fetchedWorld = await fetch(`${origin}/api/v1/worlds/${world.id}`);
    assert.equal(fetchedWorld.status, 200);
    const fetchedWorldBody = await fetchedWorld.json() as {
      worldAttributes: Array<{ key: string; value: number }>;
    };
    assert.equal(fetchedWorldBody.worldAttributes[0]?.value, 36);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
  }
});

test("world-shared values and character values remain independent", () => {
  const runtime = createTestRuntime({ seed: "world-attribute-scopes" });
  try {
    const firstCharacter = runtime.kernel.createCharacter({ name: "甲角色" });
    const secondCharacter = runtime.kernel.createCharacter({ name: "乙角色" });
    const world = runtime.kernel.createWorld({ name: "双层数值世界" });
    const shared = runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "world_stability",
      name: "世界稳定度",
      scope: "world",
      minValue: 0,
      maxValue: 100,
      defaultValue: 40,
    });
    const personal = runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "reputation",
      name: "个人声望",
      scope: "character",
      minValue: -20,
      maxValue: 20,
      defaultValue: 0,
    });
    runtime.kernel.assignCharacterWorld(firstCharacter.id, { worldId: world.id });
    runtime.kernel.assignCharacterWorld(secondCharacter.id, { worldId: world.id });

    runtime.kernel.updateWorldSharedAttributes(world.id, { world_stability: 55 });
    runtime.kernel.updateCharacterWorldAttributes(firstCharacter.id, { reputation: 8 });

    const firstLife = runtime.kernel.getCharacterLife(firstCharacter.id);
    const secondLife = runtime.kernel.getCharacterLife(secondCharacter.id);
    assert.equal(firstLife.worldAttributes[0]?.value, 55);
    assert.equal(secondLife.worldAttributes[0]?.value, 55);
    assert.equal(firstLife.attributes[0]?.value, 8);
    assert.equal(secondLife.attributes[0]?.value, 0);
    assert.equal(firstLife.worldAttributes[0]?.scope, "world");
    assert.equal(firstLife.attributes[0]?.scope, "character");
    assert.equal(firstLife.attributeEvents.length, 1);
    assert.equal(runtime.kernel.getWorld(world.id).worldAttributeEvents[0]?.attributeScope, "world");
    assert.equal(runtime.kernel.getWorld(world.id).worldAttributeEvents[0]?.characterId, undefined);

    assert.throws(
      () => runtime.kernel.updateCharacterWorldAttributes(firstCharacter.id, { world_stability: 60 }),
      /World Card/,
    );
    assert.throws(
      () => runtime.kernel.updateWorldSharedAttributes(world.id, { reputation: 3 }),
      /character panel/,
    );

    assert.throws(() => runtime.kernel.database.connection.prepare(`
      INSERT INTO character_world_attribute_values(
        world_id, character_id, attribute_id, value, updated_at
      ) VALUES (?, ?, ?, 1, ?)
    `).run(world.id, firstCharacter.id, shared.id, "2026-08-23T00:00:00.000Z"), /character scope/);
    assert.throws(() => runtime.kernel.database.connection.prepare(`
      INSERT INTO world_attribute_values(world_id, attribute_id, value, updated_at)
      VALUES (?, ?, 1, ?)
    `).run(world.id, personal.id, "2026-08-23T00:00:00.000Z"), /world scope/);
    assert.throws(() => runtime.kernel.database.connection.prepare(`
      UPDATE world_attribute_definitions SET value_scope = 'character' WHERE id = ?
    `).run(shared.id), /scope is immutable/);
    assert.throws(() => runtime.kernel.database.connection.prepare(`
      INSERT INTO world_attribute_events(
        id, world_id, character_id, attribute_id, source, requested_delta,
        applied_delta, before_value, after_value, idempotency_key, created_at
      ) VALUES ('bad-character-event', ?, NULL, ?, 'system', 1, 1, 0, 1, 'bad-character-event', ?)
    `).run(world.id, personal.id, "2026-08-23T00:00:00.000Z"), /requires character/);
  } finally {
    runtime.dispose();
  }
});

test("world attributes preserve a separate character value in each world", () => {
  const runtime = createTestRuntime({ seed: "world-attribute-switch" });
  try {
    const character = runtime.kernel.createCharacter({ name: "世界属性角色" });
    const first = runtime.kernel.createWorld({ name: "学院世界" });
    const second = runtime.kernel.createWorld({ name: "都市世界" });
    runtime.kernel.createWorldAttribute({
      worldId: first.id,
      key: "reputation",
      name: "学院声望",
      minValue: 0,
      maxValue: 100,
      defaultValue: 10,
    });
    runtime.kernel.createWorldAttribute({
      worldId: second.id,
      key: "reputation",
      name: "都市声望",
      minValue: -20,
      maxValue: 20,
      defaultValue: 0,
    });

    runtime.kernel.assignCharacterWorld(character.id, { worldId: first.id });
    let life = runtime.kernel.updateCharacterWorldAttributes(character.id, { reputation: 72 });
    assert.equal(life.attributes[0].value, 72);
    assert.equal(life.attributeEvents[0].source, "user_control");

    runtime.kernel.assignCharacterWorld(character.id, { worldId: second.id });
    life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes[0].value, 0);
    runtime.kernel.updateCharacterWorldAttributes(character.id, { reputation: -7 });

    runtime.kernel.assignCharacterWorld(character.id, { worldId: first.id });
    life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes[0].value, 72);
    assert.equal(life.attributeEvents[0].afterValue, 72);
    assert.equal(runtime.kernel.getWorld(first.id).attributeDefinitions[0].key, "reputation");
  } finally {
    runtime.dispose();
  }
});

test("world attribute definitions enforce range, count and safe range edits", () => {
  const runtime = createTestRuntime({ seed: "world-attribute-validation" });
  try {
    const character = runtime.kernel.createCharacter({ name: "规则角色" });
    const world = runtime.kernel.createWorld({ name: "规则世界" });
    const attribute = runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "rank",
      name: "等级",
      minValue: 0,
      maxValue: 10,
      defaultValue: 1,
    });
    runtime.kernel.assignCharacterWorld(character.id, { worldId: world.id });
    runtime.kernel.updateCharacterWorldAttributes(character.id, { rank: 9 });
    assert.throws(
      () => runtime.kernel.updateWorldAttribute(attribute.id, { maxValue: 8 }),
      (error) => error instanceof WorldValidationError && /outside/.test(error.message),
    );
    assert.throws(
      () => runtime.kernel.updateCharacterWorldAttributes(character.id, { rank: 11 }),
      (error) => error instanceof WorldValidationError,
    );
    for (let index = 1; index < 8; index += 1) {
      runtime.kernel.createWorldAttribute({
        worldId: world.id,
        key: `value_${index}`,
        name: `数值 ${index}`,
        minValue: 0,
        maxValue: 100,
        defaultValue: 0,
      });
    }
    assert.throws(
      () => runtime.kernel.createWorldAttribute({
        worldId: world.id,
        key: "ninth",
        name: "第九项",
        minValue: 0,
        maxValue: 1,
        defaultValue: 0,
      }),
      /at most 8/,
    );
  } finally {
    runtime.dispose();
  }
});

test("trusted attribute settlement rejects forged evidence and stale rules and is idempotent", () => {
  const runtime = createTestRuntime({ seed: "world-attribute-trust" });
  try {
    const character = runtime.kernel.createCharacter({ name: "可信结算角色" });
    const world = runtime.kernel.createWorld({ name: "可信结算世界" });
    const definition = runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "discipline",
      name: "纪律",
      minValue: 0,
      maxValue: 100,
      defaultValue: 10,
      analysisEnabled: true,
      increaseRule: "角色按承诺完成训练",
      increaseDelta: 3,
      decreaseRule: "角色无故逃避已确认的训练",
      decreaseDelta: 6,
    });
    runtime.kernel.assignCharacterWorld(character.id, { worldId: world.id });
    const snapshot = runtime.kernel.worldService.attributeAnalysisContext(character.id);
    assert.ok(snapshot);
    const decision = {
      characterId: character.id,
      key: "discipline",
      direction: "increase" as const,
      summary: "完成训练",
      evidence: "今天的训练已经完成",
      confidence: 0.92,
    };

    const forged = runtime.kernel.worldService.applyAttributeAnalysis({
      context: snapshot,
      decisions: [decision],
      source: "post_turn_analysis",
      sourceReferenceId: "forged-turn",
      evidenceTexts: ["这里只有不相干的文本"],
    });
    assert.deepEqual(forged, []);

    const applied = runtime.kernel.worldService.applyAttributeAnalysis({
      context: snapshot,
      decisions: [decision],
      source: "post_turn_analysis",
      sourceReferenceId: "valid-turn",
      evidenceTexts: ["我确认，今天的训练已经完成。"],
    });
    assert.equal(applied.length, 1);
    const replayed = runtime.kernel.worldService.applyAttributeAnalysis({
      context: snapshot,
      decisions: [decision],
      source: "post_turn_analysis",
      sourceReferenceId: "valid-turn",
      evidenceTexts: ["今天的训练已经完成"],
    });
    assert.equal(replayed[0]?.id, applied[0]?.id);
    assert.equal(runtime.kernel.getCharacterLife(character.id).attributes[0]?.value, 13);
    assert.equal(runtime.kernel.getCharacterLife(character.id).attributeEvents.length, 1);

    runtime.kernel.updateWorldAttribute(definition.id, { increaseRule: "完成两次训练" });
    const stale = runtime.kernel.worldService.applyAttributeAnalysis({
      context: snapshot,
      decisions: [decision],
      source: "post_turn_analysis",
      sourceReferenceId: "stale-turn",
      evidenceTexts: ["今天的训练已经完成"],
    });
    assert.deepEqual(stale, []);
    assert.equal(runtime.kernel.getCharacterLife(character.id).attributes[0]?.value, 13);
  } finally {
    runtime.dispose();
  }
});

test("analysis applies fixed per-hit steps and records boundary clamping", () => {
  const runtime = createTestRuntime({ seed: "world-attribute-fixed-steps" });
  try {
    const character = runtime.kernel.createCharacter({ name: "数值结算角色" });
    const world = runtime.kernel.createWorld({ name: "固定步长世界" });
    runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "world_pressure",
      name: "世界压力",
      scope: "world",
      minValue: 0,
      maxValue: 100,
      defaultValue: 98,
      analysisEnabled: true,
      increaseRule: "确认发生全局危机",
      increaseDelta: 5,
      decreaseRule: "确认全局危机解除",
      decreaseDelta: 9,
    });
    runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "personal_energy",
      name: "个人精力",
      scope: "character",
      minValue: 0,
      maxValue: 100,
      defaultValue: 3,
      analysisEnabled: true,
      increaseRule: "角色得到充分休息",
      increaseDelta: 7,
      decreaseRule: "角色完成高强度行动",
      decreaseDelta: 5,
    });
    runtime.kernel.assignCharacterWorld(character.id, { worldId: world.id });
    const context = runtime.kernel.worldService.attributeAnalysisContext(character.id);
    assert.ok(context);
    const decisions = [
      {
        characterId: character.id,
        key: "world_pressure",
        direction: "increase" as const,
        summary: "危机发生",
        evidence: "确认发生全局危机",
        confidence: 0.9,
      },
      {
        characterId: character.id,
        key: "personal_energy",
        direction: "decrease" as const,
        summary: "完成行动",
        evidence: "角色完成高强度行动",
        confidence: 0.9,
      },
    ];
    const applied = runtime.kernel.worldService.applyAttributeAnalysis({
      context,
      decisions,
      source: "post_turn_analysis",
      sourceReferenceId: "fixed-step-turn",
      evidenceTexts: ["确认发生全局危机；角色完成高强度行动。"],
    });
    assert.equal(applied.length, 2);
    const sharedEvent = applied.find((event) => event.attributeScope === "world");
    const personalEvent = applied.find((event) => event.attributeScope === "character");
    assert.equal(sharedEvent?.requestedDelta, 5);
    assert.equal(sharedEvent?.appliedDelta, 2);
    assert.equal(sharedEvent?.afterValue, 100);
    assert.equal(personalEvent?.requestedDelta, -5);
    assert.equal(personalEvent?.appliedDelta, -3);
    assert.equal(personalEvent?.afterValue, 0);

    const replayed = runtime.kernel.worldService.applyAttributeAnalysis({
      context,
      decisions,
      source: "post_turn_analysis",
      sourceReferenceId: "fixed-step-turn",
      evidenceTexts: ["确认发生全局危机；角色完成高强度行动。"],
    });
    assert.deepEqual(replayed.map((event) => event.id), applied.map((event) => event.id));
    assert.equal(runtime.kernel.getWorld(world.id).worldAttributes[0]?.value, 100);
    assert.equal(runtime.kernel.getCharacterLife(character.id).attributes[0]?.value, 0);
  } finally {
    runtime.dispose();
  }
});

test("a committed character World action is trusted post-turn evidence", async () => {
  let characterId = "";
  let completedWorldActions: unknown;
  const runtime = createTestRuntime({
    seed: "world-attribute-action",
    postTurnAnalyzer: async (input) => {
      completedWorldActions = input.completedWorldActions;
      return {
        relationship: { significant: false, confidence: 0 },
        interaction: { decision: "not_applicable", confidence: 0, reasonCode: "none" },
        worldAttributes: [{
          characterId,
          key: "discipline",
          direction: "increase",
          summary: "完成规定训练",
          evidence: "角色完成了规定训练",
          confidence: 0.94,
        }],
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "行动结算角色" });
    characterId = character.id;
    const world = runtime.kernel.createWorld({ name: "行动结算世界" });
    const gym = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "训练场",
      capabilityIds: ["exercise"],
    });
    runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "discipline",
      name: "纪律",
      minValue: 0,
      maxValue: 100,
      defaultValue: 10,
      analysisEnabled: true,
      increaseRule: "角色完成规定训练",
      increaseDelta: 2,
      decreaseRule: "角色逃避规定训练",
      decreaseDelta: 5,
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      currentPlaceId: gym.id,
    });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "perform_place_action",
        arguments: {
          placeId: gym.id,
          capabilityId: "exercise",
          summary: "角色完成了规定训练",
        },
      },
      { kind: "assistant_text", text: "做完了。" },
    ]);
    const result = await runtime.kernel.sendMessage("world-action-analysis-session", {
      mode: "sms",
      characterId: character.id,
      text: "去训练吧。",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.actions.some((action) => action.actionType === "perform_place_action"), true);
    await runtime.kernel.postTurnCoordinator.drain();
    assert.deepEqual(completedWorldActions, [{
      actionType: "perform_place_action",
      eventId: runtime.kernel.getCharacterLife(character.id).events[0]?.id,
      summary: "角色完成了规定训练",
      capabilityId: "exercise",
      placeId: gym.id,
    }]);
    const life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes[0]?.value, 12);
    assert.equal(life.attributeEvents[0]?.evidence, "角色完成了规定训练");
  } finally {
    runtime.dispose();
  }
});

test("completed private turns apply separate trusted increase and decrease rules", async () => {
  let analysisCount = 0;
  let analyzedCharacterId = "";
  const runtime = createTestRuntime({
    seed: "world-attribute-analysis",
    postTurnAnalyzer: async () => {
      analysisCount += 1;
      return {
        relationship: { significant: false, confidence: 0 },
        interaction: { decision: "not_applicable", confidence: 0, reasonCode: "none" },
        worldAttributes: analysisCount === 1
          ? [{
              characterId: analyzedCharacterId,
              key: "reputation",
              direction: "increase",
              summary: "完成公开委托",
              evidence: "公开委托已经完成",
              confidence: 0.95,
              delta: 999,
            }]
          : [{
              characterId: analyzedCharacterId,
              key: "reputation",
              direction: "decrease",
              summary: "公开违约",
              evidence: "公开违约已经被证实",
              confidence: 0.95,
              delta: -999,
            }],
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "行动角色" });
    analyzedCharacterId = character.id;
    const world = runtime.kernel.createWorld({ name: "声望世界" });
    runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "reputation",
      name: "声望",
      description: "由可信的世界事件改变。",
      minValue: 0,
      maxValue: 100,
      defaultValue: 20,
      analysisEnabled: true,
      increaseRule: "角色在本回合明确完成一次公开委托",
      increaseDelta: 4,
      decreaseRule: "角色在本回合被证实公开违约",
      decreaseDelta: 7,
      visibleToAgent: true,
    });
    runtime.kernel.createWorldAttribute({
      worldId: world.id,
      key: "hidden_score",
      name: "隐藏分",
      minValue: 0,
      maxValue: 100,
      defaultValue: 50,
      visibleToAgent: false,
    });
    runtime.kernel.assignCharacterWorld(character.id, { worldId: world.id });

    runtime.model.enqueue([{ kind: "assistant_text", text: "公开委托已经完成。" }]);
    const increased = await runtime.kernel.sendMessage("world-attribute-session", {
      mode: "sms",
      characterId: character.id,
      text: "公开委托已经完成。",
    });
    assert.equal(increased.status, "completed");
    await runtime.kernel.postTurnCoordinator.drain();
    let life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes.find((entry) => entry.key === "reputation")?.value, 24);
    assert.equal(life.attributeEvents[0].appliedDelta, 4);
    assert.equal(life.attributeEvents[0].source, "post_turn_analysis");
    assert.equal(life.attributeEvents[0].analysisDirection, "increase");
    assert.match(JSON.stringify(runtime.model.requests[0].messages), /reputation/);
    assert.doesNotMatch(JSON.stringify(runtime.model.requests[0].messages), /hidden_score/);
    assert.equal(runtime.model.requests[0].toolNames.includes("adjust_world_attribute"), false);

    runtime.model.enqueue([{ kind: "assistant_text", text: "公开违约已经被证实。" }]);
    const decreased = await runtime.kernel.sendMessage("world-attribute-session", {
      mode: "sms",
      characterId: character.id,
      text: "公开违约已经被证实。",
    });
    assert.equal(decreased.status, "completed");
    await runtime.kernel.postTurnCoordinator.drain();
    life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes.find((entry) => entry.key === "reputation")?.value, 17);
    assert.equal(life.attributeEvents[0].appliedDelta, -7);
    assert.equal(life.attributeEvents[0].analysisDirection, "decrease");
    assert.equal(analysisCount, 2);

    runtime.model.enqueue([{ kind: "provider_error", message: "provider unavailable" }]);
    const failed = await runtime.kernel.sendMessage("world-attribute-session", {
      mode: "sms",
      characterId: character.id,
      text: "公开委托已经完成。",
    });
    assert.equal(failed.status, "failed");
    await runtime.kernel.postTurnCoordinator.drain();
    life = runtime.kernel.getCharacterLife(character.id);
    assert.equal(life.attributes.find((entry) => entry.key === "reputation")?.value, 17);
    assert.equal(life.attributeEvents.length, 2);
    assert.equal(analysisCount, 2);
  } finally {
    runtime.dispose();
  }
});
