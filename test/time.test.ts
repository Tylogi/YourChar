import assert from "node:assert/strict";
import test from "node:test";
import { extractReminderTitle, parseReminderTime, TimeResolutionError } from "../src/domain/time.js";

const now = new Date("2026-07-11T09:00:00.000Z");

test("time parser handles relative and Chinese local expressions", () => {
  assert.equal(
    parseReminderTime("5分钟后提醒我喝水", now, "Asia/Shanghai").toISOString(),
    "2026-07-11T09:05:00.000Z",
  );
  assert.equal(
    parseReminderTime("五分钟后提醒我喝水", now, "Asia/Shanghai").toISOString(),
    "2026-07-11T09:05:00.000Z",
  );
  assert.equal(
    parseReminderTime("半小时以后提醒我休息", now, "Asia/Shanghai").toISOString(),
    "2026-07-11T09:30:00.000Z",
  );
  assert.equal(
    parseReminderTime("明天下午3点提醒我开会", now, "Asia/Shanghai").toISOString(),
    "2026-07-12T07:00:00.000Z",
  );
  assert.equal(
    parseReminderTime("明天下午三点提醒我开会", now, "Asia/Shanghai").toISOString(),
    "2026-07-12T07:00:00.000Z",
  );
  assert.equal(
    parseReminderTime("下周一上午9点提醒我交报告", now, "Asia/Shanghai").toISOString(),
    "2026-07-13T01:00:00.000Z",
  );
  assert.equal(extractReminderTitle("明天下午3点提醒我开会"), "开会");
  assert.equal(extractReminderTitle("提醒我五分钟后喝水"), "喝水");
});

test("time parser rejects ambiguous, past, and nonexistent local times", () => {
  assert.throws(
    () => parseReminderTime("明天提醒我喝水", now, "Asia/Shanghai"),
    (error) => error instanceof TimeResolutionError && error.code === "AMBIGUOUS_TIME",
  );
  assert.throws(
    () => parseReminderTime("今天下午3点提醒我开会", now, "Asia/Shanghai"),
    (error) => error instanceof TimeResolutionError && error.code === "PAST_TIME",
  );
  assert.throws(
    () =>
      parseReminderTime(
        "2026-03-08 02:30提醒我检查夏令时",
        new Date("2026-03-01T00:00:00.000Z"),
        "America/New_York",
      ),
    (error) => error instanceof TimeResolutionError && error.code === "INVALID_TIME",
  );
});
