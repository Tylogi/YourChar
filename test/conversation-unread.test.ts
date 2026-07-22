import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("completed character replies stay unread until the conversation is explicitly read", async () => {
  const runtime = createTestRuntime({ seed: "conversation-unread" });
  try {
    const character = runtime.kernel.createCharacter({ name: "未读角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一条完整回复。" },
      { kind: "assistant_text", text: "第二条完整回复。" },
    ]);

    await runtime.kernel.sendMessage("conversation-unread", {
      mode: "rp",
      characterId: character.id,
      text: "第一轮",
    });
    await runtime.kernel.sendMessage("conversation-unread", {
      mode: "rp",
      characterId: character.id,
      text: "第二轮",
    });

    assert.equal(
      runtime.kernel.listConversationMetadata().find((entry) => entry.id === "conversation-unread")?.unreadCount,
      2,
    );
    assert.deepEqual(runtime.kernel.listUnreadConversations().map((entry) => [entry.sessionId, entry.unreadCount]), [
      ["conversation-unread", 2],
    ]);

    const read = runtime.kernel.markConversationRead("conversation-unread");
    assert.equal(read.session.unreadCount, 0);
    assert.equal(runtime.kernel.listUnreadConversations().length, 0);

    runtime.kernel.patchModelApiConfig({ enabled: false });
    const blocked = await runtime.kernel.sendMessage("conversation-unread", {
      mode: "rp",
      characterId: character.id,
      text: "模型关闭后的系统提示",
    });
    assert.equal(blocked.messageType, "system");
    assert.equal(runtime.kernel.listUnreadConversations().length, 0);
  } finally {
    runtime.dispose();
  }
});

test("HTTP exposes unified unread state, read acknowledgement, and composer typing heartbeats", async () => {
  const runtime = createTestRuntime({
    seed: "conversation-unread-http",
    startPrivateInboxCoordinator: false,
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const character = runtime.kernel.createCharacter({ name: "HTTP 未读角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "后台完成的角色回复。" }]);
    await runtime.kernel.sendMessage("http-unread", {
      mode: "rp",
      characterId: character.id,
      text: "生成一条回复",
    });

    const unread = await fetch(`${baseUrl}/api/v1/conversation-unread`);
    assert.equal(unread.status, 200);
    assert.deepEqual(
      ((await unread.json()) as { conversations: Array<{ sessionId: string; unreadCount: number }> }).conversations
        .map((entry) => [entry.sessionId, entry.unreadCount]),
      [["http-unread", 1]],
    );
    const listed = await fetch(`${baseUrl}/api/v1/sessions`);
    const session = ((await listed.json()) as { sessions: Array<{ id: string; unreadCount: number }> }).sessions
      .find((entry) => entry.id === "http-unread");
    assert.equal(session?.unreadCount, 1);

    const read = await fetch(`${baseUrl}/api/v1/sessions/http-unread/read`, { method: "POST" });
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { session: { unreadCount: number } }).session.unreadCount, 0);

    const queued = await fetch(`${baseUrl}/api/v1/sessions/http-unread/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId: "typing-http", text: "先别急着读", characterId: character.id, mode: "rp" }),
    });
    assert.equal(queued.status, 202);
    const typing = await fetch(`${baseUrl}/api/v1/sessions/http-unread/inbox/typing`, { method: "POST" });
    assert.equal(typing.status, 200);
    assert.ok(Number.isFinite(new Date(((await typing.json()) as { typingUntil: string }).typingUntil).getTime()));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});
