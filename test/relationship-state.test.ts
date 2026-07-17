import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relationshipStateMcpModuleId } from "../src/modules/catalog.js";
import { createTestRuntime } from "../src/testing/index.js";

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
        delta: { trust: 100, closeness: 100 },
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
    assert.equal(snapshot.state.closeness, 22);
    assert.equal(snapshot.state.affection, 27);
    assert.equal(snapshot.state.tension, 3);
    assert.equal(snapshot.recentEvents.length, 1);
    assert.deepEqual(snapshot.recentEvents[0].delta, {
      trust: 2,
      closeness: 2,
      affection: 2,
      respect: 0,
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
    assert.match(messages, /Trusted relationship snapshot/);
    assert.match(messages, /用户感谢角色持续陪伴并表达信任/);
    assert.doesNotMatch(messages, /"trust":37|trust:\s*37/);

    const other = runtime.kernel.createCharacter({ name: "苏遥", soulMarkdown: "# 苏遥" });
    assert.equal(runtime.kernel.getCharacterRelationship(other.id).state.trust, 35);
    assert.equal(runtime.kernel.getCharacterRelationship(other.id).recentEvents.length, 0);
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
    assert.doesNotMatch(JSON.stringify(runtime.model.requests[0].messages), /Trusted relationship snapshot/);
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

    runtime.clock.advance(12 * 60 * 60_000);
    const decayed = runtime.kernel.getCharacterRelationship(first.id);
    assert.ok(decayed.state.affect.valence > immediate.state.affect.valence);
    assert.deepEqual(decayed.state.affect.labels, []);

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
      JSON.stringify(request.messages).includes("Trusted relationship snapshot")));
    assert.equal(runtime.kernel.getCharacterRelationship(first.id).recentEvents.length, 1);
    assert.equal(runtime.kernel.getCharacterRelationship(second.id).recentEvents.length, 0);
  } finally {
    runtime.dispose();
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
    assert.equal(snapshot.state.affection, 25);
    assert.equal(runtime.kernel.getRelationshipCoordinatorStatus().recentJobs[0].status, "skipped");
  } finally {
    release?.();
    runtime.dispose();
  }
});
