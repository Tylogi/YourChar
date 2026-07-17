import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("test control API isolates a run while exercising production v1 routes", async () => {
  const server = createHttpServer({
    kernel: new CompanionKernel({ stateDir: false }),
    testMode: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${baseUrl}/api/_test/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        now: "2026-07-11T09:00:00.000Z",
        timezone: "Asia/Shanghai",
        seed: "http",
      }),
    });
    assert.equal(created.status, 201);
    const { runId } = (await created.json()) as { runId: string };
    const testHeaders = {
      "content-type": "application/json",
      "x-rp-test-run-id": runId,
    };
    const characterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify({ name: "测试角色" }),
    });
    const characterId = ((await characterResponse.json()) as { character: { id: string } }).character.id;
    assert.equal(characterResponse.status, 201);

    const queued = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/model/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [{ kind: "assistant_text", text: "HTTP 测试回复" }] }),
    });
    assert.equal(queued.status, 200);

    const message = await fetch(`${baseUrl}/api/v1/sessions/http-session/messages`, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify({ mode: "sms", characterId, text: "hello" }),
    });
    assert.equal(message.status, 200);
    assert.equal(((await message.json()) as { reply: string }).reply, "HTTP 测试回复");
    const runSessions = await fetch(`${baseUrl}/api/v1/sessions`, {
      headers: { "x-rp-test-run-id": runId },
    });
    const runSessionBody = (await runSessions.json()) as {
      sessions: Array<{ id: string; mode: string; characterId: string }>;
    };
    assert.deepEqual(runSessionBody.sessions.map(({ id, mode, characterId: boundCharacterId }) => ({
      id,
      mode,
      characterId: boundCharacterId,
    })), [{ id: "http-session", mode: "sms", characterId }]);

    const schedule = await fetch(`${baseUrl}/api/v1/schedule-items`, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify({
        kind: "reminder",
        title: "测试通知",
        startAt: "2026-07-11T09:01:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    });
    assert.equal(schedule.status, 201);

    const memoryResponse = await fetch(`${baseUrl}/api/v1/memories`, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify({
        type: "plot_event",
        content: "角色完成了测试驱动的演练",
        characterId,
      }),
    });
    assert.equal(memoryResponse.status, 201);
    const memoryBody = await memoryResponse.json() as {
      memory: { confirmed: boolean; validity: string };
    };
    assert.equal(memoryBody.memory.confirmed, false);
    assert.equal(memoryBody.memory.validity, "pending");

    const advanced = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/clock/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milliseconds: 60_000 }),
    });
    assert.equal(((await advanced.json()) as { now: string }).now, "2026-07-11T09:01:00.000Z");

    const tick = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/scheduler/tick`, { method: "POST" });
    assert.deepEqual(await tick.json(), { claimed: 1, delivered: 1, failed: 0 });
    const notifications = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/notifications`);
    assert.equal(((await notifications.json()) as { notifications: unknown[] }).notifications.length, 1);

    const snapshot = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/snapshot`);
    const snapshotBody = (await snapshot.json()) as {
      sessions: Array<{ id: string }>;
      scheduleItems: unknown[];
      characters: unknown[];
      memories: unknown[];
    };
    assert.deepEqual(snapshotBody.sessions.map((session) => session.id), ["http-session"]);
    assert.equal(snapshotBody.scheduleItems.length, 1);
    assert.equal(snapshotBody.characters.length, 1);
    assert.equal(snapshotBody.memories.length, 1);

    const productionSessions = await fetch(`${baseUrl}/api/v1/sessions`);
    assert.deepEqual(await productionSessions.json(), { sessions: [] });
    const productionCharacters = await fetch(`${baseUrl}/api/v1/characters`);
    assert.deepEqual(await productionCharacters.json(), { characters: [] });

    const deleted = await fetch(`${baseUrl}/api/_test/v1/runs/${runId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("test control API is unavailable by default", async () => {
  const server = createHttpServer({ kernel: new CompanionKernel({ stateDir: false }), testMode: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/_test/v1/runs`, { method: "POST" });
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
