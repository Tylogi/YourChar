import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("HTTP user messages require and preserve a fixed character-bound session", async () => {
  const kernel = new CompanionKernel({ stateDir: false });
  const character = kernel.createCharacter({ name: "会话角色" });
  await kernel.sendMessage("default", { mode: "sms", text: "旧版默认会话" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const post = (sessionId: string, body: Record<string, unknown>) => fetch(
      `${baseUrl}/api/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const missing = await post("new-unbound", { mode: "sms", text: "你好" });
    assert.equal(missing.status, 422);
    assert.equal(((await missing.json()) as { code: string }).code, "CHARACTER_REQUIRED");

    const legacy = await post("default", {
      mode: "sms",
      characterId: character.id,
      text: "尝试继续旧会话",
    });
    assert.equal(legacy.status, 422);
    assert.match(((await legacy.json()) as { error: string }).error, /legacy unbound session/);

    const created = await post("generated-session-id", {
      mode: "sms",
      characterId: character.id,
      text: "建立新会话",
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as { messageType?: string; status?: string; canRetry?: boolean };
    assert.equal(createdBody.messageType, "system");
    assert.equal(createdBody.status, "blocked");
    assert.equal(createdBody.canRetry, false);

    const continued = await post("generated-session-id", { text: "继续已有会话" });
    assert.equal(continued.status, 200);

    const mismatch = await post("generated-session-id", {
      mode: "rp",
      characterId: character.id,
      text: "错误切换模式",
    });
    assert.equal(mismatch.status, 409);
    assert.equal(((await mismatch.json()) as { code: string }).code, "SESSION_MODE_MISMATCH");

    const sessions = (await (await fetch(`${baseUrl}/api/v1/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        mode?: string;
        characterId?: string;
        title?: string;
        lastTurnStatus?: string;
        lastTurnCanRetry?: boolean;
      }>;
    };
    const current = sessions.sessions.find((session) => session.id === "generated-session-id");
    assert.deepEqual(
      { mode: current?.mode, characterId: current?.characterId },
      { mode: "sms", characterId: character.id },
    );
    assert.equal(current?.title, "建立新会话");
    assert.equal(current?.lastTurnStatus, "blocked");
    assert.equal(current?.lastTurnCanRetry, false);
    assert.equal(sessions.sessions.some((session) => session.id === "default" && !session.characterId), true);
    const updatedAt = (current as { updatedAt?: string } | undefined)?.updatedAt;
    const listedAgain = (await (await fetch(`${baseUrl}/api/v1/sessions`)).json()) as {
      sessions: Array<{ id: string; updatedAt: string }>;
    };
    assert.equal(
      listedAgain.sessions.find((session) => session.id === "generated-session-id")?.updatedAt,
      updatedAt,
      "listing sessions must not mark them active",
    );

    const renamed = await fetch(`${baseUrl}/api/v1/sessions/generated-session-id`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "日常角色私聊" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(
      ((await renamed.json()) as { session: { title: string } }).session.title,
      "日常角色私聊",
    );

    const invalidTitle = await fetch(`${baseUrl}/api/v1/sessions/generated-session-id`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    assert.equal(invalidTitle.status, 400);
    assert.equal(((await invalidTitle.json()) as { code: string }).code, "SESSION_TITLE_INVALID");

    const archived = await fetch(`${baseUrl}/api/v1/sessions/generated-session-id/archive`, {
      method: "POST",
    });
    assert.equal(archived.status, 200);
    assert.ok(((await archived.json()) as { session: { archivedAt?: string } }).session.archivedAt);

    const activeSessions = (await (await fetch(`${baseUrl}/api/v1/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    assert.equal(activeSessions.sessions.some((session) => session.id === "generated-session-id"), false);
    const allSessions = (await (await fetch(`${baseUrl}/api/v1/sessions?includeArchived=1`)).json()) as {
      sessions: Array<{ id: string; title?: string; archivedAt?: string }>;
    };
    const archivedSession = allSessions.sessions.find((session) => session.id === "generated-session-id");
    assert.equal(archivedSession?.title, "日常角色私聊");
    assert.ok(archivedSession?.archivedAt);

    const archivedWrite = await post("generated-session-id", { text: "归档后继续发送" });
    assert.equal(archivedWrite.status, 409);
    assert.equal(((await archivedWrite.json()) as { code: string }).code, "SESSION_ARCHIVED");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    kernel.dispose();
  }
});

test("session batch management validates the full selection before archive and permanent deletion", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const character = kernel.createCharacter({ name: "批量管理角色" });
  await kernel.sendMessage("batch-one", { mode: "sms", characterId: character.id, text: "批量会话一" });
  await kernel.sendMessage("batch-two", { mode: "rp", characterId: character.id, text: "批量会话二" });
  await kernel.sendMessage("batch-keep", { mode: "sms", characterId: character.id, text: "保留会话" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const batch = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/v1/sessions/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const empty = await batch({ action: "archive", sessionIds: [] });
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { code: string }).code, "SESSION_BATCH_INVALID");

    const duplicate = await batch({ action: "archive", sessionIds: ["batch-one", "batch-one"] });
    assert.equal(duplicate.status, 400);
    assert.equal(kernel.listConversationMetadata().find((entry) => entry.id === "batch-one")?.archivedAt, undefined);

    const missing = await batch({ action: "archive", sessionIds: ["batch-one", "missing-session"] });
    assert.equal(missing.status, 404);
    assert.equal(kernel.listConversationMetadata().find((entry) => entry.id === "batch-one")?.archivedAt, undefined);

    const archived = await batch({ action: "archive", sessionIds: ["batch-one", "batch-two"] });
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as { count: number }).count, 2);
    assert.ok(kernel.listConversationMetadata().find((entry) => entry.id === "batch-one")?.archivedAt);
    assert.ok(kernel.listConversationMetadata().find((entry) => entry.id === "batch-two")?.archivedAt);

    const wrongConfirmation = await batch({
      action: "delete",
      sessionIds: ["batch-one", "batch-two"],
      confirmation: "永久删除 1 个会话",
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "batch-one"), true);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "batch-two"), true);

    const deleted = await batch({
      action: "delete",
      sessionIds: ["batch-one", "batch-two"],
      confirmation: "永久删除 2 个会话",
    });
    assert.equal(deleted.status, 200);
    assert.equal(((await deleted.json()) as { count: number }).count, 2);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "batch-one"), false);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "batch-two"), false);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "batch-keep"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

test("session restore and permanent deletion clean only session-owned data", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-session-delete-"));
  const kernel = new CompanionKernel({ stateDir, startScheduler: false });
  const character = kernel.createCharacter({ name: "生命周期角色" });
  const sharedMemory = kernel.writeRpMemory({
    realm: "roleplay",
    scope: "character",
    type: "relationship_event",
    content: "角色与用户共享的长期记忆",
    characterId: character.id,
    confirmed: true,
  }).memory;
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionId = "delete-lifecycle";
    const sent = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "rp",
        characterId: character.id,
        text: "5分钟后提醒我喝水",
      }),
    });
    assert.equal(sent.status, 200);
    kernel.updateScene(sessionId, { location: "测试场景", summary: "仅属于待删除会话" }, character.id);
    kernel.createScheduleItem({
      kind: "reminder",
      title: "删除会话后仍保留的现实提醒",
      startAt: "2026-12-01T09:00:00.000Z",
      timezone: "Asia/Shanghai",
      sourceSessionId: sessionId,
    });
    const transcriptPath = kernel.listConversationMetadata().find((entry) => entry.id === sessionId)?.piSessionFile;
    assert.ok(transcriptPath && existsSync(transcriptPath));
    assert.ok(kernel.rpService.getScene(sessionId));
    assert.equal(kernel.rpService.repository.listPendingMutations().some((entry) => entry.sessionId === sessionId), true);

    assert.equal((await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/archive`, { method: "POST" })).status, 200);
    const restored = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/restore`, { method: "POST" });
    assert.equal(restored.status, 200);
    assert.equal(((await restored.json()) as { session: { archivedAt?: string } }).session.archivedAt, undefined);

    const unconfirmedDelete = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "wrong title" }),
    });
    assert.equal(unconfirmedDelete.status, 400);
    assert.equal(
      ((await unconfirmedDelete.json()) as { code: string }).code,
      "SESSION_DELETE_CONFIRMATION_REQUIRED",
    );

    const deleted = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "5分钟后提醒我喝水" }),
    });
    assert.equal(deleted.status, 200);
    const deletion = (await deleted.json()) as {
      cleanup: { roleSessions: number; pendingMutations: number; contextLogs: number };
    };
    assert.equal(deletion.cleanup.roleSessions, 1);
    assert.equal(deletion.cleanup.pendingMutations, 1);
    assert.ok(deletion.cleanup.contextLogs >= 1);
    assert.equal(existsSync(transcriptPath), false);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === sessionId), false);
    assert.equal(kernel.rpService.repository.getRoleSession(sessionId), undefined);
    assert.equal(kernel.rpService.repository.getScene(sessionId), undefined);
    assert.equal(kernel.rpService.repository.listPendingMutations().some((entry) => entry.sessionId === sessionId), false);
    assert.equal(kernel.searchRpMemories({ characterId: character.id }).some((entry) => entry.id === sharedMemory?.id), true);
    assert.equal(kernel.listScheduleItems().some((entry) => entry.sourceSessionId === sessionId), true);
    assert.equal(kernel.recentContextLogs(100).some((entry) => entry.sessionId === sessionId), false);
    const listed = (await (await fetch(`${baseUrl}/api/v1/sessions?includeArchived=1`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    assert.equal(listed.sessions.some((entry) => entry.id === sessionId), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
