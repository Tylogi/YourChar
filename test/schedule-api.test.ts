import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("schedule v1 API supports create, list, update, complete, and idempotency", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-11T09:00:00.000Z"),
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = {
      kind: "reminder",
      title: "API 提醒",
      startAt: "2026-07-12T09:00:00.000Z",
      timezone: "Asia/Shanghai",
    };
    const create = () =>
      fetch(`${baseUrl}/api/v1/schedule-items`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "api-create" },
        body: JSON.stringify(payload),
      });
    const first = await create();
    const firstBody = (await first.json()) as { item: { id: string } };
    const duplicateBody = (await (await create()).json()) as { item: { id: string } };
    assert.equal(first.status, 201);
    assert.equal(duplicateBody.item.id, firstBody.item.id);

    const list = (await (await fetch(`${baseUrl}/api/v1/schedule-items?status=scheduled`)).json()) as {
      items: Array<{ id: string; occurrences: unknown[] }>;
    };
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].occurrences.length, 1);

    const occurrenceId = kernel.listReminderOccurrences(firstBody.item.id)[0].id;
    kernel.scheduleService.repository.createOutbox({
      id: "failed-notification",
      occurrenceId,
      channel: "in_app",
      status: "failed",
      attempts: 3,
      availableAt: "2026-07-11T09:00:00.000Z",
      lastError: "adapter unavailable",
      agentGenerated: false,
      createdAt: "2026-07-11T09:00:00.000Z",
      updatedAt: "2026-07-11T09:00:00.000Z",
    });
    const retry = await fetch(`${baseUrl}/api/v1/notifications/failed-notification/retry`, {
      method: "POST",
    });
    const retried = (await retry.json()) as { notification: { status: string; attempts: number } };
    assert.equal(retried.notification.status, "pending");
    assert.equal(retried.notification.attempts, 0);

    const patched = await fetch(`${baseUrl}/api/v1/schedule-items/${firstBody.item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "API 提醒已修改" }),
    });
    assert.equal(((await patched.json()) as { item: { title: string } }).item.title, "API 提醒已修改");

    const completed = await fetch(`${baseUrl}/api/v1/schedule-items/${firstBody.item.id}/complete`, {
      method: "POST",
    });
    assert.equal(((await completed.json()) as { item: { status: string } }).item.status, "completed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    kernel.dispose();
  }
});
