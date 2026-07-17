import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionKernel } from "../src/domain/index.js";
import {
  CaptureNotificationSink,
  type DeliveryResult,
  type NotificationDelivery,
  type NotificationSink,
} from "../src/notifications/sink.js";
import { createTestRuntime } from "../src/testing/index.js";

test("a due reminder survives process restart and is delivered exactly once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-reminder-restart-"));
  const clock = new VirtualClock("2026-07-20T09:00:00.000Z");
  const sink = new CaptureNotificationSink();
  try {
    const first = new CompanionKernel({ stateDir, clock, notificationSink: sink, startScheduler: false, quietHours: false });
    const created = first.createScheduleItem({
      kind: "reminder",
      title: "跨重启提醒",
      startAt: "2026-07-20T09:01:00.000Z",
      timezone: "Asia/Shanghai",
    });
    first.dispose();

    clock.advance(60_000);
    const second = new CompanionKernel({ stateDir, clock, notificationSink: sink, startScheduler: false, quietHours: false });
    assert.deepEqual(await second.scheduler.tick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.deepEqual(await second.scheduler.tick(), { claimed: 0, delivered: 0, failed: 0 });
    assert.equal(sink.deliveries.length, 1);
    assert.equal(second.listReminderOccurrences(created.item.id)[0].status, "delivered");
    assert.equal(second.listNotificationHistory().length, 1);
    second.dispose();

    const third = new CompanionKernel({ stateDir, clock, notificationSink: sink, startScheduler: false, quietHours: false });
    assert.deepEqual(await third.scheduler.tick(), { claimed: 0, delivered: 0, failed: 0 });
    assert.equal(sink.deliveries.length, 1);
    assert.equal(third.listNotificationHistory()[0].status, "delivered");
    third.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an offline delivery stays in one frozen outbox entry and retries without duplication", async () => {
  const clock = new VirtualClock("2026-07-20T10:00:00.000Z");
  const sink = new OfflineThenOnlineSink();
  const kernel = new CompanionKernel({
    stateDir: false,
    clock,
    idGenerator: new SeededIdGenerator("offline"),
    notificationSink: sink,
    startScheduler: false,
    quietHours: false,
  });
  try {
    kernel.createScheduleItem({
      kind: "reminder",
      title: "离线提醒",
      startAt: "2026-07-20T10:01:00.000Z",
      timezone: "Asia/Shanghai",
    });
    clock.advance(60_000);
    assert.deepEqual(await kernel.scheduler.tick(), { claimed: 1, delivered: 0, failed: 1 });
    const pending = kernel.listNotificationHistory();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].attempts, 1);
    assert.equal(pending[0].deliveryBody, "提醒时间到了：离线提醒");

    sink.online = true;
    clock.advance(60_000);
    assert.deepEqual(await kernel.scheduler.tick(), { claimed: 0, delivered: 1, failed: 0 });
    const delivered = kernel.listNotificationHistory();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, pending[0].id);
    assert.equal(delivered[0].deliveryBody, pending[0].deliveryBody);
    assert.equal(delivered[0].status, "delivered");
    assert.equal(sink.attempts.length, 2);
  } finally {
    kernel.dispose();
  }
});

test("an archived source session receives a neutral reminder without transcript mutation", async () => {
  const runtime = createTestRuntime({ now: "2026-07-20T11:00:00.000Z", seed: "archived-reminder" });
  try {
    const character = runtime.kernel.createCharacter({ name: "归档角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我记住了。" }]);
    await runtime.kernel.sendMessage("archived-source", {
      mode: "sms",
      characterId: character.id,
      text: "建立提醒来源会话",
    });
    runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "归档来源提醒",
      startAt: "2026-07-20T11:01:00.000Z",
      timezone: "Asia/Shanghai",
      sourceSessionId: "archived-source",
    });
    const before = await runtime.kernel.getSession("archived-source");
    runtime.kernel.archiveConversation("archived-source");
    runtime.clock.advance(60_000);

    assert.deepEqual(await runtime.schedulerTick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(runtime.model.requests.length, 1);
    assert.equal(runtime.notifications[0].body, "提醒时间到了：归档来源提醒");
    assert.equal(runtime.notifications[0].agentGenerated, false);
    const after = await runtime.kernel.getSession("archived-source");
    assert.equal(after.messages.length, before.messages.length);
    assert.equal(runtime.kernel.store.allActions().some((action) => action.actionType === "compose_reminder_message"), false);
  } finally {
    runtime.dispose();
  }
});

test("a deleted source session leaves its real reminder but never restores deleted context", async () => {
  const runtime = createTestRuntime({ now: "2026-07-20T12:00:00.000Z", seed: "deleted-reminder" });
  try {
    const character = runtime.kernel.createCharacter({ name: "删除角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我会留意时间。" }]);
    await runtime.kernel.sendMessage("deleted-source", {
      mode: "sms",
      characterId: character.id,
      text: "建立删除测试会话",
    });
    const created = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "删除来源提醒",
      startAt: "2026-07-20T12:01:00.000Z",
      timezone: "Asia/Shanghai",
      sourceSessionId: "deleted-source",
    });
    const metadata = runtime.kernel.listConversationMetadata().find((entry) => entry.id === "deleted-source");
    assert.ok(metadata?.title);
    await runtime.kernel.deleteConversation("deleted-source", metadata.title);
    assert.equal(runtime.kernel.getScheduleItem(created.item.id).sourceSessionId, "deleted-source");
    runtime.clock.advance(60_000);

    assert.deepEqual(await runtime.schedulerTick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(runtime.model.requests.length, 1);
    assert.equal(runtime.notifications[0].body, "提醒时间到了：删除来源提醒");
    assert.equal(runtime.notifications[0].agentGenerated, false);
    assert.equal(runtime.kernel.listConversationMetadata().some((entry) => entry.id === "deleted-source"), false);
    assert.equal((await runtime.kernel.getSession("deleted-source")).messages.length, 0);
  } finally {
    runtime.dispose();
  }
});

class OfflineThenOnlineSink implements NotificationSink {
  readonly channel = "offline-test";
  online = false;
  readonly attempts: NotificationDelivery[] = [];

  async deliver(notification: NotificationDelivery): Promise<DeliveryResult> {
    this.attempts.push(structuredClone(notification));
    return this.online
      ? { delivered: true, detail: "online" }
      : { delivered: false, detail: "user offline" };
  }
}
