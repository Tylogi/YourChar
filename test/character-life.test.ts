import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import { createHttpServer } from "../src/http/router.js";
import { AppDatabase } from "../src/storage/database.js";
import type { DiarySource } from "../src/diary/types.js";
import type { WorldPlannerInput } from "../src/world/types.js";

function setup(runtime: TestRuntime) {
  const kernel = runtime.kernel;
  const alice = kernel.createCharacter({ name: "林澈", soulMarkdown: "DEPARTED_PRIVATE_SOUL" });
  const bob = kernel.createCharacter({ name: "顾遥" });
  const stranger = kernel.createCharacter({ name: "没有交集的人" });
  const world = kernel.createWorld({ name: "河岸", timezone: "Asia/Shanghai" });
  const place = kernel.createWorldPlace({ worldId: world.id, name: "书店", capabilityIds: ["study", "rest", "communicate"] });
  for (const character of [alice, bob, stranger]) kernel.assignCharacterWorld(character.id, { worldId: world.id, currentPlaceId: place.id });
  return { kernel, alice, bob, stranger, world, place };
}
function activity(input: WorldPlannerInput) {
  return { activities: [{ title: "挑选读书会的书", placeId: input.places[0].id, capabilityId: "study",
    startLocal: "2026-09-07T11:00:00", endLocal: "2026-09-07T12:00:00", summary: "挑选好了读书会的书", salience: 0.6,
    goalId: input.wishes?.[0]?.id }] };
}
function source(characterId: string, worldId: string): DiarySource {
  return { kind: "activity", id: "known-experience", characterId, characterName: "顾遥", worldId, worldName: "河岸", timezone: "Asia/Shanghai",
    title: "整理书架", occurredAt: "2026-09-07T01:00:00.000Z", soul: "", observations: ["我整理了书架"], statements: [] };
}

test("goals are explicitly admitted, bounded, owner/space scoped and never complete themselves", () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, alice, bob, world } = setup(runtime);
    const wish = kernel.createCharacterGoal(alice.id, "normal", { kind: "wish", title: "举办读书会", nextStep: "挑一本书" });
    const request = kernel.createCharacterGoal(alice.id, "normal", { kind: "request", title: "PRIVATE_REQUEST_SENTINEL" });
    kernel.createCharacterGoal(alice.id, "secret", { kind: "request", title: "SECRET_REQUEST_SENTINEL" });
    assert.throws(() => kernel.createCharacterGoal(alice.id, "normal", { kind: "wish", title: "另一个心愿" }), /已有一件/);
    assert.throws(() => kernel.createCharacterGoal(alice.id, "secret", { kind: "wish", title: "越界" }), /普通空间/);
    assert.throws(() => kernel.characterGoals.get(bob.id, "normal", wish.id), /不属于/);
    assert.throws(() => kernel.characterGoals.get(alice.id, "secret", wish.id), /不属于/);
    assert.doesNotMatch(kernel.characterGoals.context(alice.id, "normal", "world", world.id), /PRIVATE_REQUEST|SECRET_REQUEST/);
    assert.match(kernel.characterGoals.context(alice.id, "normal", "private", world.id), /PRIVATE_REQUEST/);
    assert.doesNotMatch(kernel.characterGoals.context(alice.id, "normal", "private", world.id), /SECRET_REQUEST/);
    const paused = kernel.updateCharacterGoal(alice.id, "normal", wish.id, { revision: wish.revision, action: "pause" });
    assert.equal(kernel.characterGoals.wishes(alice.id, world.id).length, 0);
    assert.throws(() => kernel.updateCharacterGoal(alice.id, "normal", wish.id, { revision: wish.revision, action: "resume" }), /已变化/);
    assert.throws(() => kernel.updateCharacterGoal(alice.id, "normal", wish.id, { revision: paused.revision, action: "complete" }), /不能为空/);
    const completed = kernel.updateCharacterGoal(alice.id, "normal", request.id, { revision: request.revision, action: "complete", completionNote: "用户已核对交付的资料" });
    assert.equal(completed.status, "completed");
    assert.equal(kernel.characterGoals.get(alice.id, "normal", wish.id).status, "paused");
  } finally { runtime.dispose(); }
});

test("a wish links to the existing calendar and derives progress from a settled event exactly once", async () => {
  let observed: WorldPlannerInput | undefined;
  const runtime = createTestRuntime({ now: "2026-09-07T02:00:00.000Z", worldPlanner: async input => { observed = input; return activity(input); } });
  try {
    const { kernel, alice, world } = setup(runtime);
    const wish = kernel.createCharacterGoal(alice.id, "normal", { kind: "wish", title: "举办读书会" });
    kernel.createCharacterGoal(alice.id, "normal", { kind: "request", title: "PRIVATE_JOB" });
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: true });
    const planned = await kernel.planCharacterLife(alice.id);
    assert.equal(planned.plans.length, 1);
    assert.deepEqual(observed?.wishes?.map(value => value.id), [wish.id]);
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_JOB/);
    let state = kernel.characterGoals.get(alice.id, "normal", wish.id);
    assert.equal(state.steps[0].status, "planned");
    assert.equal(state.steps[0].sourceEventId, undefined);
    assert.equal(kernel.getScheduleItem(state.steps[0].scheduleItemId).status, "scheduled");
    runtime.clock.advance(3 * 3600_000);
    await kernel.tickWorldAutonomy(alice.id);
    kernel.characterGoals.reconcile();
    kernel.characterGoals.reconcile();
    state = kernel.characterGoals.get(alice.id, "normal", wish.id);
    assert.equal(state.steps.length, 1);
    assert.equal(state.steps[0].status, "settled");
    assert.ok(state.steps[0].sourceEventId);
    assert.equal(state.status, "active", "one finished activity is not proof the whole wish is fulfilled");
    assert.equal(kernel.characterBackgroundTasks.list(alice.id, "normal").filter(task => task.kind === "planning").length, 1);
    assert.equal(kernel.characterGoals.context(alice.id, "normal", "world", "another-world"), "");
    assert.match(kernel.characterGoals.context(alice.id, "normal", "world", world.id), /已|挑选/);
  } finally { runtime.dispose(); }
});

test("pausing a wish cancels only its future calendar steps and keeps the evidence", async () => {
  const runtime = createTestRuntime({ now: "2026-09-07T02:00:00.000Z", worldPlanner: async input => activity(input) });
  try {
    const { kernel, alice } = setup(runtime);
    const wish = kernel.createCharacterGoal(alice.id, "normal", { kind: "wish", title: "读书会" });
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: true });
    await kernel.planCharacterLife(alice.id);
    const goal = kernel.updateCharacterGoal(alice.id, "normal", wish.id, { revision: wish.revision, action: "pause" });
    assert.equal(goal.steps[0].status, "cancelled");
    assert.equal(kernel.getScheduleItem(goal.steps[0].scheduleItemId).status, "cancelled");
    const resumed = kernel.updateCharacterGoal(alice.id, "normal", wish.id, { revision: goal.revision, action: "resume" });
    assert.equal(resumed.steps[0].status, "cancelled", "resuming intent must not resurrect cancelled calendar items");
  } finally { runtime.dispose(); }
});

test("planning cancellation fences a late model and cannot be repeated by the next timer tick", async () => {
  let release!: () => void;
  let signalled: AbortSignal | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const runtime = createTestRuntime({ now: "2026-09-07T02:00:00.000Z", worldPlanner: async input => { calls++; signalled = input.signal; await waiting; return activity(input); } });
  try {
    const { kernel, alice, bob } = setup(runtime);
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: true });
    const pending = kernel.planCharacterLife(alice.id);
    const rejected = assert.rejects(pending, /abort|停止/i);
    const task = kernel.characterBackgroundTasks.list(alice.id, "normal").find(task => task.kind === "planning")!;
    assert.throws(() => kernel.characterBackgroundTasks.control(bob.id, "normal", task.id, "cancel"), /不属于/);
    assert.throws(() => kernel.characterBackgroundTasks.control(alice.id, "secret", task.id, "cancel"), /不属于/);
    kernel.characterBackgroundTasks.control(alice.id, "normal", task.id, "cancel");
    assert.equal(signalled?.aborted, true);
    release();
    await rejected;
    assert.equal(kernel.characterBackgroundTasks.list(alice.id, "normal")[0].status, "cancelled");
    assert.equal(kernel.getCharacterLife(alice.id).plans.length, 0);
    await kernel.planCharacterLife(alice.id);
    assert.equal(calls, 1);
    await kernel.planCharacterLife(alice.id, true);
    await kernel.planCharacterLife(alice.id, true);
    await assert.rejects(kernel.planCharacterLife(alice.id, true), /额度/);
  } finally { release(); runtime.dispose(); }
});

test("changing autonomy or a wish during planning never admits obsolete model output", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runtime = createTestRuntime({ now: "2026-09-07T02:00:00.000Z", worldPlanner: async input => { await waiting; return activity(input); } });
  try {
    const { kernel, alice } = setup(runtime);
    kernel.createCharacterGoal(alice.id, "normal", { kind: "wish", title: "读书会" });
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: true });
    const pending = kernel.planCharacterLife(alice.id);
    kernel.updateCharacterAutonomyPolicy(alice.id, { enabled: false });
    const rejected = assert.rejects(pending, /已变化/);
    release();
    await rejected;
    assert.equal(kernel.getCharacterLife(alice.id).policy.enabled, false);
    assert.equal(kernel.getCharacterLife(alice.id).plans.length, 0);
  } finally { release(); runtime.dispose(); }
});

test("cancelled diary work stays cancelled across settings changes and rejects late output", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let seenSignal: AbortSignal | undefined;
  const runtime = createTestRuntime({ diaryGenerator: async input => { seenSignal = input.signal; await waiting; return "迟到的正文"; } });
  try {
    const { kernel, bob, world } = setup(runtime);
    const entry = kernel.characterDiaries.capture(source(bob.id, world.id));
    const processing = kernel.characterDiaries.drain();
    const task = kernel.characterBackgroundTasks.list(bob.id, "normal").find(task => task.status === "running")!;
    assert.ok(task.id.endsWith(":narrative"));
    kernel.characterBackgroundTasks.control(bob.id, "normal", task.id, "cancel");
    assert.equal(seenSignal?.aborted, true);
    kernel.characterDiaries.updateSettings(bob.id, { narrativeEnabled: true, preset: "" });
    release();
    await processing;
    await kernel.characterDiaries.drain();
    assert.equal(kernel.characterDiaries.get(bob.id, entry.id).narrative, undefined);
    assert.equal(kernel.characterDiaries.get(bob.id, entry.id).jobs.find(job => job.kind === "narrative")?.status, "cancelled");
    kernel.characterBackgroundTasks.control(bob.id, "normal", task.id, "retry");
    await kernel.characterDiaries.drain();
    assert.equal(kernel.characterDiaries.get(bob.id, entry.id).narrative, "迟到的正文");
  } finally { release(); runtime.dispose(); }
});

test("cancelling a running collaboration fences execution, reporting and late replies", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  let reports = 0;
  const runtime = createTestRuntime({ characterInteractionActor: async input => { signal = input.signal; started(); await waiting; return "LATE_COLLAB_RESULT"; },
    characterCollaborationReporter: async () => { reports++; return "不应发送"; } });
  try {
    const { kernel, alice, bob } = setup(runtime);
    const queued = await kernel.characterInteractionCoordinator.queueCharacterHelp({ sourceCharacterId: alice.id, targetCharacterId: bob.id,
      task: "整理读书会资料", idempotencyKey: "cancel-collaboration" });
    const drain = kernel.characterInteractionCoordinator.drain();
    await entered;
    const task = kernel.characterBackgroundTasks.list(alice.id, "normal").find(task => task.kind === "collaboration")!;
    assert.equal(task.canCancel, true);
    assert.equal(kernel.characterBackgroundTasks.list(bob.id, "normal").find(task => task.kind === "collaboration")?.canCancel, false);
    kernel.characterBackgroundTasks.control(alice.id, "normal", task.id, "cancel");
    assert.equal(signal?.aborted, true);
    release();
    await drain;
    assert.equal(kernel.characterChannels.repository.getEpisode(queued.episode.id)?.status, "cancelled");
    assert.equal(kernel.characterChannels.repository.getCollaborationJob(queued.episode.id)?.status, "cancelled");
    assert.doesNotMatch(JSON.stringify(kernel.characterChannels.repository.listMessages(queued.channel.id)), /LATE_COLLAB_RESULT/);
    assert.equal(reports, 0);
  } finally { release(); runtime.dispose(); }
});

test("normal and secret requests enter only their bound private model context", async () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, alice, bob } = setup(runtime);
    kernel.createCharacterGoal(alice.id, "normal", { kind: "request", title: "NORMAL_GOAL_SENTINEL" });
    kernel.createCharacterGoal(alice.id, "secret", { kind: "request", title: "SECRET_GOAL_SENTINEL" });
    for (const [sessionId, characterId, conversationSpace] of [["goal-normal", alice.id, "normal"], ["goal-secret", alice.id, "secret"], ["goal-peer", bob.id, "normal"]] as const) {
      runtime.model.enqueue([{ kind: "assistant_text", text: "我记得。" }]);
      await kernel.sendMessage(sessionId, { mode: "sms", characterId, conversationSpace, text: "继续之前那件事" });
      const request = JSON.stringify(runtime.model.requests.at(-1));
      if (sessionId === "goal-normal") { assert.match(request, /NORMAL_GOAL_SENTINEL/); assert.doesNotMatch(request, /SECRET_GOAL_SENTINEL/); }
      else if (sessionId === "goal-secret") { assert.match(request, /SECRET_GOAL_SENTINEL/); assert.doesNotMatch(request, /NORMAL_GOAL_SENTINEL/); }
      else assert.doesNotMatch(request, /NORMAL_GOAL_SENTINEL|SECRET_GOAL_SENTINEL/);
    }
  } finally { runtime.dispose(); }
});

test("departure preserves actual intersections and directional relationship, not private data or strangers", async () => {
  const runtime = createTestRuntime({ characterInteractionActor: async () => "下次一起去看书吧。", characterInteractionSceneComposer: async () => ({
    narrativeText: "两个人在书店聊起了书。", eventSummary: "两人聊起了书。", sourcePerspectiveSummary: "我们说起下次读书。", targetPerspectiveSummary: "我记得这次聊天。",
  }) });
  try {
    const { kernel, alice, bob, stranger, world } = setup(runtime);
    const exchange = await kernel.sendCharacterChannelMessage({ sourceCharacterId: alice.id, targetCharacterId: bob.id, message: "周末一起看书？", idempotencyKey: "intersection", source: "manual" });
    kernel.database.connection.prepare("UPDATE world_character_relationships SET romance_status='committed' WHERE subject_character_id=? AND object_character_id=?").run(bob.id, alice.id);
    kernel.writeRpMemory({ realm: "roleplay", scope: "character", type: "plot_event", content: "SECRET_PRIVATE_SENTINEL", characterId: alice.id, conversationSpace: "secret", secretOwnerCharacterId: alice.id, confirmed: true });
    await kernel.memoryCoordinator.drain();
    await kernel.postTurnCoordinator.drain();
    const before = kernel.characterDiaries.list(bob.id).map(entry => entry.id);
    const removed = kernel.deleteCharacter(alice.id, alice.name);
    assert.equal(removed.departureCount, 1);
    const memories = kernel.characterDepartures.list(bob.id);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].relationship?.romanceStatus, "committed");
    assert.match(memories[0].summary, /搬离/);
    assert.ok(memories[0].experiences.some(value => value.sourceId === exchange.episode.id));
    assert.doesNotMatch(JSON.stringify(memories), /SECRET_PRIVATE_SENTINEL|DEPARTED_PRIVATE_SOUL/);
    assert.equal(kernel.characterDepartures.list(stranger.id).length, 0);
    const remembered = kernel.searchRpMemories({ characterId: bob.id, type: "relationship_event", confirmedOnly: true });
    assert.equal(remembered.filter(memory => memory.key === `departure:${memories[0].id}`).length, 1);
    assert.match(remembered.find(memory => memory.key === `departure:${memories[0].id}`)!.content, /搬离/);
    // Simulate a crash after the Vault write but before its projection checkpoint.
    kernel.database.connection.prepare("UPDATE character_departure_memories SET memory_materialized_at=NULL WHERE id=?").run(memories[0].id);
    kernel.getCharacterRecentActivity(bob.id);
    assert.equal(kernel.searchRpMemories({ characterId: bob.id, type: "relationship_event", confirmedOnly: true }).filter(memory => memory.key === `departure:${memories[0].id}`).length, 1);
    assert.deepEqual(kernel.characterDiaries.list(bob.id).map(entry => entry.id), before);
    assert.match(kernel.characterDepartures.context(bob.id, world.id), /林澈/);
    assert.equal(kernel.characterDepartures.context(stranger.id, world.id), "");
    assert.equal(kernel.getCharacterRecentActivity(bob.id, "secret").departures.length, 0);
    assert.equal(kernel.getCharacterDiary(bob.id).departedRelationships[0].peerName, alice.name);
    assert.deepEqual(kernel.database.connection.prepare("PRAGMA foreign_key_check").all(), []);
    const replacement = kernel.createCharacter({ name: alice.name });
    assert.notEqual(replacement.id, memories[0].departedCharacterId);
    assert.equal(kernel.characterDepartures.list(replacement.id).length, 0);
    assert.doesNotMatch(JSON.stringify(await kernel.exportUserData("secret", bob.id)), /departed_character_id|搬离/);
  } finally { runtime.dispose(); }
});

test("explicit data-only deletion does not fabricate a departure or retain new identity snapshots", () => {
  const runtime = createTestRuntime();
  try {
    const { kernel, alice, bob, world } = setup(runtime);
    kernel.worldConversationService.applyRelationshipDelta({ worldId: world.id, subjectCharacterId: bob.id, objectCharacterId: alice.id,
      affinityDelta: 1, trustDelta: 1, tensionDelta: 0, intimacyDelta: 0, summary: "认识" });
    kernel.deleteCharacter(alice.id, alice.name, "delete");
    assert.equal(kernel.characterDepartures.list(bob.id).length, 0);
  } finally { runtime.dispose(); }
});

test("life schema upgrades from 53 and persistent goals/interrupted tasks survive restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-life-restart-"));
  const migrationFile = join(stateDir, "legacy.sqlite");
  const legacy = new AppDatabase(migrationFile, { maxMigrationVersion: 53 });
  legacy.close();
  const upgraded = new AppDatabase(migrationFile);
  assert.equal(upgraded.connection.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 59);
  upgraded.close();
  let runtime = createTestRuntime({ stateDir });
  try {
    const { kernel, bob, world } = setup(runtime);
    const goal = kernel.createCharacterGoal(bob.id, "normal", { kind: "request", title: "跨会话委托" });
    const now = runtime.clock.now().toISOString();
    kernel.database.connection.prepare("INSERT INTO character_planning_jobs VALUES ('interrupted',?,?,'running',NULL,?,?)").run(bob.id, world.id, now, now);
    const entry = kernel.characterDiaries.capture(source(bob.id, world.id));
    kernel.characterDiaries.cancel(bob.id, entry.id, "narrative");
    runtime.dispose();
    runtime = createTestRuntime({ stateDir });
    assert.equal(runtime.kernel.characterGoals.get(bob.id, "normal", goal.id).title, "跨会话委托");
    assert.equal(runtime.kernel.characterBackgroundTasks.list(bob.id, "normal").find(task => task.kind === "planning")?.status, "failed");
    assert.equal(runtime.kernel.characterDiaries.get(bob.id, entry.id).jobs.find(job => job.kind === "narrative")?.status, "cancelled");
    await runtime.kernel.deleteAllUserData();
    for (const table of ["character_life_goals", "character_life_goal_steps", "character_departure_memories", "character_planning_jobs"]) {
      assert.equal(runtime.kernel.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    }
  } finally { runtime.dispose(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("recent-activity HTTP binds writes to local control and exact character/space", async () => {
  const runtime = createTestRuntime();
  const { kernel, alice, bob } = setup(runtime);
  const server = createHttpServer({ kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(origin);
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]; await response.body?.cancel();
    const headers = { "content-type": "application/json", origin, cookie, "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" };
    const url = `${origin}/api/v1/characters/${alice.id}/goals`;
    const payload = { kind: "request", title: "HTTP_PRIVATE_GOAL" };
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status, 403);
    const created = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const body = await created.json() as { goal: { id: string; revision: number } };
    const patch = { action: "cancel", revision: body.goal.revision };
    assert.equal((await fetch(`${url}/${body.goal.id}?space=secret`, { method: "PATCH", headers, body: JSON.stringify(patch) })).status, 400);
    assert.equal((await fetch(`${origin}/api/v1/characters/${bob.id}/goals/${body.goal.id}`, { method: "PATCH", headers, body: JSON.stringify(patch) })).status, 400);
    const secret = await fetch(`${origin}/api/v1/characters/${alice.id}/recent-activity?space=secret`);
    assert.doesNotMatch(await secret.text(), /HTTP_PRIVATE_GOAL/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.dispose(); }
});
