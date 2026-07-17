import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import {
  CaptureNotificationSink,
  type DeliveryResult,
  type NotificationDelivery,
  type NotificationSink,
} from "../src/notifications/sink.js";
import { QuietHoursPolicy } from "../src/schedule/quiet-hours.js";
import { createTestRuntime } from "../src/testing/index.js";

test("schedule CRUD and idempotent create use SQLite state", () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "crud" });
  try {
    const first = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "喝水",
      startAt: "2026-07-11T09:05:00.000Z",
      timezone: "Asia/Shanghai",
      idempotencyKey: "same-request",
    });
    const duplicate = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "不会重复",
      startAt: "2026-07-11T09:06:00.000Z",
      timezone: "Asia/Shanghai",
      idempotencyKey: "same-request",
    });
    assert.equal(first.item.id, "crud_schedule_0001");
    assert.equal(duplicate.item.id, first.item.id);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);

    const updated = runtime.kernel.updateScheduleItem(first.item.id, { title: "喝一杯水" });
    assert.equal(updated.item.title, "喝一杯水");
    assert.equal(runtime.kernel.completeScheduleItem(first.item.id).status, "completed");
  } finally {
    runtime.dispose();
  }
});

test("character schedules are isolated from user reminders and cannot enter notification delivery", async () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "character-calendar" });
  try {
    const character = runtime.kernel.createCharacter({ name: "日程角色" });
    const characterEvent = runtime.kernel.createScheduleItem({
      kind: "event",
      title: "去未来道具研究所",
      startAt: "2026-07-11T09:01:00.000Z",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: character.id,
    });
    runtime.kernel.createScheduleItem({
      kind: "task",
      title: "整理实验记录",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: character.id,
    });
    runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "用户现实提醒",
      startAt: "2026-07-11T09:01:00.000Z",
      timezone: "Asia/Shanghai",
    });

    assert.equal(characterEvent.item.ownerType, "character");
    assert.equal(characterEvent.item.characterId, character.id);
    assert.equal(runtime.kernel.listScheduleItems({ ownerType: "character", characterId: character.id }).length, 2);
    assert.equal(runtime.kernel.listScheduleItems({ ownerType: "user" }).length, 1);
    assert.throws(() => runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "不得通知用户",
      startAt: "2026-07-11T09:02:00.000Z",
      timezone: "Asia/Shanghai",
      ownerType: "character",
      characterId: character.id,
    }), /do not create real reminders/);

    runtime.clock.advance(60_000);
    assert.deepEqual(await runtime.schedulerTick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(runtime.notifications.length, 1);
    assert.equal(runtime.notifications[0].title, "用户现实提醒");
  } finally {
    runtime.dispose();
  }
});

test("scheduler delivers a due reminder exactly once and creates the next recurrence", async () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "tick" });
  try {
    const result = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "站起来活动",
      startAt: "2026-07-11T09:01:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=DAILY",
    });
    assert.deepEqual(await runtime.schedulerTick(), { claimed: 0, delivered: 0, failed: 0 });

    runtime.clock.advance(60_000);
    assert.deepEqual(await runtime.schedulerTick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.deepEqual(await runtime.schedulerTick(), { claimed: 0, delivered: 0, failed: 0 });
    assert.equal(runtime.notifications.length, 1);

    const occurrences = runtime.kernel.listReminderOccurrences(result.item.id);
    assert.equal(occurrences.length, 2);
    assert.equal(occurrences[0].status, "delivered");
    assert.equal(occurrences[1].dueAt, "2026-07-12T09:01:00.000Z");
    assert.equal(runtime.kernel.listNotificationHistory()[0].status, "delivered");
  } finally {
    runtime.dispose();
  }
});

test("snooze cancels one occurrence and schedules another from virtual now", () => {
  const runtime = createTestRuntime({ now: "2026-07-11T09:00:00.000Z", seed: "snooze" });
  try {
    const created = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "休息",
      startAt: "2026-07-11T09:05:00.000Z",
      timezone: "Asia/Shanghai",
    });
    const snoozed = runtime.kernel.snoozeReminder(created.occurrence!.id, 10);
    assert.equal(snoozed.dueAt, "2026-07-11T09:10:00.000Z");
    assert.deepEqual(
      runtime.kernel.listReminderOccurrences(created.item.id).map((item) => item.status),
      ["snoozed", "scheduled"],
    );
  } finally {
    runtime.dispose();
  }
});

test("schedule items survive kernel restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-schedule-"));
  try {
    const first = new CompanionKernel({ stateDir, startScheduler: false });
    const created = first.createScheduleItem({
      kind: "task",
      title: "整理周报",
      timezone: "Asia/Shanghai",
    });
    first.dispose();

    const second = new CompanionKernel({ stateDir, startScheduler: false });
    assert.equal(second.getScheduleItem(created.item.id).title, "整理周报");
    second.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("quiet hours defer delivery until the configured local end time", async () => {
  const clock = new VirtualClock("2026-07-11T15:00:00.000Z");
  const sink = new CaptureNotificationSink();
  const kernel = new CompanionKernel({
    stateDir: false,
    clock,
    idGenerator: new SeededIdGenerator("quiet"),
    notificationSink: sink,
    startScheduler: false,
    quietHours: new QuietHoursPolicy({ start: "22:00", end: "07:00", timezone: "Asia/Shanghai" }),
  });
  try {
    kernel.createScheduleItem({
      kind: "reminder",
      title: "静默提醒",
      startAt: "2026-07-11T15:01:00.000Z",
      timezone: "Asia/Shanghai",
    });
    clock.advance(60_000);
    assert.deepEqual(await kernel.scheduler.tick(), { claimed: 1, delivered: 0, failed: 0 });
    assert.equal(sink.deliveries.length, 0);
    assert.equal(kernel.listNotificationHistory()[0].availableAt, "2026-07-11T23:00:00.000Z");

    clock.set("2026-07-11T23:00:00.000Z");
    assert.deepEqual(await kernel.scheduler.tick(), { claimed: 0, delivered: 1, failed: 0 });
    assert.equal(sink.deliveries.length, 1);
  } finally {
    kernel.dispose();
  }
});

test("failed notifications can be manually retried without duplicating the outbox", async () => {
  const clock = new VirtualClock("2026-07-11T09:00:00.000Z");
  const sink = new ToggleNotificationSink();
  const kernel = new CompanionKernel({
    stateDir: false,
    clock,
    idGenerator: new SeededIdGenerator("retry"),
    notificationSink: sink,
    startScheduler: false,
    quietHours: false,
  });
  try {
    kernel.createScheduleItem({
      kind: "reminder",
      title: "重试提醒",
      startAt: "2026-07-11T09:01:00.000Z",
      timezone: "Asia/Shanghai",
    });
    clock.advance(60_000);
    await kernel.scheduler.tick();
    clock.advance(60_000);
    await kernel.scheduler.tick();
    clock.advance(120_000);
    await kernel.scheduler.tick();

    const failed = kernel.listNotificationHistory()[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 3);

    sink.reject = false;
    const retried = kernel.retryNotification(failed.id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempts, 0);
    assert.deepEqual(await kernel.scheduler.tick(), { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(kernel.listNotificationHistory().length, 1);
    assert.equal(kernel.listNotificationHistory()[0].status, "delivered");
  } finally {
    kernel.dispose();
  }
});

class ToggleNotificationSink implements NotificationSink {
  readonly channel = "toggle";
  reject = true;

  async deliver(_notification: NotificationDelivery): Promise<DeliveryResult> {
    return this.reject ? { delivered: false, detail: "test rejection" } : { delivered: true };
  }
}
