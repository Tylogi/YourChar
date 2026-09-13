import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relationshipStateMcpModuleId } from "../src/modules/catalog.js";
import {
  relationshipExtractorSystemPrompt,
  stableRelationshipExtractorPrompt,
} from "../src/relationship/index.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/index.js";

test("relationship extraction uses one stable prompt for every private turn", () => {
  const base = {
    mode: "sms" as const,
    characterId: "character",
    sourceSessionId: "session",
    sourceContextLogId: "context",
    assistantText: "我听见了。",
  };
  assert.equal(relationshipExtractorSystemPrompt({ ...base, userText: "午饭吃什么？" }), stableRelationshipExtractorPrompt);
  assert.equal(relationshipExtractorSystemPrompt({ ...base, userText: "我现在很信任你。" }), stableRelationshipExtractorPrompt);
  assert.equal(relationshipExtractorSystemPrompt({ ...base, userText: "我们正式交往吧。" }), stableRelationshipExtractorPrompt);
  assert.equal(relationshipExtractorSystemPrompt({ ...base, userText: "今天怎么样？", assistantText: "其实我喜欢你。" }), stableRelationshipExtractorPrompt);
});

test("private relationship signals produce bounded state events and inject a qualitative snapshot across sessions", async () => {
  let extractionCalls = 0;
  const runtime = createTestRuntime({
    seed: "relationship-private",
    relationshipExtractor: async (input) => {
      extractionCalls += 1;
      assert.equal(input.userText, "谢谢你一直陪我，我很信任你。");
      return {
        significant: true,
        eventType: "support",
        impact: "moderate",
        summary: "用户感谢角色持续陪伴并表达信任",
        confidence: 1,
        delta: { trust: 100, bond: 100 },
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈", soulMarkdown: "# 林澈" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([
      { kind: "assistant_text", text: "我会继续陪着你。" },
      { kind: "assistant_text", text: "我记得我们之间的感觉。" },
    ]);

    await runtime.kernel.sendMessage("relationship-source", {
      mode: "sms",
      characterId: character.id,
      text: "谢谢你一直陪我，我很信任你。",
    });
    await runtime.kernel.relationshipCoordinator.drain();

    const snapshot = runtime.kernel.getCharacterRelationship(character.id);
    assert.equal(extractionCalls, 1);
    assert.equal(snapshot.state.trust, 37);
    assert.equal(snapshot.state.bond, 27);
    assert.equal(snapshot.state.tension, 0);
    assert.deepEqual(snapshot.state.bondFacets, []);
    assert.equal(snapshot.state.romanceStatus, "none");
    assert.equal(snapshot.recentEvents.length, 1);
    assert.deepEqual(snapshot.recentEvents[0].delta, {
      trust: 2,
      bond: 2,
      tension: -2,
    });
    const exported = await runtime.kernel.exportUserData();
    assert.equal(exported.relationships.find((entry) => entry.state.characterId === character.id)?.recentEvents.length, 1);
    assert.equal(exported.relationshipCoordinator.enabled, true);
    const transcript = await runtime.kernel.getConversationTranscript("relationship-source");
    const latestUser = transcript.find((entry) => entry.role === "user" && entry.latestUser);
    assert.ok(latestUser);
    await assert.rejects(
      runtime.kernel.retractLatestUserMessage("relationship-source", latestUser.entryId),
      /changed relationship state/,
    );

    await runtime.kernel.sendMessage("relationship-new-session", {
      mode: "sms",
      characterId: character.id,
      text: "今天怎么样？",
    });
    const request = runtime.model.requests[1];
    assert.ok(request.toolNames.includes("get_relationship_state"));
    const messages = JSON.stringify(request.messages);
    assert.match(messages, /Relationship continuity/);
    assert.match(messages, /用户感谢角色持续陪伴并表达信任/);
    assert.doesNotMatch(messages, /"trust":37|trust:\s*37/);
    const runtimeCarrier = request.messages.find((message) => JSON.stringify(message).includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.ok(JSON.stringify(runtimeCarrier).length < 1_800);

    const other = runtime.kernel.createCharacter({ name: "苏遥", soulMarkdown: "# 苏遥" });
    assert.equal(runtime.kernel.getCharacterRelationship(other.id).state.trust, 35);
    assert.equal(runtime.kernel.getCharacterRelationship(other.id).recentEvents.length, 0);
  } finally {
    runtime.dispose();
  }
});

test("romance requires evidenced milestones and never follows from bond scores alone", () => {
  const runtime = createTestRuntime({ seed: "relationship-romance-milestones" });
  try {
    const character = runtime.kernel.createCharacter({ name: "迟雾" });
    const apply = (sourceContextLogId: string, userText: string, assistantText: string, extraction: Parameters<typeof runtime.kernel.relationshipService.applyExtraction>[1]) =>
      runtime.kernel.relationshipService.applyExtraction({
        mode: "sms",
        characterId: character.id,
        sourceSessionId: "romance-session",
        sourceContextLogId,
        userText,
        assistantText,
      }, extraction);

    apply("affection-only", "今天见到你很开心。", "我也很开心。", {
      significant: true,
      eventType: "affection",
      impact: "major",
      summary: "双方进行了亲密表达",
      confidence: 1,
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "none");

    const invalid = apply("invented-confirmation", "我很喜欢你。", "谢谢你告诉我。", {
      significant: true,
      eventType: "relationship_confirmed",
      impact: "major",
      summary: "模型错误地声称双方确认交往",
      confidence: 1,
      initiator: "mutual",
      evidence: { user: "我们正式交往吧", assistant: "好，我们在一起" },
    });
    assert.equal(invalid, undefined);
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "none");

    apply("user-confession", "我喜欢你。", "我需要想一想。", {
      significant: true,
      eventType: "confession",
      impact: "moderate",
      summary: "用户向角色表达浪漫好感",
      confidence: 0.95,
      initiator: "user",
      evidence: { user: "我喜欢你" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "user_interest");

    apply("accepted-confession", "我还是喜欢你。", "我也喜欢你。", {
      significant: true,
      eventType: "confession_accepted",
      impact: "major",
      summary: "角色明确回应用户的好感",
      confidence: 0.95,
      initiator: "user",
      evidence: { user: "我还是喜欢你", assistant: "我也喜欢你" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "mutual_interest");

    apply("dating-confirmed", "我们正式交往吧。", "好，我们从今天开始交往。", {
      significant: true,
      eventType: "relationship_confirmed",
      impact: "major",
      summary: "双方明确确认开始交往",
      confidence: 0.98,
      initiator: "mutual",
      evidence: { user: "我们正式交往吧", assistant: "我们从今天开始交往" },
    });
    const dating = runtime.kernel.getCharacterRelationship(character.id);
    assert.equal(dating.state.romanceStatus, "dating");
    assert.equal(dating.recentEvents[0].semanticChange?.romanceFrom, "mutual_interest");
    assert.equal(dating.recentEvents[0].semanticChange?.romanceTo, "dating");
    assert.match(dating.qualitative, /mutually confirmed dating relationship/);

    apply("affection-while-dating", "我还是很喜欢你。", "我也一直喜欢你。", {
      significant: true,
      eventType: "confession_accepted",
      impact: "minor",
      summary: "交往中的双方再次表达爱意",
      confidence: 0.95,
      initiator: "mutual",
      evidence: { user: "我还是很喜欢你", assistant: "我也一直喜欢你" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "dating");

    apply("commitment", "我想和你长期走下去。", "我也愿意成为你的长期伴侣。", {
      significant: true,
      eventType: "commitment",
      impact: "major",
      summary: "双方作出长期关系承诺",
      confidence: 0.98,
      initiator: "mutual",
      evidence: { user: "我想和你长期走下去", assistant: "我也愿意成为你的长期伴侣" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "committed");

    apply("reconfirm-after-commitment", "我们继续交往，好吗？", "好，我们继续交往。", {
      significant: true,
      eventType: "relationship_confirmed",
      impact: "minor",
      summary: "稳定伴侣再次确认交往",
      confidence: 0.95,
      initiator: "mutual",
      evidence: { user: "我们继续交往", assistant: "我们继续交往" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "committed");
  } finally {
    runtime.dispose();
  }
});

test("a character-initiated confession in the assistant reply is classified semantically", async () => {
  let extractionCalls = 0;
  const runtime = createTestRuntime({
    seed: "relationship-character-confession",
    relationshipExtractor: async (input) => {
      extractionCalls += 1;
      assert.equal(input.userText, "今天有什么想说的吗？");
      assert.match(input.assistantText, /我喜欢你/);
      return {
        significant: true,
        eventType: "confession",
        impact: "major",
        summary: "角色主动向用户表达浪漫好感",
        confidence: 0.95,
        initiator: "character",
        evidence: { assistant: "我喜欢你" },
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "星野" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "其实，有件事想告诉你：我喜欢你。" }]);
    await runtime.kernel.sendMessage("character-confession", {
      mode: "sms",
      characterId: character.id,
      text: "今天有什么想说的吗？",
    });
    await runtime.kernel.relationshipCoordinator.drain();
    assert.equal(extractionCalls, 1);
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "character_interest");
  } finally {
    runtime.dispose();
  }
});

test("relationship facts support explicit bonds, confidant development, breakup, and reunion", () => {
  const runtime = createTestRuntime({ seed: "relationship-semantic-facts" });
  try {
    const character = runtime.kernel.createCharacter({ name: "南星" });
    const apply = (id: string, userText: string, assistantText: string, extraction: Parameters<typeof runtime.kernel.relationshipService.applyExtraction>[1]) =>
      runtime.kernel.relationshipService.applyExtraction({
        mode: "rp",
        characterId: character.id,
        sourceSessionId: "semantic-session",
        sourceContextLogId: id,
        userText,
        assistantText,
      }, extraction);

    apply("friends", "我们是朋友，对吗？", "对，我们是朋友。", {
      significant: true,
      eventType: "bond_defined",
      impact: "moderate",
      summary: "双方明确将彼此定义为朋友",
      confidence: 0.95,
      initiator: "mutual",
      bondFacet: "friendship",
      evidence: { user: "我们是朋友", assistant: "我们是朋友" },
    });
    assert.deepEqual(runtime.kernel.getCharacterRelationship(character.id).state.bondFacets, ["friendship"]);

    for (const [id, secret] of [["secret-one", "这是我没有告诉别人的第一件事"], ["secret-two", "还有一件只告诉你的事"]] as const) {
      apply(id, secret, "我会替你保守这个秘密。", {
        significant: true,
        eventType: "shared_secret",
        impact: "moderate",
        summary: "用户向角色分享了私人秘密",
        confidence: 0.9,
      });
    }
    assert.deepEqual(runtime.kernel.getCharacterRelationship(character.id).state.bondFacets, ["friendship", "confidant"]);

    apply("dating", "我们交往吧。", "好。", {
      significant: true,
      eventType: "relationship_confirmed",
      impact: "major",
      summary: "双方确认交往",
      confidence: 1,
      initiator: "mutual",
      evidence: { user: "我们交往吧", assistant: "好" },
    });
    apply("breakup", "我们分手吧。", "我听清楚了。", {
      significant: true,
      eventType: "breakup",
      impact: "major",
      summary: "用户明确结束交往关系",
      confidence: 0.98,
      initiator: "user",
      evidence: { user: "我们分手吧" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "former_partners");

    apply("reunion", "我们重新在一起，好吗？", "好，我们重新开始。", {
      significant: true,
      eventType: "reconciliation",
      impact: "major",
      summary: "双方明确同意恢复交往",
      confidence: 0.98,
      initiator: "mutual",
      evidence: { user: "我们重新在一起", assistant: "我们重新开始" },
    });
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).state.romanceStatus, "dating");
  } finally {
    runtime.dispose();
  }
});

test("every completed private turn receives one bounded relationship review", async () => {
  let extractionCalls = 0;
  const runtime = createTestRuntime({
    seed: "relationship-periodic-review",
    relationshipExtractor: async (input) => {
      extractionCalls += 1;
      assert.equal(input.reviewKind, "single_turn");
      assert.equal(input.reviewTurns, undefined);
      return { significant: false, confidence: 0 };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "微澜" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue(Array.from({ length: 8 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `这是第${index + 1}次平常回应。`,
    })));
    for (let index = 0; index < 8; index += 1) {
      await runtime.kernel.sendMessage("relationship-periodic", {
        mode: "sms",
        characterId: character.id,
        text: `今天是第${index + 1}次普通聊天。`,
      });
    }
    await runtime.kernel.relationshipCoordinator.drain();
    assert.equal(extractionCalls, 8);
    const jobs = runtime.kernel.getRelationshipCoordinatorStatus().recentJobs;
    assert.equal(jobs.filter((job) => job.triggerReason === "private_turn_review").length, 8);
    assert.equal(jobs.every((job) => job.status === "completed"), true);
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).recentEvents.length, 0);
  } finally {
    runtime.dispose();
  }
});

test("relationship reset keeps subsequent per-turn extraction active", async () => {
  let extractionCalls = 0;
  const runtime = createTestRuntime({
    seed: "relationship-reset-periodic-fence",
    relationshipExtractor: async () => {
      extractionCalls += 1;
      return { significant: false, confidence: 0 };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "清和" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue(Array.from({ length: 8 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `普通回复 ${index + 1}`,
    })));
    for (let index = 0; index < 7; index += 1) {
      await runtime.kernel.sendMessage("relationship-reset-periodic", {
        mode: "sms",
        characterId: character.id,
        text: `普通话题 ${index + 1}`,
      });
    }
    await runtime.kernel.relationshipCoordinator.drain();
    assert.equal(extractionCalls, 7);
    runtime.kernel.resetCharacterRelationship(character.id);
    await runtime.kernel.sendMessage("relationship-reset-periodic", {
      mode: "sms",
      characterId: character.id,
      text: "重置后的普通话题",
    });
    await runtime.kernel.relationshipCoordinator.drain();
    assert.equal(extractionCalls, 8);
    const jobs = runtime.kernel.getRelationshipCoordinatorStatus().recentJobs;
    assert.equal(jobs.filter((job) => job.triggerReason === "private_turn_review").length, 1);
    assert.equal(jobs.filter((job) => job.triggerReason.startsWith("before_relationship_reset:")).length, 7);
  } finally {
    runtime.dispose();
  }
});

test("disabled relationship module preserves state without extraction, tools, or context injection", async () => {
  let extractionCalls = 0;
  const runtime = createTestRuntime({
    seed: "relationship-disabled",
    relationshipExtractor: async () => {
      extractionCalls += 1;
      return { significant: true, eventType: "affection", impact: "major", summary: "不应执行", confidence: 1 };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "未启用角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "收到。" }]);
    await runtime.kernel.sendMessage("relationship-disabled", {
      mode: "sms",
      characterId: character.id,
      text: "我喜欢你。",
    });
    await runtime.kernel.relationshipCoordinator.drain();
    assert.equal(extractionCalls, 0);
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).recentEvents.length, 0);
    assert.equal(runtime.model.requests[0].toolNames.includes("get_relationship_state"), false);
    assert.doesNotMatch(JSON.stringify(runtime.model.requests[0].messages), /Relationship continuity/);
  } finally {
    runtime.dispose();
  }
});

test("relationship affect decays and group chat reads but never mutates character state", async () => {
  const runtime = createTestRuntime({
    seed: "relationship-decay-group",
    relationshipExtractor: async () => ({
      significant: true,
      eventType: "boundary_violation",
      impact: "major",
      summary: "用户明确越过角色边界",
      confidence: 1,
    }),
  });
  try {
    const first = runtime.kernel.createCharacter({ name: "甲" });
    const second = runtime.kernel.createCharacter({ name: "乙" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "这让我很不舒服。" }]);
    await runtime.kernel.sendMessage("relationship-affect", {
      mode: "rp",
      characterId: first.id,
      text: "对不起，但我刚才确实越界了，不该那样。",
    });
    await runtime.kernel.relationshipCoordinator.drain();
    const immediate = runtime.kernel.getCharacterRelationship(first.id);
    assert.ok(immediate.state.affect.valence < -0.4);
    assert.ok(immediate.state.affect.labels.includes("guarded"));
    assert.equal(immediate.state.tension, 6);

    runtime.clock.advance(12 * 60 * 60_000);
    const decayed = runtime.kernel.getCharacterRelationship(first.id);
    assert.ok(decayed.state.affect.valence > immediate.state.affect.valence);
    assert.deepEqual(decayed.state.affect.labels, []);
    assert.equal(decayed.state.tension, 3);

    runtime.model.enqueue([
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
    ]);
    const group = runtime.kernel.createGroupChat({
      title: "关系只读群",
      mode: "rp",
      characterIds: [first.id, second.id],
      maxSpeakers: 2,
    });
    await runtime.kernel.sendGroupMessage(group.id, "我喜欢你们，也谢谢你们。", "Asia/Shanghai");
    assert.ok(runtime.model.requests.slice(-2).every((request) =>
      JSON.stringify(request.messages).includes("Relationship continuity")));
    assert.equal(runtime.kernel.getCharacterRelationship(first.id).recentEvents.length, 1);
    assert.equal(runtime.kernel.getCharacterRelationship(second.id).recentEvents.length, 0);
  } finally {
    runtime.dispose();
  }
});

test("schema 43 folds legacy relationship axes into bond without losing semantic state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-relationship-v43-"));
  const databasePath = join(stateDir, "rp-agent.sqlite");
  const legacy = new AppDatabase(databasePath, { maxMigrationVersion: 42 });
  const now = "2026-08-23T00:00:00.000Z";
  try {
    legacy.connection.prepare(`
      INSERT INTO characters(id, name, created_at, updated_at)
      VALUES ('relationship-v43-character', '迁移角色', ?, ?)
    `).run(now, now);
    legacy.connection.prepare(`
      INSERT INTO character_relationship_states(
        character_id, trust, closeness, affection, respect, tension,
        bond_facets_json, romance_status, semantic_updated_at,
        affect_valence, affect_arousal, affect_control, affect_labels_json,
        affect_updated_at, version, created_at, updated_at
      ) VALUES (?, 72, 80, 60, 20, 35, '["confidant"]', 'dating', ?,
        0.25, 0.4, 0.75, '["warm"]', ?, 7, ?, ?)
    `).run("relationship-v43-character", now, now, now, now);
    legacy.connection.prepare(`
      INSERT INTO relationship_events(
        id, character_id, source_session_id, source_context_log_id,
        event_type, impact, summary, confidence, delta_json, created_at
      ) VALUES (
        'relationship-v43-event', 'relationship-v43-character', 'session-v43', 'context-v43',
        'support', 'moderate', '旧五维事件', 1,
        '{"trust":2,"closeness":4,"affection":2,"respect":-2,"tension":4}', ?
      )
    `).run(now);
  } finally {
    legacy.close();
  }

  const migrated = new AppDatabase(databasePath);
  try {
    const version = migrated.connection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    assert.equal(Number(version.version), 65);
    const columns = (migrated.connection.prepare(
      "PRAGMA table_info(character_relationship_states)",
    ).all() as Array<{ name: string }>).map((entry) => entry.name);
    assert.ok(columns.includes("bond"));
    assert.equal(columns.includes("closeness"), false);
    assert.equal(columns.includes("affection"), false);
    assert.equal(columns.includes("respect"), false);
    const state = migrated.connection.prepare(`
      SELECT trust, bond, tension, bond_facets_json, romance_status,
             affect_valence, version
      FROM character_relationship_states
      WHERE character_id = 'relationship-v43-character'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...state }, {
      trust: 72,
      bond: 66,
      tension: 35,
      bond_facets_json: '["confidant"]',
      romance_status: "dating",
      affect_valence: 0.25,
      version: 7,
    });
    const event = migrated.connection.prepare(`
      SELECT delta_json FROM relationship_events WHERE id = 'relationship-v43-event'
    `).get() as { delta_json: string };
    assert.deepEqual(JSON.parse(event.delta_json), { trust: 2, bond: 3, tension: 4 });
  } finally {
    migrated.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("relationship state survives restart and failed extraction retries apply exactly once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-relationship-restart-"));
  let extractionCalls = 0;
  const extractor = async () => {
    extractionCalls += 1;
    if (extractionCalls === 1) throw new Error("temporary classifier failure");
    return {
      significant: true,
      eventType: "affection",
      impact: "minor",
      summary: "用户表达想念与好感",
      confidence: 1,
    };
  };
  const first = createTestRuntime({ stateDir, seed: "relationship-restart-first", relationshipExtractor: extractor });
  let characterId = "";
  try {
    const character = first.kernel.createCharacter({ name: "持久角色" });
    characterId = character.id;
    first.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    first.model.enqueue([{ kind: "assistant_text", text: "我也很想你。" }]);
    await first.kernel.sendMessage("relationship-retry", {
      mode: "sms",
      characterId,
      text: "我很想你，也很喜欢你。",
    });
    await first.kernel.relationshipCoordinator.drain();
    const failed = first.kernel.getRelationshipCoordinatorStatus().recentJobs[0];
    assert.equal(failed.status, "failed");
    first.kernel.retryRelationshipExtractionJob(failed.id);
    await first.kernel.relationshipCoordinator.drain();
    const snapshot = first.kernel.getCharacterRelationship(characterId);
    assert.equal(snapshot.recentEvents.length, 1);
    assert.equal(extractionCalls, 2);
  } finally {
    first.dispose();
  }

  const second = createTestRuntime({ stateDir, seed: "relationship-restart-second", relationshipExtractor: extractor });
  try {
    const snapshot = second.kernel.getCharacterRelationship(characterId);
    assert.equal(snapshot.recentEvents.length, 1);
    assert.equal(snapshot.recentEvents[0].summary, "用户表达想念与好感");
    assert.equal(second.kernel.listAgentModules().find((entry) => entry.id === relationshipStateMcpModuleId)?.enabled, true);
    const before = snapshot.state;
    second.kernel.relationshipService.applyExtraction({
      mode: "sms",
      characterId,
      sourceSessionId: snapshot.recentEvents[0].sourceSessionId,
      sourceContextLogId: snapshot.recentEvents[0].sourceContextLogId,
      userText: "重复来源",
      assistantText: "重复来源",
    }, {
      significant: true,
      eventType: "boundary_violation",
      impact: "major",
      summary: "不应重复应用",
      confidence: 1,
    });
    const after = second.kernel.getCharacterRelationship(characterId);
    assert.equal(after.recentEvents.length, 1);
    assert.deepEqual(after.state, before);
  } finally {
    second.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("relationship reset fences an in-flight extractor so old events cannot reappear", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createTestRuntime({
    seed: "relationship-reset-fence",
    relationshipExtractor: async () => {
      markStarted();
      await blocked;
      return {
        significant: true,
        eventType: "affection",
        impact: "major",
        summary: "重置前的旧事件",
        confidence: 1,
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "重置角色" });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我听见了。" }]);
    await runtime.kernel.sendMessage("relationship-reset-fence", {
      mode: "sms",
      characterId: character.id,
      text: "我真的很喜欢你。",
    });
    await started;
    runtime.kernel.resetCharacterRelationship(character.id);
    release();
    await runtime.kernel.relationshipCoordinator.drain();
    const snapshot = runtime.kernel.getCharacterRelationship(character.id);
    assert.equal(snapshot.recentEvents.length, 0);
    assert.equal(snapshot.state.bond, 25);
    assert.equal(snapshot.state.tension, 0);
    assert.equal(runtime.kernel.getRelationshipCoordinatorStatus().recentJobs[0].status, "skipped");
  } finally {
    release?.();
    runtime.dispose();
  }
});
