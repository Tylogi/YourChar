import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("schedule HTTP API keeps user and character calendars isolated", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const character = kernel.createCharacter({ name: "HTTP 日程角色" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const create = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/v1/schedule-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal((await create({
      kind: "task",
      title: "用户任务",
      timezone: "Asia/Shanghai",
    })).status, 201);
    assert.equal((await create({
      kind: "event",
      title: "角色安排",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: character.id,
    })).status, 201);

    const userItems = await (await fetch(`${baseUrl}/api/v1/schedule-items?ownerType=user`)).json() as {
      items: Array<{ title: string; ownerType: string; characterId?: string }>;
    };
    assert.deepEqual(userItems.items.map((entry) => entry.title), ["用户任务"]);
    assert.deepEqual(userItems.items.map((entry) => entry.ownerType), ["user"]);

    const characterItems = await (await fetch(
      `${baseUrl}/api/v1/schedule-items?ownerType=character&characterId=${encodeURIComponent(character.id)}`,
    )).json() as { items: Array<{ title: string; ownerType: string; characterId?: string }> };
    assert.deepEqual(characterItems.items.map((entry) => entry.title), ["角色安排"]);
    assert.equal(characterItems.items[0].characterId, character.id);

    const missingCharacter = await fetch(`${baseUrl}/api/v1/schedule-items?ownerType=character`);
    assert.equal(missingCharacter.status, 400);

    const characterReminder = await create({
      kind: "reminder",
      title: "不应通知",
      startAt: "2099-01-01T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: character.id,
    });
    assert.equal(characterReminder.status, 400);
    assert.equal(((await characterReminder.json()) as { code: string }).code, "SCHEDULE_INVALID");

    const invalidCharacter = await create({
      kind: "event",
      title: "无效角色",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: "missing-character",
    });
    assert.equal(invalidCharacter.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});
