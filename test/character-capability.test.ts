import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CharacterCapabilityValidationError } from "../src/organization/index.js";
import { AppDatabase } from "../src/storage/index.js";
import { createTestRuntime } from "../src/testing/index.js";

const METHOD = [
  "# 来源核验",
  "",
  "## 步骤",
  "",
  "- 识别需要核验的主张。",
  "- 对照原始来源和时间。",
  "- 交付前复查证据是否支持结论。",
].join("\n");

test("collaboration profiles are lightweight public metadata, not permission grants", () => {
  const runtime = createTestRuntime({ seed: "collaboration-profile" });
  try {
    const character = runtime.kernel.createCharacter({ name: "核验员" });
    const initial = runtime.kernel.getCharacterCollaborationProfile(character.id);
    assert.equal(initial.introduction, "");
    assert.deepEqual(initial.traits, []);

    const updated = runtime.kernel.updateCharacterCollaborationProfile(character.id, {
      introduction: "负责公开资料核验，并清楚说明证据边界。",
      traits: ["严谨", "善于解释", "严谨"],
      maxConcurrentTasks: 2,
    });
    assert.equal(updated.introduction, "负责公开资料核验，并清楚说明证据边界。");
    assert.deepEqual(updated.traits, ["严谨", "善于解释"]);
    assert.equal(updated.maxConcurrentTasks, 2);
    assert.throws(() => runtime.kernel.updateCharacterCollaborationProfile(character.id, {
      maxConcurrentTasks: 6,
    }), CharacterCapabilityValidationError);

    const summary = runtime.kernel.characterCapabilities.getPublicSummary(character.id);
    assert.equal(summary.introduction, updated.introduction);
    assert.deepEqual(summary.traits, updated.traits);
    assert.deepEqual(summary.skills, []);
  } finally {
    runtime.dispose();
  }
});

test("automatic routing is Skill-only and selected bodies stay with the target", () => {
  const runtime = createTestRuntime({ seed: "skill-only-routing" });
  try {
    const source = runtime.kernel.createCharacter({ name: "委托者" });
    const specialist = runtime.kernel.createCharacter({ name: "核验专家" });
    const peer = runtime.kernel.createCharacter({ name: "普通同伴" });
    const world = runtime.kernel.createWorld({ name: "协作世界", timezone: "Asia/Shanghai" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "工作室",
      capabilityIds: ["work", "study", "communicate", "rest"],
    });
    for (const character of [source, specialist, peer]) {
      runtime.kernel.assignCharacterWorld(character.id, {
        worldId: world.id,
        homePlaceId: place.id,
        currentPlaceId: place.id,
      });
    }
    runtime.kernel.updateCharacterCollaborationProfile(specialist.id, {
      introduction: "核验公开来源的专家。",
      traits: ["严谨"],
      maxConcurrentTasks: 2,
    });
    const skill = runtime.kernel.createCharacterOwnedSkill(specialist.id, {
      name: "来源核验",
      description: "核对公开资料和原始出处。",
      tags: ["research", "verification"],
      markdown: METHOD,
      activate: true,
    });

    assert.throws(() => runtime.kernel.previewCharacterTaskRoute({
      sourceCharacterId: source.id,
      task: "找一位合适的角色核验资料",
    }), /requires at least one public Skill id/);
    const route = runtime.kernel.previewCharacterTaskRoute({
      sourceCharacterId: source.id,
      task: "核验资料",
      requiredSkillIds: [skill.id],
    });
    assert.equal(route.selected?.characterId, specialist.id);
    assert.equal(route.selected?.introduction, "核验公开来源的专家。");
    assert.deepEqual(route.selected?.traits, ["严谨"]);
    assert.deepEqual(route.selectedSkillIds, [skill.id]);
    assert.deepEqual(
      runtime.kernel.characterCapabilities.getTaskSkill(
        specialist.id,
        "normal",
        route.selectedSkillIds,
      )?.packages.map((entry) => entry.id),
      [skill.id],
    );
  } finally {
    runtime.dispose();
  }
});

test("schema 42 removes the legacy duty, capability and single-Skill tables", () => {
  const runtime = createTestRuntime({ seed: "legacy-character-schema-removal" });
  try {
    const version = runtime.kernel.database.connection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as {
      version: number;
    };
    assert.equal(Number(version.version), 58);
    const tables = new Set((runtime.kernel.database.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(tables.has("character_collaboration_profiles"), true);
    for (const removed of [
      "character_function_profiles",
      "character_capabilities",
      "character_capability_evidence",
      "character_skill_versions",
    ]) assert.equal(tables.has(removed), false, `${removed} should be removed`);
  } finally {
    runtime.dispose();
  }
});

test("schema 42 migrates legacy collaboration metadata and the active single Skill once", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-character-v42-"));
  const path = join(directory, "state.sqlite");
  const now = "2026-08-21T00:00:00.000Z";
  try {
    const legacy = new AppDatabase(path, { maxMigrationVersion: 41 });
    try {
      legacy.connection.prepare(`
        INSERT INTO characters(id, name, created_at, updated_at)
        VALUES ('legacy-character', '旧角色', ?, ?)
      `).run(now, now);
      legacy.connection.prepare(`
        INSERT INTO character_function_profiles(
          character_id, public_role, task_preferences, avoided_tasks,
          max_concurrent_tasks, manual_locked, inference_status,
          source_soul_hash, inference_error, created_at, updated_at
        ) VALUES (
          'legacy-character', '负责核验旧资料', '', '', 3, 1, 'ready', '', '', ?, ?
        )
      `).run(now, now);
      legacy.connection.prepare(`
        INSERT INTO character_skill_versions(
          id, character_id, conversation_space, version, status, markdown,
          change_summary, source, content_hash, created_at, activated_at
        ) VALUES (
          'legacy-skill', 'legacy-character', 'normal', 4, 'active', ?,
          '旧方法', 'manual', 'legacy-hash', ?, ?
        )
      `).run(METHOD, now, now);
    } finally {
      legacy.close();
    }

    const migrated = new AppDatabase(path);
    try {
      const profile = migrated.connection.prepare(`
        SELECT introduction, traits_json, max_concurrent_tasks
        FROM character_collaboration_profiles
        WHERE character_id = 'legacy-character'
      `).get() as Record<string, unknown>;
      assert.equal(profile.introduction, "负责核验旧资料");
      assert.equal(profile.traits_json, "[]");
      assert.equal(profile.max_concurrent_tasks, 3);

      const packages = migrated.connection.prepare(`
        SELECT id, name, description, created_by
        FROM character_owned_skill_packages
        WHERE character_id = 'legacy-character' AND conversation_space = 'normal'
      `).all() as Array<Record<string, unknown>>;
      assert.equal(packages.length, 1);
      assert.equal(packages[0]?.id, "legacy-owned-legacy-skill");
      assert.equal(packages[0]?.description, "负责核验旧资料");
      assert.equal(packages[0]?.created_by, "migration");
      const version = migrated.connection.prepare(`
        SELECT markdown, source, status
        FROM character_owned_skill_versions
        WHERE package_id = 'legacy-owned-legacy-skill'
      `).get() as Record<string, unknown>;
      assert.equal(version.markdown, METHOD);
      assert.equal(version.source, "legacy_migration");
      assert.equal(version.status, "active");
    } finally {
      migrated.close();
    }

    const restarted = new AppDatabase(path);
    try {
      assert.equal(Number((restarted.connection.prepare(`
        SELECT COUNT(*) AS count FROM character_owned_skill_packages
        WHERE character_id = 'legacy-character'
      `).get() as { count: number }).count), 1);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("collaboration profiles and owned Skills persist across restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-collaboration-profile-"));
  const first = createTestRuntime({ stateDir, seed: "collaboration-persist-first" });
  let characterId = "";
  try {
    const character = first.kernel.createCharacter({ name: "持久核验员" });
    characterId = character.id;
    first.kernel.updateCharacterCollaborationProfile(character.id, {
      introduction: "持续维护核验方法。",
      traits: ["可靠"],
      maxConcurrentTasks: 3,
    });
    first.kernel.createCharacterOwnedSkill(character.id, {
      name: "来源核验",
      markdown: METHOD,
      activate: true,
    });
  } finally {
    first.dispose();
  }
  const second = createTestRuntime({ stateDir, seed: "collaboration-persist-second" });
  try {
    assert.equal(
      second.kernel.getCharacterCollaborationProfile(characterId).introduction,
      "持续维护核验方法。",
    );
    assert.equal(second.kernel.listCharacterOwnedSkills(characterId).length, 1);
  } finally {
    second.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
