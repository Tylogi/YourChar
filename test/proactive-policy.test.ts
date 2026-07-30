import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";
import {
  PROACTIVE_SCORE_THRESHOLD,
  deriveProactiveTopic,
  evaluateProactiveCandidate,
  scoreProactiveCandidate,
  type CharacterAutonomyPolicy,
  type ProactiveMessage,
  type WorldEvent,
} from "../src/world/index.js";

const now = new Date("2026-07-20T04:00:00.000Z");

test("proactive candidates receive deterministic topic and score metadata", () => {
  const event = baseEvent();
  const topic = deriveProactiveTopic(event, { id: "place-lab", name: "研究所" });
  const first = scoreProactiveCandidate({ event, now });
  const second = scoreProactiveCandidate({ event, now });

  assert.deepEqual(topic, { topicKey: "world.activity:place-lab", topicLabel: "生活片段 · 研究所" });
  assert.deepEqual(first, second);
  assert.ok(first.score >= PROACTIVE_SCORE_THRESHOLD);
  assert.ok(first.breakdown.salience > 0);
  assert.ok(first.breakdown.timeliness > 0);
});

test("proactive delivery gates are explicit and manual simulation only bypasses timing gates", () => {
  const event = baseEvent();
  const message = baseMessage();
  const policy = basePolicy({ lastProactiveAt: "2026-07-20T03:30:00.000Z" });
  const common = {
    message,
    event,
    policy,
    deliveredMessages: [],
    deliveredToday: 0,
    now,
    inQuietHours: false,
  };

  assert.equal(evaluateProactiveCandidate(common).decisionCode, "global_cooldown");
  assert.equal(evaluateProactiveCandidate({ ...common, policy: basePolicy(), lastUserAt: "2026-07-20T03:55:00.000Z" }).decisionCode, "recent_user_activity");
  assert.equal(evaluateProactiveCandidate({ ...common, policy: basePolicy(), inQuietHours: true }).decisionCode, "quiet_hours");
  assert.equal(evaluateProactiveCandidate({ ...common, force: true }).decisionCode, "candidate_ready");
  assert.equal(evaluateProactiveCandidate({ ...common, force: true, blockReason: "co_present" }).decisionCode, "co_present");
});

test("stale and muted proactive candidates are permanently discarded", () => {
  const stale = evaluateProactiveCandidate({
    message: baseMessage(),
    event: baseEvent({ startsAt: "2026-07-16T04:00:00.000Z" }),
    policy: basePolicy(),
    deliveredMessages: [],
    deliveredToday: 0,
    now,
    inQuietHours: false,
  });
  const muted = evaluateProactiveCandidate({
    message: baseMessage(),
    event: baseEvent(),
    policy: basePolicy(),
    topicPolicy: {
      characterId: "character",
      topicKey: "world.activity:place-lab",
      topicLabel: "生活片段 · 研究所",
      mode: "muted",
      helpfulCount: 0,
      lessOftenCount: 1,
      updatedAt: now.toISOString(),
    },
    deliveredMessages: [],
    deliveredToday: 0,
    now,
    inQuietHours: false,
  });

  assert.deepEqual([stale.decisionCode, stale.permanent], ["stale", true]);
  assert.deepEqual([muted.decisionCode, muted.permanent], ["topic_muted", true]);
});

test("muting a delivered proactive topic skips queued duplicates and can be reset", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T04:00:00.000Z",
    seed: "proactive-feedback",
    worldMessenger: async (input) => ({ sessionId: input.sessionId, text: "刚告一段落，想起你了。" }),
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "主动角色" });
    const world = runtime.kernel.createWorld({ name: "主动性测试世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "研究所",
      capabilityIds: ["study", "observe", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.updateCharacterAutonomyPolicy(character.id, {
      proactiveEnabled: true,
      dailyMessageLimit: 1,
      proactiveCooldownMinutes: 90,
    });

    const delivered = await runtime.kernel.simulateCharacterMoment(character.id);
    runtime.clock.advance(1_000);
    const queued = await runtime.kernel.simulateCharacterMoment(character.id);
    assert.equal(delivered.proactiveMessage?.status, "delivered");
    assert.equal(queued.proactiveMessage?.decisionCode, "daily_limit");

    const feedback = runtime.kernel.recordProactiveMessageFeedback(delivered.proactiveMessage!.id, "mute_topic");
    assert.equal(feedback.topicPolicy.mode, "muted");
    assert.equal(runtime.kernel.worldService.repository.getProactiveMessage(queued.proactiveMessage!.id)?.status, "skipped");
    assert.equal(runtime.kernel.worldService.repository.getProactiveMessage(queued.proactiveMessage!.id)?.decisionCode, "topic_muted");

    const reset = runtime.kernel.resetCharacterProactiveTopic(character.id, feedback.topicPolicy.topicKey);
    assert.equal(reset.mode, "normal");
    assert.equal(runtime.kernel.getCharacterLife(character.id).policy.proactiveCooldownMinutes, 90);
  } finally {
    runtime.dispose();
  }
});

test("pause feedback stops proactive delivery for 24 hours and supports explicit resume", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T04:00:00.000Z",
    seed: "proactive-pause",
    worldMessenger: async (input) => ({ sessionId: input.sessionId, text: "路过时忽然想给你发条消息。" }),
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "暂停角色" });
    const world = runtime.kernel.createWorld({ name: "暂停测试世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "书店",
      capabilityIds: ["study", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.updateCharacterAutonomyPolicy(character.id, { proactiveEnabled: true });
    const delivered = await runtime.kernel.simulateCharacterMoment(character.id);

    const feedback = runtime.kernel.recordProactiveMessageFeedback(delivered.proactiveMessage!.id, "pause_24h");
    assert.equal(feedback.policy.proactivePausedUntil, "2026-07-21T04:00:00.000Z");
    assert.equal(runtime.kernel.resumeCharacterProactiveMessages(character.id).proactivePausedUntil, undefined);
  } finally {
    runtime.dispose();
  }
});

test("automatic delivery ranks by score, deduplicates a topic, and respects the global cooldown", async () => {
  const deliveredEvents: string[] = [];
  const runtime = createTestRuntime({
    now: "2026-07-20T04:00:00.000Z",
    seed: "proactive-ranking",
    worldMessenger: async (input) => {
      deliveredEvents.push(input.event.id);
      return { sessionId: input.sessionId, text: `关于 ${input.event.summary}` };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "排序角色" });
    const world = runtime.kernel.createWorld({ name: "排序测试世界" });
    const lab = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "研究所",
      capabilityIds: ["study", "observe", "communicate"],
    });
    const cafe = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "咖啡店",
      capabilityIds: ["study", "observe", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: lab.id,
      currentPlaceId: lab.id,
    });
    runtime.kernel.updateCharacterAutonomyPolicy(character.id, {
      proactiveEnabled: true,
      dailyMessageLimit: 2,
      proactiveCooldownMinutes: 120,
    });
    const lowDuplicate = await runtime.kernel.worldCoordinator.performCharacterAction({
      characterId: character.id,
      placeId: lab.id,
      capabilityId: "study",
      summary: "整理了一小段资料",
      salience: 0.7,
      idempotencyKey: "ranking-low",
      source: "manual",
      allowProactive: true,
    });
    const selected = await runtime.kernel.worldCoordinator.performCharacterAction({
      characterId: character.id,
      placeId: lab.id,
      capabilityId: "study",
      summary: "完成了一项重要实验",
      salience: 0.92,
      idempotencyKey: "ranking-high",
      source: "manual",
      allowProactive: true,
    });
    const nextTopic = await runtime.kernel.worldCoordinator.performCharacterAction({
      characterId: character.id,
      placeId: cafe.id,
      capabilityId: "observe",
      summary: "在咖啡店遇到有趣的事",
      salience: 0.84,
      idempotencyKey: "ranking-next",
      source: "manual",
      allowProactive: true,
    });

    assert.equal((await runtime.worldTick(character.id)).delivered, 1);
    assert.deepEqual(deliveredEvents, [selected.id]);
    const duplicateMessage = runtime.kernel.worldService.repository.getProactiveMessageByEvent(lowDuplicate.id)!;
    const queuedMessage = runtime.kernel.worldService.repository.getProactiveMessageByEvent(nextTopic.id)!;
    assert.deepEqual([duplicateMessage.status, duplicateMessage.decisionCode], ["skipped", "ranked_behind"]);
    assert.deepEqual([queuedMessage.status, queuedMessage.decisionCode], ["pending", "ranked_behind"]);

    assert.equal((await runtime.worldTick(character.id)).delivered, 0);
    assert.equal(runtime.kernel.worldService.repository.getProactiveMessageByEvent(nextTopic.id)?.decisionCode, "global_cooldown");
    runtime.clock.advance(121 * 60_000);
    assert.equal((await runtime.worldTick(character.id)).delivered, 1);
    assert.deepEqual(deliveredEvents, [selected.id, nextTopic.id]);
  } finally {
    runtime.dispose();
  }
});

test("proactive feedback, topic reset, pause resume, and status filters have HTTP contracts", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T04:00:00.000Z",
    seed: "proactive-http",
    worldMessenger: async (input) => ({ sessionId: input.sessionId, text: "刚才有件事想告诉你。" }),
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const character = runtime.kernel.createCharacter({ name: "接口角色" });
    const world = runtime.kernel.createWorld({ name: "接口测试世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "工作室",
      capabilityIds: ["create", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.updateCharacterAutonomyPolicy(character.id, { proactiveEnabled: true });
    const delivered = await runtime.kernel.simulateCharacterMoment(character.id);
    const message = delivered.proactiveMessage!;
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/v1/proactive-messages?status=delivered&characterId=${encodeURIComponent(character.id)}`);
    const listBody = await listResponse.json() as { messages: ProactiveMessage[] };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listBody.messages.map((entry) => entry.id), [message.id]);

    const feedbackResponse = await fetch(`${baseUrl}/api/v1/proactive-messages/${encodeURIComponent(message.id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedbackType: "less_often" }),
    });
    const feedbackBody = await feedbackResponse.json() as { message: ProactiveMessage; topicPolicy: { mode: string } };
    assert.equal(feedbackResponse.status, 200);
    assert.equal(feedbackBody.message.feedbackType, "less_often");
    assert.equal(feedbackBody.topicPolicy.mode, "reduced");

    const resetResponse = await fetch(
      `${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}/life/proactive-topics/${encodeURIComponent(message.topicKey)}/reset`,
      { method: "POST" },
    );
    assert.equal(resetResponse.status, 200);
    assert.equal((await resetResponse.json() as { topicPolicy: { mode: string } }).topicPolicy.mode, "normal");

    const patchResponse = await fetch(`${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}/life`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: {
        proactiveCooldownMinutes: 180,
        proactivePausedUntil: "2026-07-21T04:00:00.000Z",
      } }),
    });
    const patchBody = await patchResponse.json() as { life: { policy: CharacterAutonomyPolicy } };
    assert.equal(patchResponse.status, 200);
    assert.equal(patchBody.life.policy.proactiveCooldownMinutes, 180);
    assert.equal(patchBody.life.policy.proactivePausedUntil, "2026-07-21T04:00:00.000Z");

    const resumeResponse = await fetch(
      `${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}/life/proactive/resume`,
      { method: "POST" },
    );
    assert.equal(resumeResponse.status, 200);
    assert.equal((await resumeResponse.json() as { policy: CharacterAutonomyPolicy }).policy.proactivePausedUntil, undefined);

    const invalidResponse = await fetch(`${baseUrl}/api/v1/proactive-messages/${encodeURIComponent(message.id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedbackType: "unknown" }),
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

function basePolicy(patch: Partial<CharacterAutonomyPolicy> = {}): CharacterAutonomyPolicy {
  return {
    characterId: "character",
    enabled: true,
    proactiveEnabled: true,
    socialEnabled: true,
    dailyMessageLimit: 2,
    socialDailyLimit: 1,
    proactiveCooldownMinutes: 120,
    socialCooldownMinutes: 240,
    quietStart: "23:00",
    quietEnd: "08:00",
    updatedAt: now.toISOString(),
    ...patch,
  };
}

function baseMessage(patch: Partial<ProactiveMessage> = {}): ProactiveMessage {
  return {
    id: "message",
    characterId: "character",
    worldEventId: "event",
    topicKey: "world.activity:place-lab",
    topicLabel: "生活片段 · 研究所",
    candidateScore: 0.8,
    decisionCode: "queued",
    decisionDetails: {},
    status: "pending",
    attempts: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...patch,
  };
}

function baseEvent(patch: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id: "event",
    worldId: "world",
    placeId: "place-lab",
    type: "activity",
    summary: "在研究所整理完实验记录",
    salience: 0.82,
    source: "autonomy",
    startsAt: "2026-07-20T03:50:00.000Z",
    idempotencyKey: "event",
    participantIds: ["character"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...patch,
  };
}
