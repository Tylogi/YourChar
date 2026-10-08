import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PrivateInboxSnapshot } from "../src/inbox/index.js";
import { createTestRuntime } from "../src/testing/index.js";

test("private inbox keeps UI messages separate but sends one merged user turn to the model", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-burst",
    startPrivateInboxCoordinator: false,
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "连续消息角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我都看到了，慢慢说。" }]);

    for (const [index, text] of ["你在吗？", "我刚到家。", "今天有点累。"].entries()) {
      await runtime.kernel.enqueuePrivateMessage("private-inbox-burst", {
        mode: "sms",
        characterId: character.id,
        text,
      }, "client-" + (index + 1));
    }

    await runtime.kernel.flushPrivateMessageInbox("private-inbox-burst");

    assert.equal(runtime.model.requests.length, 1);
    const requestUsers = runtime.model.requests[0].messages
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user"))
      .map(modelMessageText)
      .filter((text) => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(requestUsers.at(-1), "你在吗？\n我刚到家。\n今天有点累。");

    const transcript = await runtime.kernel.getConversationTranscript("private-inbox-burst");
    assert.deepEqual(transcript.filter((message) => message.role === "user").map(agentMessageText), [
      "你在吗？",
      "我刚到家。",
      "今天有点累。",
    ]);
    assert.equal(runtime.kernel.privateInbox.repository.listAll().every((message) =>
      message.status === "completed"), true);
    assert.equal(runtime.kernel.recentContextLogs(1)[0]?.requestText, "你在吗？\n我刚到家。\n今天有点累。");
  } finally {
    runtime.dispose();
  }
});

test("private inbox completion snapshots stop reporting a finished burst as running", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-finished-snapshot",
    startPrivateInboxCoordinator: false,
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "完成状态角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "已经回复完成。" }]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-finished-snapshot", {
      mode: "sms",
      characterId: character.id,
      text: "检查完成状态。",
    }, "finished-snapshot-client");

    let completionSnapshot: PrivateInboxSnapshot | undefined;
    const unsubscribe = runtime.kernel.subscribePrivateInbox("private-inbox-finished-snapshot", (event) => {
      if (event.type === "burst_done") {
        completionSnapshot = runtime.kernel.privateInboxSnapshot("private-inbox-finished-snapshot");
      }
    });
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-finished-snapshot");
    unsubscribe();

    assert.ok(completionSnapshot, "the completion listener should observe a canonical snapshot");
    assert.equal(completionSnapshot.running, false);
    assert.deepEqual(completionSnapshot.messages, []);
  } finally {
    runtime.dispose();
  }
});

test("messages arriving during generation interrupt the old reply and preserve all user input", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-followup",
    startPrivateInboxCoordinator: false,
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "队列角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一轮回复。", delayMs: 80 },
      { kind: "assistant_text", text: "第二轮把后两条一起回复。" },
    ]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-followup", {
      mode: "sms",
      characterId: character.id,
      text: "第一条。",
    }, "first");

    const firstTurn = runtime.kernel.flushPrivateMessageInbox("private-inbox-followup");
    await waitFor(() => runtime.model.requests.length === 1);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-followup", {
      mode: "sms",
      characterId: character.id,
      text: "生成时发的第二条。",
    }, "second");
    await runtime.kernel.enqueuePrivateMessage("private-inbox-followup", {
      mode: "sms",
      characterId: character.id,
      text: "还有第三条。",
    }, "third");
    await firstTurn;
    assert.equal(runtime.kernel.privateInbox.repository.getByClientMessageId("private-inbox-followup", "first")?.status, "cancelled");

    assert.deepEqual(
      runtime.kernel.privateInboxSnapshot("private-inbox-followup").messages.map((message) => message.text),
      ["生成时发的第二条。", "还有第三条。"],
    );
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-followup");

    assert.equal(runtime.model.requests.length, 2);
    const secondUsers = runtime.model.requests[1].messages
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user"))
      .map(modelMessageText)
      .filter((text) => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(secondUsers.at(-1), "第一条。\n生成时发的第二条。\n还有第三条。");
  } finally {
    runtime.dispose();
  }
});

test("editing a processing inbox message interrupts it and replaces the effective user input", async () => {
  const runtime = createTestRuntime({ seed: "inbox-edit-active", startPrivateInboxCoordinator: false });
  try {
    const character = runtime.kernel.createCharacter({ name: "纠错角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "旧回复不应继续。", delayMs: 200 },
      { kind: "assistant_text", text: "好的，改成后天下午。" },
    ]);
    const message = await runtime.kernel.enqueuePrivateMessage("inbox-edit-active", {
      mode: "sms", characterId: character.id, text: "明天上午出发。",
    }, "original");
    const first = runtime.kernel.flushPrivateMessageInbox(message.sessionId);
    await waitFor(() => runtime.model.requests.length === 1);
    const edited = await runtime.kernel.updateQueuedPrivateMessage(message.sessionId, message.id, { text: "后天下午出发。" });
    await first;
    assert.equal(edited.status, "queued");
    await runtime.kernel.flushPrivateMessageInbox(message.sessionId);
    assert.equal(runtime.model.requests.length, 2);
    const users = runtime.model.requests[1].messages.filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object" && (message as { role?: string }).role === "user"))
      .map(modelMessageText).filter(text => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(users.at(-1), "后天下午出发。");
    assert.ok(!users.some(text => text.includes("明天上午出发")));
    const transcript = await runtime.kernel.getConversationTranscript(message.sessionId);
    assert.deepEqual(transcript.filter(message => message.role === "user").map(agentMessageText), ["后天下午出发。"]);
  } finally { runtime.dispose(); }
});

test("a stop received while an edit is settling keeps the corrected message paused", async () => {
  const runtime = createTestRuntime({ seed: "inbox-edit-stop", startPrivateInboxCoordinator: false });
  try {
    const character = runtime.kernel.createCharacter({ name: "纠错后停止" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "旧回复", delayMs: 200 }]);
    const message = await runtime.kernel.enqueuePrivateMessage("inbox-edit-stop", {
      mode: "sms", characterId: character.id, text: "原来的消息",
    }, "original");
    const running = runtime.kernel.flushPrivateMessageInbox(message.sessionId);
    await waitFor(() => runtime.model.requests.length === 1);
    const editing = runtime.kernel.updateQueuedPrivateMessage(message.sessionId, message.id, { text: "改好的消息" });
    await runtime.kernel.cancelMessage(message.sessionId);
    await Promise.all([running, editing]);
    await runtime.kernel.flushPrivateMessageInbox(message.sessionId);
    assert.equal(runtime.model.requests.length, 1);
    const snapshot = runtime.kernel.privateInboxSnapshot(message.sessionId);
    assert.equal(snapshot.paused, true);
    assert.equal(snapshot.messages[0]?.text, "改好的消息");
    assert.equal(snapshot.messages[0]?.status, "queued");
  } finally { runtime.dispose(); }
});

test("duplicate delivery does not interrupt a turn; stop pauses queued input until explicit resume", async () => {
  const runtime = createTestRuntime({ seed: "inbox-stop", startPrivateInboxCoordinator: false });
  try {
    const character = runtime.kernel.createCharacter({ name: "停止角色" });
    const request = { mode: "sms" as const, characterId: character.id, text: "第一条。" };
    runtime.model.enqueue([
      { kind: "assistant_text", text: "旧回复。", delayMs: 200 },
      { kind: "assistant_text", text: "现在处理第二条。" },
    ]);
    const first = await runtime.kernel.enqueuePrivateMessage("inbox-stop", request, "first");
    const running = runtime.kernel.flushPrivateMessageInbox(first.sessionId);
    await waitFor(() => runtime.model.requests.length === 1);
    await runtime.kernel.enqueuePrivateMessage(first.sessionId, request, "first");
    assert.equal(runtime.kernel.privateInboxSnapshot(first.sessionId).interrupting, false);
    await runtime.kernel.enqueuePrivateMessage(first.sessionId, { ...request, text: "第二条。" }, "second", { interrupt: false });
    assert.equal(await runtime.kernel.cancelMessage(first.sessionId), true);
    await running;
    await runtime.kernel.flushPrivateMessageInbox(first.sessionId);
    assert.equal(runtime.model.requests.length, 1);
    assert.equal(runtime.kernel.privateInboxSnapshot(first.sessionId).paused, true);
    assert.equal(runtime.kernel.privateInboxSnapshot(first.sessionId).messages[0]?.text, "第二条。");
    runtime.kernel.resumePrivateMessageInbox(first.sessionId);
    await Promise.all([
      runtime.kernel.flushPrivateMessageInbox(first.sessionId),
      runtime.kernel.flushPrivateMessageInbox(first.sessionId),
    ]);
    assert.equal(runtime.model.requests.length, 2, "concurrent flushes must consume a message only once");
  } finally { runtime.dispose(); }
});

test("interrupting after a tool commit preserves the result and prevents unsafe revision or replay", async () => {
  const runtime = createTestRuntime({ seed: "inbox-tool-interrupt", startPrivateInboxCoordinator: false });
  try {
    const character = runtime.kernel.createCharacter({ name: "工具角色" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "create_schedule_item", arguments: {
        kind: "reminder", title: "喝水", timeExpression: "5分钟后", timezone: "Asia/Shanghai",
      } },
      { kind: "assistant_text", text: "已经创建提醒。", delayMs: 200 },
      { kind: "assistant_text", text: "之前的提醒已创建，我记下了补充。" },
    ]);
    const first = await runtime.kernel.enqueuePrivateMessage("inbox-tool-interrupt", {
      mode: "sms", characterId: character.id, text: "5分钟后提醒我喝水", timezone: "Asia/Shanghai",
    }, "first");
    const turn = runtime.kernel.flushPrivateMessageInbox(first.sessionId);
    await waitFor(() => runtime.model.requests.length === 2);
    await assert.rejects(runtime.kernel.updateQueuedPrivateMessage(first.sessionId, first.id, {
      text: "改成明天提醒我",
    }), /already completed create_schedule_item/);
    await turn;
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.equal(runtime.kernel.recentContextLogs(1)[0].status, "cancelled");
    assert.equal(runtime.kernel.recentContextLogs(1)[0].canRetry, false);
    await runtime.kernel.enqueuePrivateMessage(first.sessionId, {
      mode: "sms", characterId: character.id, text: "知道了，先保留这个提醒。",
    }, "correction");
    await runtime.kernel.flushPrivateMessageInbox(first.sessionId);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.match(JSON.stringify(runtime.model.requests.at(-1)?.messages), /create_schedule_item/);
  } finally { runtime.dispose(); }
});

test("a preparation failure preserves every input in history and remains retryable after restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-preflight-failure-"));
  const first = createTestRuntime({ stateDir, seed: "preflight-failure", startPrivateInboxCoordinator: false });
  try {
    const character = first.kernel.createCharacter({ name: "准备失败" });
    first.kernel.sessionRuntime.compactBeforeTurnIfNeeded = async () => { throw new Error("synthetic context preparation failure"); };
    for (const [index, text] of ["这张截图不用归档", "只是问一下问题"].entries()) {
      await first.kernel.enqueuePrivateMessage("preflight-failure", { mode: "sms", characterId: character.id, text }, String(index));
    }
    await first.kernel.flushPrivateMessageInbox("preflight-failure");
    assert.equal(first.model.requests.length, 0);
    const history = await first.kernel.getConversationTranscript("preflight-failure");
    assert.deepEqual(history.filter(message => message.role === "user").map(agentMessageText), ["这张截图不用归档", "只是问一下问题"]);
    assert.equal(first.kernel.recentContextLogs(1)[0].canRetry, true);
    const snapshot = first.kernel.privateInboxSnapshot("preflight-failure");
    assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.failedMessages?.length, 2);
  } finally { first.dispose(); }
  const second = createTestRuntime({ stateDir, seed: "preflight-restart", startPrivateInboxCoordinator: false });
  try {
    assert.equal(second.kernel.privateInboxSnapshot("preflight-failure").failedMessages?.length, 2);
    assert.equal((await second.kernel.getConversationTranscript("preflight-failure")).filter(message => message.role === "user").length, 2);
    second.model.enqueue([{ kind: "assistant_text", text: "收到，只回答问题。" }]);
    assert.equal((await second.kernel.retryLastMessage("preflight-failure")).status, "completed");
    const users = second.model.requests[0].messages.filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object" && (message as { role?: string }).role === "user"))
      .map(modelMessageText).filter(text => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(users.join("\n").split("这张截图不用归档").length - 1, 1);
  } finally { second.dispose(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("a stopped queue remains paused after restart and a new send resumes it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-paused-inbox-"));
  const first = createTestRuntime({ stateDir, seed: "pause-persist", startPrivateInboxCoordinator: false });
  let characterId: string;
  try {
    characterId = first.kernel.createCharacter({ name: "暂停角色" }).id;
    await first.kernel.enqueuePrivateMessage("pause-persist", { mode: "sms", characterId, text: "保留这条。" }, "retained");
    await first.kernel.cancelMessage("pause-persist");
  } finally { first.dispose(); }
  const second = createTestRuntime({ stateDir, seed: "pause-restart", startPrivateInboxCoordinator: false });
  try {
    assert.equal(second.kernel.privateInboxSnapshot("pause-persist").paused, true);
    await second.kernel.flushPrivateMessageInbox("pause-persist");
    assert.equal(second.model.requests.length, 0);
    second.model.enqueue([{ kind: "assistant_text", text: "两条都收到了。" }]);
    await second.kernel.enqueuePrivateMessage("pause-persist", { mode: "sms", characterId, text: "可以继续了。" }, "resume");
    assert.equal(second.kernel.privateInboxSnapshot("pause-persist").paused, false);
    await second.kernel.flushPrivateMessageInbox("pause-persist");
    assert.equal(second.model.requests.length, 1);
  } finally { second.dispose(); rmSync(stateDir, {recursive:true,force:true}); }
});

test("private inbox gives the first message an accumulation grace period", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-grace",
    startPrivateInboxCoordinator: true,
    privateInboxOptions: {
      initialWaitMs: 90,
      quietWindowMs: 30,
      maximumWaitMs: 160,
      afterTurnQuietMs: 20,
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "缓冲角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "两条都收到了。" }]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-grace", {
      mode: "sms",
      characterId: character.id,
      text: "第一条。",
    }, "grace-first");

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(runtime.model.requests.length, 0);

    await runtime.kernel.enqueuePrivateMessage("private-inbox-grace", {
      mode: "sms",
      characterId: character.id,
      text: "补充一条。",
    }, "grace-second");
    await waitFor(() => runtime.model.requests.length === 1);
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-grace");

    const users = runtime.model.requests[0].messages
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user"))
      .map(modelMessageText)
      .filter((text) => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(users.at(-1), "第一条。\n补充一条。");
  } finally {
    runtime.dispose();
  }
});

test("active composer typing extends a private burst beyond the normal maximum wait", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-typing",
    startPrivateInboxCoordinator: true,
    privateInboxOptions: {
      initialWaitMs: 40,
      quietWindowMs: 20,
      typingQuietWindowMs: 120,
      maximumWaitMs: 60,
      afterTurnQuietMs: 20,
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "输入感知角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "这次听完整了。" }]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-typing", {
      mode: "sms",
      characterId: character.id,
      text: "第一条。",
    }, "typing-first");

    await new Promise((resolve) => setTimeout(resolve, 25));
    const heartbeat = runtime.kernel.notePrivateInboxTyping("private-inbox-typing");
    assert.ok(new Date(heartbeat.typingUntil).getTime() > Date.now());
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(runtime.model.requests.length, 0, "typing must hold the burst past its ordinary 60 ms cap");

    await runtime.kernel.enqueuePrivateMessage("private-inbox-typing", {
      mode: "sms",
      characterId: character.id,
      text: "补充完整。",
    }, "typing-second");
    await waitFor(() => runtime.model.requests.length === 1);
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-typing");
    const users = runtime.model.requests[0].messages
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user"))
      .map(modelMessageText)
      .filter((text) => !text.includes("RP_AGENT_RUNTIME_CONTEXT"));
    assert.equal(users.at(-1), "第一条。\n补充完整。");
  } finally {
    runtime.dispose();
  }
});

test("queued private messages survive a service restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-private-inbox-"));
  try {
    const first = createTestRuntime({
      stateDir,
      seed: "private-inbox-restart-first",
      startPrivateInboxCoordinator: false,
    });
    const character = first.kernel.createCharacter({ name: "重启角色" });
    await first.kernel.enqueuePrivateMessage("private-inbox-restart", {
      mode: "sms",
      characterId: character.id,
      text: "服务重启后也别丢掉这条。",
    }, "restart-client");
    first.dispose();

    const second = createTestRuntime({
      stateDir,
      seed: "private-inbox-restart-second",
      startPrivateInboxCoordinator: false,
    });
    try {
      const snapshot = second.kernel.privateInboxSnapshot("private-inbox-restart");
      assert.equal(snapshot.running, false);
      assert.equal(snapshot.messages.length, 1);
      assert.equal(snapshot.messages[0].text, "服务重启后也别丢掉这条。");
      assert.equal(snapshot.messages[0].status, "queued");
    } finally {
      second.dispose();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("meeting tools evaluate the latest real message in a private burst", async () => {
  const runtime = createTestRuntime({
    seed: "private-inbox-meeting",
    startPrivateInboxCoordinator: false,
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "见面队列角色" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "好，到时见。" }]);
    await runtime.kernel.sendMessage("private-inbox-meeting", {
      mode: "sms",
      characterId: character.id,
      text: "先约在酒店见。",
    });
    await runtime.kernel.transitionConversationInteraction("private-inbox-meeting", {
      action: "propose",
      location: "酒店",
    });

    runtime.model.enqueue([
      { kind: "tool_call", name: "begin_meeting", arguments: {} },
      { kind: "assistant_text", text: "她看向门口：\"你到了。\"" },
    ]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-meeting", {
      mode: "sms",
      characterId: character.id,
      text: "我还在路上。",
    }, "arrival-1");
    await runtime.kernel.enqueuePrivateMessage("private-inbox-meeting", {
      mode: "sms",
      characterId: character.id,
      text: "我到酒店了。",
    }, "arrival-2");
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-meeting");
    assert.equal(runtime.kernel.getConversationInteraction("private-inbox-meeting").state.presence, "co_present");

    runtime.model.enqueue([
      { kind: "tool_call", name: "end_meeting", arguments: { initiator: "user" } },
      { kind: "assistant_text", text: "她送你到门口：\"晚点联系。\"" },
    ]);
    await runtime.kernel.enqueuePrivateMessage("private-inbox-meeting", {
      mode: "sms",
      characterId: character.id,
      text: "我去拿一下外套。",
    }, "departure-1");
    await runtime.kernel.enqueuePrivateMessage("private-inbox-meeting", {
      mode: "sms",
      characterId: character.id,
      text: "我先走了，晚点给你发消息。",
    }, "departure-2");
    await runtime.kernel.flushPrivateMessageInbox("private-inbox-meeting");

    assert.equal(runtime.kernel.getConversationInteraction("private-inbox-meeting").state.presence, "remote");
    assert.match(runtime.kernel.recentContextLogs(1)[0]?.requestText ?? "", /我去拿一下外套[\s\S]*我先走了/);
  } finally {
    runtime.dispose();
  }
});

function modelMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const record = block as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function agentMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
