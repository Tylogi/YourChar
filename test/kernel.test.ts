import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";

test("sms reminder creates real reminder through tool loop", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-09T12:00:00.000Z"),
  });
  const response = await kernel.sendMessage("s1", {
    mode: "sms",
    text: "5分钟后提醒我喝水",
  });

  assert.match(response.reply, /提醒已创建：喝水/);
  assert.equal(response.messageType, "system");
  assert.equal(response.actions[0].actionType, "create_schedule_item");
  assert.equal(kernel.listScheduleItems().length, 1);
});

test("sms reminder accepts a Chinese relative duration", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-09T12:00:00.000Z"),
  });
  const response = await kernel.sendMessage("chinese-relative", {
    mode: "sms",
    text: "五分钟后提醒我喝水",
  });

  assert.match(response.reply, /提醒已创建：喝水/);
  assert.equal(response.messageType, "system");
  assert.equal(kernel.listScheduleItems()[0].startAt, "2026-07-09T12:05:00.000Z");
});

test("rp fictional reminder-like text does not mutate persistent state", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-09T12:00:00.000Z"),
  });
  const response = await kernel.sendMessage("rp1", {
    mode: "rp",
    text: "剧情里5分钟后提醒我去旧钟楼",
  });

  assert.equal(kernel.listScheduleItems().length, 0);
  assert.equal(kernel.rpService.listAllMemories().length, 0);
  assert.equal(response.actions.length, 0);
  assert.match(response.reply, /模型当前未启用/);
  assert.equal(response.messageType, "system");
});

test("ambiguous reminder time asks for clarification without mutation", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-11T09:00:00.000Z"),
  });
  const response = await kernel.sendMessage("ambiguous", {
    mode: "sms",
    text: "明天提醒我喝水",
  });

  assert.match(response.reply, /时间还不够明确/);
  assert.equal(response.actions.length, 0);
  assert.equal(kernel.listScheduleItems().length, 0);
});
