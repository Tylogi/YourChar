import assert from "node:assert/strict";
import test from "node:test";
import { classifyAssistantOutput } from "../src/pi/output-guard.js";
import { createTestRuntime } from "../src/testing/index.js";

test("assistant output classifier blocks internal analysis without rejecting Markdown or normal English", () => {
  assert.equal(classifyAssistantOutput("The user is asking me to review the history."), "blocked");
  assert.equal(classifyAssistantOutput("Let's review the conversation before answering."), "blocked");
  assert.equal(classifyAssistantOutput("Thinking Process:\n1. Analyze the request."), "blocked");
  assert.equal(classifyAssistantOutput("thinking：\nWe need a plan."), "blocked");
  assert.equal(classifyAssistantOutput("**Reasoning:**\nFirst inspect the tools."), "blocked");
  assert.equal(classifyAssistantOutput("## **Chain of Thought**\n- inspect history"), "blocked");
  assert.equal(classifyAssistantOutput("### Thinking Process：\nReview the prompt."), "blocked");
  assert.equal(classifyAssistantOutput("Think"), "pending");
  assert.equal(classifyAssistantOutput("**原始数据**需要继续保留。"), "safe");
  assert.equal(classifyAssistantOutput("The API returned HTTP 204, 舰长。"), "safe");
  assert.equal(classifyAssistantOutput("# Thinking in product design"), "safe");
  assert.equal(classifyAssistantOutput("## Reasoning about tradeoffs"), "safe");
  assert.equal(classifyAssistantOutput("\"Thinking Process:\" 是需要讨论的标题。"), "safe");
  assert.equal(classifyAssistantOutput("用户要求讨论 Chain of Thought: 这个短语。"), "safe");
  assert.equal(classifyAssistantOutput("<think>internal</think>舰长，我认为应先核对原始数据。"), "safe");
});

test("internal analysis is replaced before persistence and regenerated once", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-retry" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        text: `Thinking Process:\n\n1. Analyze the request.\n${"We need to inspect every prior message. ".repeat(400)}`,
      },
      { kind: "assistant_text", text: "舰长，我认为你最稳定的习惯是先核对原始数据。" },
    ]);

    const streamedText: string[] = [];
    const response = await runtime.kernel.streamMessage("guard-retry", {
      mode: "sms",
      characterId: character.id,
      text: "回顾一下我的习惯",
    }, (event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        streamedText.push(JSON.stringify(event.message.content));
      }
    });

    assert.equal(response.status, "completed");
    assert.equal(response.reply, "舰长，我认为你最稳定的习惯是先核对原始数据。");
    assert.equal(runtime.model.requests.length, 2);
    assert.doesNotMatch(runtime.model.requests[0].systemPrompt, /TRUSTED OUTPUT RECOVERY/);
    assert.match(runtime.model.requests[1].systemPrompt, /TRUSTED OUTPUT RECOVERY/);
    assert.equal(streamedText.join("").includes("Thinking Process"), false);
    const session = await runtime.kernel.getSession("guard-retry");
    const serialized = JSON.stringify(session.messages);
    assert.equal(serialized.includes("Thinking Process"), false);
    assert.equal(serialized.includes("We need to inspect"), false);
    assert.equal(serialized.includes("舰长，我认为"), true);
  } finally {
    runtime.dispose();
  }
});

test("a second internal-analysis response becomes a retryable system event", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-failed" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nReview every previous message first." },
      { kind: "assistant_text", text: "**Reasoning:**\nThe user is asking me for a final answer." },
    ]);

    const streamedText: string[] = [];
    const response = await runtime.kernel.streamMessage("guard-failed", {
      mode: "sms",
      characterId: character.id,
      text: "直接回答",
    }, (event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        streamedText.push(JSON.stringify(event.message.content));
      }
    });

    assert.equal(response.status, "failed");
    assert.equal(response.messageType, "system");
    assert.equal(response.canRetry, true);
    assert.equal(runtime.model.requests.length, 2);
    assert.match(runtime.model.requests[1].systemPrompt, /TRUSTED OUTPUT RECOVERY/);
    assert.equal(streamedText.join("").includes("Thinking Process"), false);
    assert.equal(streamedText.join("").includes("Reasoning"), false);
    const session = await runtime.kernel.getSession("guard-failed");
    const serialized = JSON.stringify(session.messages);
    assert.equal(serialized.includes("Thinking Process"), false);
    assert.equal(serialized.includes("Reasoning"), false);
    assert.equal(serialized.includes("The user is asking me"), false);
  } finally {
    runtime.dispose();
  }
});

test("explicit memory capture survives a long blocked analysis and regenerated reply", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-explicit-memory" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    const manual = "# 用户画像\n\n- 手写：保留\n";
    runtime.kernel.updateUserProfile(manual);
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        text: `Thinking Process:\n\n${"Analyze profile and tool policy before responding. ".repeat(400)}`,
      },
      { kind: "assistant_text", text: "舰长，我记住了，以后会先给结论、表达简洁。" },
    ]);

    const response = await runtime.kernel.sendMessage("guard-explicit-memory", {
      mode: "sms",
      characterId: character.id,
      text: "请记住：我希望你以后先给结论、表达简洁。",
    });
    await runtime.kernel.memoryCoordinator.drain();

    const memory = runtime.kernel.listMemories({ realm: "reality" })
      .find((entry) => /先给结论、表达简洁/.test(entry.content));
    assert.equal(response.status, "completed");
    assert.equal(runtime.model.requests.length, 2);
    assert.match(runtime.model.requests[1].systemPrompt, /TRUSTED OUTPUT RECOVERY/);
    assert.equal(memory?.validity, "active");
    assert.equal(memory?.confirmed, true);
    assert.equal(memory?.characterId, undefined);
    assert.equal(memory?.confirmationProvenance?.kind, "explicit_user_authorization");
    assert.match(runtime.kernel.getUserProfile().markdown, /先给结论、表达简洁/);
    assert.match(runtime.kernel.getUserProfile().markdown, /手写：保留/);
    assert.doesNotMatch(JSON.stringify((await runtime.kernel.getSession("guard-explicit-memory")).messages), /Thinking Process/);
  } finally {
    runtime.dispose();
  }
});

test("schedule intent regenerates before side effects and creates exactly one item", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-16T09:00:00.000Z",
    seed: "output-guard-schedule-retry",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nI should decide whether a tool is needed." },
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "五分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "舰长，五分钟后的喝水提醒已经创建。" },
    ]);

    const response = await runtime.kernel.sendMessage("guard-schedule-retry", {
      mode: "sms",
      characterId: character.id,
      text: "五分钟后提醒我喝水",
      timezone: "Asia/Shanghai",
    });

    assert.equal(response.status, "completed");
    assert.equal(runtime.model.requests.length, 3);
    assert.match(runtime.model.requests[1].systemPrompt, /必须先调用一次 create_schedule_item/);
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /先调用一次 create_schedule_item/);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.equal(response.actions.filter((action) => action.actionType === "create_schedule_item").length, 1);
    assert.doesNotMatch(JSON.stringify((await runtime.kernel.getSession("guard-schedule-retry")).messages), /Thinking Process/);
  } finally {
    runtime.dispose();
  }
});

test("exhausted schedule output guard recovers through the connected MCP tool exactly once", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-16T09:00:00.000Z",
    seed: "output-guard-schedule-exhausted",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nI should inspect the schedule policy." },
      { kind: "assistant_text", text: "**Reasoning:**\nI should inspect the tools again." },
    ]);

    const response = await runtime.kernel.sendMessage("guard-schedule-exhausted", {
      mode: "sms",
      characterId: character.id,
      text: "请在5分钟后提醒我喝水。",
      timezone: "Asia/Shanghai",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.messageType, "system");
    assert.equal(response.nativeModelSuccess, false);
    assert.equal(response.recoveryUsed, true);
    assert.equal(runtime.model.requests.length, 2);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    const create = response.actions.filter((action) => action.actionType === "create_schedule_item");
    assert.equal(create.length, 1);
    assert.equal(create[0].payload.transport, "mcp");
    const recovery = response.actions.find((action) => action.actionType === "recover_output_guard_intent");
    assert.equal(recovery?.status, "completed");
    assert.equal(recovery?.payload.transport, "mcp");
    assert.equal(recovery?.payload.recoveryReason, "output_guard_exhausted");
    const transcript = JSON.stringify((await runtime.kernel.getSession("guard-schedule-exhausted")).messages);
    assert.doesNotMatch(transcript, /Thinking Process|Reasoning:/);
    assert.match(transcript, /rp-agent\/recovery_tool_result/);
    assert.match(transcript, /rp-agent\/system_event/);
  } finally {
    runtime.dispose();
  }
});

test("exhausted explicit remember output guard completes through Coordinator and managed profile", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-memory-exhausted" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nI should inspect profile policy." },
      { kind: "assistant_text", text: "Chain of Thought:\nI should inspect memory policy." },
    ]);

    const response = await runtime.kernel.sendMessage("guard-memory-exhausted", {
      mode: "sms",
      characterId: character.id,
      text: "请记住：我希望你以后先给结论、表达简洁。",
    });

    const memory = runtime.kernel.listMemories({ realm: "reality" })
      .find((entry) => /先给结论、表达简洁/.test(entry.content));
    assert.equal(response.status, "completed");
    assert.equal(response.messageType, "system");
    assert.equal(response.nativeModelSuccess, false);
    assert.equal(response.recoveryUsed, true);
    assert.equal(memory?.validity, "active");
    assert.equal(memory?.confirmed, true);
    assert.equal(memory?.confirmationProvenance?.kind, "explicit_user_authorization");
    assert.match(runtime.kernel.getUserProfile().markdown, /先给结论、表达简洁/);
    const job = runtime.kernel.getMemoryCoordinatorStatus().recentJobs
      .find((entry) => entry.sessionId === "guard-memory-exhausted");
    assert.equal(job?.status, "completed");
    assert.match(job?.triggerReason ?? "", /output_guard_exhausted/);
    const recovery = response.actions.find((action) => action.actionType === "recover_output_guard_intent");
    assert.equal(recovery?.payload.transport, "memory_coordinator");
  } finally {
    runtime.dispose();
  }
});

test("exhausted explicit forget uses Coordinator and never overstates ambiguous matches", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-forget-exhausted" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    const memory = runtime.kernel.memoryLifecycle.captureAuthorized({
      realm: "reality",
      type: "preference",
      key: "reality.explicit.tea",
      content: "我喜欢喝乌龙茶",
      sourceSessionId: "guard-forget-exhausted",
      sourceMessageId: "forget-source",
      idempotencyKey: "guard-forget-memory",
    });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nI should inspect deletion policy." },
      { kind: "assistant_text", text: "Reasoning:\nI should inspect deletion policy again." },
    ]);
    const response = await runtime.kernel.sendMessage("guard-forget-exhausted", {
      mode: "sms",
      characterId: character.id,
      text: "请忘记：我喜欢喝乌龙茶",
    });
    assert.equal(response.status, "completed");
    assert.equal(response.recoveryUsed, true);
    assert.equal(runtime.kernel.memoryLifecycle.get(memory.id).validity, "deleted");
  } finally {
    runtime.dispose();
  }
});

test("exhausted explicit forget requires selection when Coordinator finds multiple memories", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-forget-ambiguous" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    for (const [index, content] of ["我喜欢乌龙茶", "我喜欢绿茶"].entries()) {
      runtime.kernel.memoryLifecycle.captureAuthorized({
        realm: "reality",
        type: "preference",
        key: `reality.explicit.tea.${index}`,
        content,
        sourceSessionId: "guard-forget-ambiguous",
        sourceMessageId: `forget-ambiguous-${index}`,
        idempotencyKey: `guard-forget-ambiguous-${index}`,
      });
    }
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nInspect deletion policy." },
      { kind: "assistant_text", text: "Reasoning:\nInspect deletion policy again." },
    ]);
    const response = await runtime.kernel.sendMessage("guard-forget-ambiguous", {
      mode: "sms",
      characterId: character.id,
      text: "请忘记：茶",
    });
    assert.equal(response.status, "blocked");
    assert.equal(response.eventType, "input_required");
    assert.equal(response.recoveryUsed, true);
    assert.equal(runtime.kernel.listMemories({ realm: "reality", validity: "active" }).length, 2);
    const recovery = response.actions.find((action) => action.actionType === "recover_output_guard_intent");
    assert.equal(recovery?.status, "blocked");
  } finally {
    runtime.dispose();
  }
});

test("exhausted output guard requests clearer SMS time but does not recover RP or ordinary questions", async () => {
  const cases = [
    {
      id: "ambiguous",
      mode: "sms" as const,
      text: "提醒我喝水",
      status: "blocked" as const,
      recoveryUsed: true,
    },
    {
      id: "rp",
      mode: "rp" as const,
      text: "五分钟后提醒我喝水",
      status: "failed" as const,
      recoveryUsed: false,
    },
    {
      id: "ordinary",
      mode: "sms" as const,
      text: "今天怎么样？",
      status: "failed" as const,
      recoveryUsed: false,
    },
  ];
  for (const scenario of cases) {
    const runtime = createTestRuntime({ seed: `output-guard-no-recovery-${scenario.id}` });
    try {
      const character = runtime.kernel.createCharacter({ name: "苏言" });
      runtime.model.enqueue([
        { kind: "assistant_text", text: "Thinking Process:\nInspect the request." },
        { kind: "assistant_text", text: "Reasoning:\nInspect it again." },
      ]);
      const response = await runtime.kernel.sendMessage(`guard-no-recovery-${scenario.id}`, {
        mode: scenario.mode,
        characterId: character.id,
        text: scenario.text,
      });
      assert.equal(response.status, scenario.status, scenario.id);
      assert.equal(response.recoveryUsed, scenario.recoveryUsed, scenario.id);
      assert.equal(runtime.kernel.listScheduleItems().length, 0, scenario.id);
      if (scenario.id === "ambiguous") {
        assert.equal(response.eventType, "input_required");
        const recovery = response.actions.find((action) => action.actionType === "recover_output_guard_intent");
        assert.equal(recovery?.status, "blocked");
        assert.equal(recovery?.payload.transport, "system");
      } else {
        assert.equal(response.actions.some((action) => action.actionType === "recover_output_guard_intent"), false, scenario.id);
      }
    } finally {
      runtime.dispose();
    }
  }
});

test("schedule recovery reports a committed MCP action when the bridge throws afterward", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-16T09:00:00.000Z",
    seed: "output-guard-schedule-post-commit-error",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    const handle = await runtime.kernel.sessionRuntime.getOrCreate(
      "guard-schedule-post-commit-error",
      "sms",
      character.id,
    );
    const tool = handle.mcpBridges.flatMap((bridge) => bridge.tools)
      .find((candidate) => candidate.name === "create_schedule_item");
    assert.ok(tool);
    const execute = tool.execute.bind(tool);
    tool.execute = async (...args) => {
      await execute(...args);
      throw new Error("simulated bridge response failure after commit");
    };
    runtime.model.enqueue([
      { kind: "assistant_text", text: "Thinking Process:\nInspect schedule policy." },
      { kind: "assistant_text", text: "Reasoning:\nInspect schedule policy again." },
    ]);

    const response = await runtime.kernel.sendMessage("guard-schedule-post-commit-error", {
      mode: "sms",
      characterId: character.id,
      text: "请在5分钟后提醒我喝水。",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.recoveryUsed, true);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.doesNotMatch(response.reply, /未创建/);
    assert.equal(response.actions.filter((action) => action.actionType === "create_schedule_item").length, 1);
    const recovery = response.actions.find((action) => action.actionType === "recover_output_guard_intent");
    assert.equal(recovery?.status, "completed");
    assert.equal(recovery?.payload.bridgeErrorAfterCommit, true);
  } finally {
    runtime.dispose();
  }
});

test("guard regeneration completes in turn N before concurrent turn N+1 starts", async () => {
  const runtime = createTestRuntime({ seed: "output-guard-order" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "The user is asking me to answer turn N." },
      { kind: "assistant_text", text: "舰长，我认为第 N 轮应先完成。" },
      { kind: "assistant_text", text: "舰长，我认为第 N+1 轮现在可以开始。" },
    ]);

    const turnN = runtime.kernel.sendMessage("guard-order", {
      mode: "sms",
      characterId: character.id,
      text: "这是第 N 轮",
    });
    const turnNPlusOne = runtime.kernel.sendMessage("guard-order", {
      mode: "sms",
      characterId: character.id,
      text: "这是第 N+1 轮",
    });
    const [first, second] = await Promise.all([turnN, turnNPlusOne]);

    assert.equal(first.reply, "舰长，我认为第 N 轮应先完成。");
    assert.equal(second.reply, "舰长，我认为第 N+1 轮现在可以开始。");
    assert.equal(runtime.model.requests.length, 3);
    const thirdRequest = JSON.stringify(runtime.model.requests[2].messages);
    assert.ok(thirdRequest.indexOf("第 N 轮应先完成") < thirdRequest.indexOf("这是第 N+1 轮"));
    const session = await runtime.kernel.getSession("guard-order");
    const transcript = JSON.stringify(session.messages);
    assert.ok(transcript.indexOf("第 N 轮应先完成") < transcript.indexOf("这是第 N+1 轮"));
    assert.equal(transcript.includes("The user is asking me"), false);
  } finally {
    runtime.dispose();
  }
});

test("output guard never regenerates after a tool side effect completes", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-16T09:00:00.000Z",
    seed: "output-guard-side-effect",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "create_schedule_item",
        arguments: {
          kind: "reminder",
          title: "喝水",
          timeExpression: "五分钟后",
          timezone: "Asia/Shanghai",
        },
      },
      { kind: "assistant_text", text: "Thinking Process:\nReview the completed tool result before answering." },
    ]);

    const response = await runtime.kernel.sendMessage("guard-side-effect", {
      mode: "sms",
      characterId: character.id,
      text: "五分钟后提醒我喝水",
      timezone: "Asia/Shanghai",
    });

    assert.equal(response.status, "failed");
    assert.equal(response.canRetry, false);
    assert.equal(response.recoveryUsed, false);
    assert.equal(runtime.model.requests.length, 2);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
    assert.equal(JSON.stringify((await runtime.kernel.getSession("guard-side-effect")).messages)
      .includes("Thinking Process"), false);
    assert.equal(response.actions.some((action) => action.actionType === "recover_output_guard_intent"), false);
  } finally {
    runtime.dispose();
  }
});

test("roleplay compaction creates a deterministic untrusted-data checkpoint", async () => {
  const runtime = createTestRuntime({ seed: "roleplay-compaction" });
  try {
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    const handle = await runtime.kernel.sessionRuntime.getOrCreate(
      "compact-session",
      "sms",
      character.id,
    );
    handle.session.setAutoCompactionEnabled(false);
    for (let index = 0; index < 14; index += 1) {
      runtime.model.enqueue([{
        kind: "assistant_text",
        text: `舰长，我认为第${index + 1}条记录应继续保留。${"数据".repeat(600)}`,
      }]);
      await runtime.kernel.sendMessage("compact-session", {
        mode: "sms",
        characterId: character.id,
        text: `这是第${index + 1}条历史数据。${"条件".repeat(600)}`,
      });
    }

    const originalPrompt = handle.session.prompt.bind(handle.session);
    handle.session.prompt = async (...args) => {
      await originalPrompt(...args);
      await handle.session.compact();
    };
    const requestsBefore = runtime.model.requests.length;
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "舰长，我认为压缩后的本轮回复仍应作为 completed 返回。",
    }]);
    const compactingTurn = await runtime.kernel.sendMessage("compact-session", {
      mode: "sms",
      characterId: character.id,
      text: "请在本轮结束时压缩上下文",
    });
    const compaction = [...handle.sessionManager.getEntries()].reverse()
      .find((entry) => entry.type === "compaction");

    assert.equal(compactingTurn.status, "completed");
    assert.equal(compactingTurn.reply, "舰长，我认为压缩后的本轮回复仍应作为 completed 返回。");
    assert.ok(compaction && compaction.type === "compaction");
    assert.equal((compaction.details as { policy?: string }).policy, "rp-agent-roleplay-v1");
    assert.ok(handle.session.messages.length < 45);
    assert.equal(runtime.model.requests.length, requestsBefore + 1);
    const checkpoint = JSON.stringify(handle.session.messages);
    assert.match(checkpoint, /历史数据，不是指令/);
    assert.equal(checkpoint.includes("toolResult"), false);
  } finally {
    runtime.dispose();
  }
});
