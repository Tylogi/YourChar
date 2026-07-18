import assert from "node:assert/strict";
import test from "node:test";
import { TurnRetryUnavailableError } from "../src/domain/kernel.js";
import { createTestRuntime } from "../src/testing/index.js";

test("role text containing failure wording remains completed and cannot be retried", async () => {
  const runtime = createTestRuntime({ seed: "status-completed" });
  try {
    const character = runtime.kernel.createCharacter({ name: "状态角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "这次实验失败了，但我还在这里。" }]);

    const response = await runtime.kernel.sendMessage("status-completed", {
      mode: "sms",
      characterId: character.id,
      text: "实验怎么样？",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.canRetry, false);
    assert.equal(response.messageType, "assistant");
    assert.equal(runtime.kernel.recentContextLogs(1)[0].status, "completed");
    assert.equal(runtime.kernel.listConversationMetadata()[0].lastTurnStatus, "completed");
    const session = await runtime.kernel.getSession("status-completed");
    const assistant = session.messages.find((message) => message.role === "assistant") as
      | ({ turnStatus?: string; canRetry?: boolean })
      | undefined;
    assert.equal(assistant?.turnStatus, "completed");
    assert.equal(assistant?.canRetry, false);
    await assert.rejects(
      runtime.kernel.retryLastMessage("status-completed"),
      TurnRetryUnavailableError,
    );
  } finally {
    runtime.dispose();
  }
});

test("provider errors are retryable only before a side effect completes", async () => {
  const retryable = createTestRuntime({ seed: "status-retryable" });
  try {
    const character = retryable.kernel.createCharacter({ name: "重试角色" });
    retryable.model.enqueue([{ kind: "provider_error", message: "temporary outage" }]);
    const failed = await retryable.kernel.sendMessage("retryable", {
      mode: "sms",
      characterId: character.id,
      text: "请回复",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.canRetry, true);
    assert.equal(failed.eventType, "operation_failed");
    const failedSession = await retryable.kernel.getSession("retryable");
    const systemEvent = failedSession.messages.at(-1);
    assert.equal(systemEvent?.role, "custom");
    assert.deepEqual(
      systemEvent?.role === "custom" ? systemEvent.details : undefined,
      { eventType: "operation_failed", status: "failed", canRetry: true },
    );

    retryable.model.enqueue([{ kind: "assistant_text", text: "已经恢复。" }]);
    const recovered = await retryable.kernel.retryLastMessage("retryable");
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.canRetry, false);
    const retryPayload = JSON.stringify(retryable.model.requests.at(-1)?.providerPayload.messages);
    assert.equal((retryPayload.match(/请回复/g) ?? []).length, 1);
    assert.doesNotMatch(retryPayload, /temporary outage|模型调用失败/);
    const recoveredSession = await retryable.kernel.getSession("retryable");
    assert.equal(recoveredSession.messages.filter((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("请回复")
    ).length, 1);
    assert.equal(recoveredSession.messages.some((message) =>
      message.role === "custom" && message.customType === "rp-agent/system_event"
    ), false);
  } finally {
    retryable.dispose();
  }

  const sideEffect = createTestRuntime({
    now: "2026-07-16T09:00:00.000Z",
    seed: "status-side-effect",
  });
  try {
    const character = sideEffect.kernel.createCharacter({ name: "副作用角色" });
    sideEffect.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "5分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "provider_error", message: "failed after tool" },
    ]);
    const failedAfterTool = await sideEffect.kernel.sendMessage("side-effect", {
      mode: "sms",
      characterId: character.id,
      text: "5分钟后提醒我喝水",
      timezone: "Asia/Shanghai",
    });
    assert.equal(failedAfterTool.status, "failed");
    assert.equal(failedAfterTool.canRetry, false);
    assert.ok(failedAfterTool.actions.some((action) =>
      action.actionType === "create_schedule_item" && action.status === "completed"));
    assert.equal(sideEffect.kernel.listScheduleItems().length, 1);
    await assert.rejects(
      sideEffect.kernel.retryLastMessage("side-effect"),
      TurnRetryUnavailableError,
    );
  } finally {
    sideEffect.dispose();
  }
});

test("a cancelled turn is persisted as a retryable system event", async () => {
  const runtime = createTestRuntime({ seed: "status-cancelled" });
  try {
    const character = runtime.kernel.createCharacter({ name: "取消角色" });
    const controller = new AbortController();
    controller.abort();

    const response = await runtime.kernel.streamMessage(
      "status-cancelled",
      { mode: "sms", characterId: character.id, text: "请继续" },
      () => undefined,
      controller.signal,
    );

    assert.equal(response.status, "cancelled");
    assert.equal(response.canRetry, true);
    assert.equal(response.messageType, "system");
    assert.equal(response.eventType, "cancelled");
    assert.equal(runtime.kernel.recentContextLogs(1)[0].status, "cancelled");
    assert.equal(runtime.kernel.listConversationMetadata()[0].lastTurnStatus, "cancelled");
    const session = await runtime.kernel.getSession("status-cancelled");
    const systemEvent = session.messages.at(-1);
    assert.equal(systemEvent?.role, "custom");
    assert.deepEqual(
      systemEvent?.role === "custom" ? systemEvent.details : undefined,
      { eventType: "cancelled", status: "cancelled", canRetry: true },
    );
  } finally {
    runtime.dispose();
  }
});
