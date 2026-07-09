import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";

test("sms reminder creates real reminder through tool loop", async () => {
  const kernel = new CompanionKernel({ stateDir: false });
  const response = await kernel.sendMessage("s1", {
    mode: "sms",
    text: "5分钟后提醒我喝水",
    now: "2026-07-09T12:00:00.000Z",
  });

  assert.match(response.reply, /已设置提醒：喝水/);
  assert.equal(response.actions[0].actionType, "create_reminder");
  assert.equal(kernel.store.reminders.size, 1);
});

test("rp fictional reminder-like text writes memory only", async () => {
  const kernel = new CompanionKernel({ stateDir: false });
  const response = await kernel.sendMessage("rp1", {
    mode: "rp",
    text: "剧情里5分钟后提醒我去旧钟楼",
    now: "2026-07-09T12:00:00.000Z",
  });

  assert.equal(kernel.store.reminders.size, 0);
  assert.equal(kernel.store.memories.length, 1);
  assert.equal(response.actions[0].actionType, "write_memory");
  assert.match(response.reply, /共同记忆/);
});
