import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CharacterDeletionConfirmationError, ControlPlaneBusyError } from "../src/domain/kernel.js";
import { createTestRuntime } from "../src/testing/index.js";
import { createHttpServer } from "../src/http/router.js";

test("deleting a character removes both spaces and owned data without deleting shared history or other characters", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-character-delete-"));
  let runtime = createTestRuntime({ stateDir, seed: "delete-owner" });
  try {
    const kernel = runtime.kernel;
    const owner = kernel.createCharacter({ name: "林澈" });
    const peer = kernel.createCharacter({ name: "顾遥" });
    const world = kernel.createWorld({ name: "河岸" });
    for (const character of [owner, peer]) kernel.assignCharacterWorld(character.id, { worldId: world.id });
    const normal = await kernel.openCanonicalPrivateConversation(owner.id);
    const secret = await kernel.openCanonicalPrivateConversation(owner.id, "secret");
    const peerSession = await kernel.openCanonicalPrivateConversation(peer.id);
    for (const session of [normal, secret, peerSession]) {
      const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", session.characterId);
      kernel.sessionRuntime.appendMessages(handle, [fauxAssistantMessage("需要保留或清理的会话记录")]);
    }
    kernel.archiveConversation(secret.id);
    kernel.updateScene(normal.id, { summary: "只有林澈知道的事" }, owner.id);
    for (const character of [owner, peer]) {
      for (const space of ["normal", "secret"] as const) kernel.writeRpMemory({
        realm: "roleplay", scope: "character", type: "plot_event", confirmed: true,
        content: character.name + "的专属往事", characterId: character.id, conversationSpace: space,
        ...(space === "secret" ? { secretOwnerCharacterId: character.id } : {}),
      });
    }
    kernel.updateUserProfile("共享用户画像不应删除");
    const ownedSchedule = kernel.createScheduleItem({ kind: "task", title: "整理书架", timezone: "Asia/Shanghai", ownerType: "character", characterId: owner.id }).item;
    const userSchedule = kernel.createScheduleItem({ kind: "task", title: "用户任务", timezone: "Asia/Shanghai" }).item;
    const now = runtime.clock.now().toISOString();
    const diary = kernel.characterDiaries.capture({
      kind: "activity", id: "owner-experience", characterId: owner.id, characterName: owner.name,
      worldId: world.id, worldName: world.name, timezone: "Asia/Shanghai", title: "整理书架",
      occurredAt: now, soul: owner.soulMarkdown, observations: ["我整理了书架。"], statements: [],
    });
    const group = kernel.createGroupChat({ title: "保留的群聊", characterIds: [owner.id, peer.id] });
    kernel.groupChatService.repository.createTurn({ id: "kept-turn", groupId: group.id, status: "completed", modelCalls: 0, speakerCount: 1, messageCount: 1, startedAt: now });
    kernel.groupChatService.repository.appendMessage({ id: "kept-message", groupId: group.id, turnId: "kept-turn", senderType: "character", senderId: owner.id, content: "保留的共同往事", createdAt: now });
    kernel.transitionWorldStoryEvent(world.id, { action: "begin", source: "user_control", title: "共同事件", participantIds: [owner.id, peer.id] });
    await kernel.memoryCoordinator.drain();
    await kernel.postTurnCoordinator.drain();

    assert.throws(() => kernel.deleteCharacter(owner.id, "顾遥"), CharacterDeletionConfirmationError);
    assert.equal(kernel.listCharacters().length, 2);
    const deleted = kernel.deleteCharacter(owner.id, owner.name);
    assert.deepEqual(deleted.deletedSessionIds.sort(), [normal.id, secret.id].sort());
    assert.deepEqual(kernel.listCharacters().map(character => character.id), [peer.id]);
    assert.ok(kernel.getConversationMetadata(peerSession.id));
    assert.equal(kernel.getConversationMetadata(normal.id), undefined);
    assert.equal(kernel.getConversationMetadata(secret.id), undefined);
    assert.equal(existsSync(join(stateDir, "characters", owner.id)), false);
    assert.ok(kernel.memoryVault.store.list().every(document => document.metadata.characterId !== owner.id && document.metadata.secretOwnerCharacterId !== owner.id));
    assert.match(kernel.getUserProfile().markdown, /共享用户画像/);
    assert.equal(kernel.getScheduleItem(userSchedule.id).title, "用户任务");
    assert.throws(() => kernel.getScheduleItem(ownedSchedule.id));
    assert.deepEqual(kernel.getGroupChat(group.id).characterIds, [peer.id]);
    assert.equal(kernel.groupChatService.listMessages(group.id)[0].content, "保留的共同往事");
    assert.deepEqual(kernel.listWorldMapSnapshots()[0].characters.map(character => character.characterId), [peer.id]);
    assert.equal(kernel.database.connection.prepare("SELECT id FROM character_diary_entries WHERE id = ?").get(diary.id), undefined);
    assert.deepEqual(kernel.database.connection.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(readdirSync(join(stateDir, "pi-sessions"), { recursive: true }).filter(path => String(path).endsWith(".jsonl")).length, 1);

    runtime.dispose();
    runtime = createTestRuntime({ stateDir, seed: "after-delete" });
    assert.deepEqual(runtime.kernel.listCharacters().map(character => character.id), [peer.id]);
    assert.equal(runtime.kernel.getConversationMetadata(normal.id), undefined);
    assert.equal(runtime.kernel.getConversationMetadata(secret.id), undefined);
    runtime.kernel.rebuildMemoryVaultIndex();
    assert.ok(runtime.kernel.memoryVault.store.list().every(document => document.metadata.characterId !== owner.id));
    runtime.kernel.deleteCharacter(peer.id, peer.name);
    assert.deepEqual(runtime.kernel.listCharacters(), []);
    assert.deepEqual(runtime.kernel.getGroupChat(group.id).characterIds, []);
    assert.equal(runtime.kernel.groupChatService.listMessages(group.id).length, 1);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("character deletion refuses queued turns and IM routing before changing any data", async () => {
  const runtime = createTestRuntime({ seed: "delete-busy" });
  try {
    const kernel = runtime.kernel;
    const character = kernel.createCharacter({ name: "正在工作" });
    const session = await kernel.openCanonicalPrivateConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "完成了" }]);
    const turn = kernel.sendMessage(session.id, { text: "你好" });
    assert.throws(() => kernel.deleteCharacter(character.id, character.name), ControlPlaneBusyError);
    assert.ok(kernel.getCharacter(character.id));
    await turn;
    await kernel.memoryCoordinator.drain();
    await kernel.postTurnCoordinator.drain();
    kernel.imIntegrations.setCharacterRoute("wechat", character.id);
    assert.throws(() => kernel.deleteCharacter(character.id, character.name), /IM 设置/);
    kernel.imIntegrations.clearCharacterRoute("wechat");
    kernel.deleteCharacter(character.id, character.name);
    assert.deepEqual(kernel.listCharacters(), []);
  } finally { runtime.dispose(); }
});

test("HTTP character deletion requires local-control protection and exact current-name confirmation", async () => {
  const runtime = createTestRuntime({ seed: "delete-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const character = runtime.kernel.createCharacter({ name: "<测试角色>" });
    const endpoint = `${origin}/api/v1/characters/${character.id}`;
    const bootstrap = await fetch(origin);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0];
    await bootstrap.body?.cancel();
    const headers = { "content-type": "application/json", origin, cookie, "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" };
    const unsafe = await fetch(endpoint, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: character.name }) });
    assert.equal(unsafe.status, 403);
    const wrong = await fetch(endpoint, { method: "DELETE", headers, body: JSON.stringify({ confirmation: "错的名称" }) });
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as { code: string }).code, "CHARACTER_DELETE_CONFIRMATION_REQUIRED");
    const removed = await fetch(endpoint, { method: "DELETE", headers, body: JSON.stringify({ confirmation: character.name }) });
    assert.equal(removed.status, 200);
    assert.equal((await fetch(endpoint)).status, 404);
    assert.equal((await fetch(endpoint, { method: "DELETE", headers, body: JSON.stringify({ confirmation: character.name }) })).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose();
  }
});
