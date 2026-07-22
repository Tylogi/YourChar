import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("group chat HTTP APIs create, list, persist messages, and stream participant states", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const first = kernel.createCharacter({ name: "甲" });
  const second = kernel.createCharacter({ name: "乙" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const invalid = await fetch(`${baseUrl}/api/v1/group-chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterIds: [first.id] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, "GROUP_CHAT_INVALID");

    const created = await fetch(`${baseUrl}/api/v1/group-chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "API 群聊",
        mode: "sms",
        characterIds: [first.id, second.id],
        maxSpeakers: 2,
      }),
    });
    assert.equal(created.status, 201);
    const group = ((await created.json()) as { group: { id: string; characterIds: string[] } }).group;
    assert.deepEqual(group.characterIds, [first.id, second.id]);

    const sent = await fetch(`${baseUrl}/api/v1/group-chats/${encodeURIComponent(group.id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "有人吗？" }),
    });
    assert.equal(sent.status, 200);
    const result = (await sent.json()) as {
      turn: { status: string; modelCalls: number; speakerCount: number };
      decisions: Array<{ outcome: string; reasonCode: string }>;
    };
    assert.equal(result.turn.status, "failed");
    assert.equal(result.turn.modelCalls, 0);
    assert.equal(result.turn.speakerCount, 0);
    assert.equal(result.decisions.length, 2);
    assert.equal(result.decisions.every((entry) => entry.outcome === "failed" && entry.reasonCode === "model_unavailable"), true);

    const history = await fetch(`${baseUrl}/api/v1/group-chats/${encodeURIComponent(group.id)}/messages`);
    const historyBody = (await history.json()) as { messages: Array<{ senderType: string; content: string }> };
    assert.deepEqual(historyBody.messages.map((message) => [message.senderType, message.content]), [["user", "有人吗？"]]);

    const streamed = await fetch(`${baseUrl}/api/v1/group-chats/${encodeURIComponent(group.id)}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "再问一次" }),
    });
    assert.equal(streamed.status, 200);
    const streamText = await streamed.text();
    assert.match(streamText, /"type":"participant_state"/);
    assert.match(streamText, /"phase":"failed"/);
    assert.match(streamText, /"type":"done"/);

    const listed = await fetch(`${baseUrl}/api/v1/group-chats`);
    const listedBody = (await listed.json()) as { groups: Array<{ id: string; title: string }> };
    assert.equal(listedBody.groups.some((entry) => entry.id === group.id && entry.title === "API 群聊"), true);

    const archived = await fetch(`${baseUrl}/api/v1/conversations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive", sessionIds: [], groupIds: [group.id] }),
    });
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as { count: number }).count, 1);
    const activeAfterArchive = (await (await fetch(`${baseUrl}/api/v1/group-chats`)).json()) as {
      groups: Array<{ id: string }>;
    };
    assert.equal(activeAfterArchive.groups.some((entry) => entry.id === group.id), false);
    const allAfterArchive = (await (await fetch(`${baseUrl}/api/v1/group-chats?includeArchived=1`)).json()) as {
      groups: Array<{ id: string; status: string }>;
    };
    assert.equal(allAfterArchive.groups.find((entry) => entry.id === group.id)?.status, "archived");

    const restored = await fetch(`${baseUrl}/api/v1/group-chats/${encodeURIComponent(group.id)}/restore`, { method: "POST" });
    assert.equal(restored.status, 200);
    const wrongDelete = await fetch(`${baseUrl}/api/v1/conversations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", sessionIds: [], groupIds: [group.id], confirmation: "wrong" }),
    });
    assert.equal(wrongDelete.status, 400);
    const deleted = await fetch(`${baseUrl}/api/v1/conversations/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        sessionIds: [],
        groupIds: [group.id],
        confirmation: "永久删除 1 个会话",
      }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/v1/group-chats/${encodeURIComponent(group.id)}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});
