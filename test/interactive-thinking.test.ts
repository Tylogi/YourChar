import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("MLX dialogue discards a no-thinking draft and regenerates from the same user message", async () => {
  const runtime = createTestRuntime({ seed: "interactive-thinking-retry" });
  try {
    runtime.kernel.patchModelApiConfig({ model: "scripted-MLX-model" });
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "舰长，随便吧。" },
      {
        kind: "assistant_text",
        thinking: "用户在试探角色的态度，需要结合关系状态认真回应，同时保持第一人称私聊口吻。",
        text: "舰长，我不是觉得随便，只是刚才没接住你的意思。你想约我，我其实很在意。",
      },
    ]);

    const streamed = new Array<string>();
    const response = await runtime.kernel.streamMessage("thinking-retry", {
      mode: "sms",
      characterId: character.id,
      text: "你是不是根本不在意我？",
    }, (event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        streamed.push(JSON.stringify(event.message.content));
      }
    });

    assert.equal(response.status, "completed");
    assert.equal(response.reply, "舰长，我不是觉得随便，只是刚才没接住你的意思。你想约我，我其实很在意。");
    assert.equal(runtime.model.requests.length, 2);
    assert.match(runtime.model.requests[1].systemPrompt, /TRUSTED THINKING RETRY 1/);
    assert.equal(streamed.join("").includes("随便吧"), false);
    assert.equal(streamed.join("").includes("我其实很在意"), true);

    const session = await runtime.kernel.getSession("thinking-retry");
    const serialized = JSON.stringify(session.messages);
    assert.equal(serialized.includes("随便吧"), false);
    assert.equal(serialized.includes("我其实很在意"), true);
    assert.equal(serialized.includes("rp-agent/output_guard_retry"), false);
  } finally {
    runtime.dispose();
  }
});

test("MLX dialogue bounds missing-thinking regeneration and accepts the final usable draft", async () => {
  const runtime = createTestRuntime({ seed: "interactive-thinking-bounded" });
  try {
    runtime.kernel.patchModelApiConfig({ model: "scripted-MLX-model" });
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一份空思考草稿" },
      { kind: "assistant_text", text: "第二份空思考草稿" },
      { kind: "assistant_text", text: "第三份空思考草稿" },
    ]);

    const response = await runtime.kernel.sendMessage("thinking-bounded", {
      mode: "rp",
      characterId: character.id,
      text: "继续刚才的剧情",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.canRetry, false);
    assert.equal(response.reply, "第三份空思考草稿");
    assert.equal(runtime.model.requests.length, 3);
    assert.match(runtime.model.requests[1].systemPrompt, /TRUSTED THINKING RETRY 1/);
    assert.match(runtime.model.requests[2].systemPrompt, /TRUSTED THINKING RETRY 2/);

    const session = await runtime.kernel.getSession("thinking-bounded");
    const serialized = JSON.stringify(session.messages);
    assert.equal(serialized.includes("第一份空思考草稿"), false);
    assert.equal(serialized.includes("第二份空思考草稿"), false);
    assert.equal(serialized.includes("第三份空思考草稿"), true);
  } finally {
    runtime.dispose();
  }
});

test("MLX thinking guard does not replay a turn after a tool has executed", async () => {
  const runtime = createTestRuntime({ seed: "interactive-thinking-tool" });
  try {
    runtime.kernel.patchModelApiConfig({ model: "scripted-MLX-model" });
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "list_schedule_items", arguments: { calendar: "user" } },
      { kind: "assistant_text", text: "舰长，我已经核对过你的日程了。" },
    ]);

    const response = await runtime.kernel.sendMessage("thinking-tool", {
      mode: "sms",
      characterId: character.id,
      text: "看一下我的日程",
    });

    assert.equal(response.status, "completed");
    assert.equal(runtime.model.requests.length, 2);
    assert.equal(response.events.filter((event) =>
      event.type === "tool_execution_end" && event.toolName === "list_schedule_items"
    ).length, 1);
    assert.doesNotMatch(runtime.model.requests[1].systemPrompt, /TRUSTED THINKING RETRY/);
  } finally {
    runtime.dispose();
  }
});

test("private thinking remains inspectable but is removed from later provider context", async () => {
  const runtime = createTestRuntime({ seed: "interactive-thinking-history" });
  try {
    runtime.kernel.patchModelApiConfig({ model: "scripted-MLX-model" });
    const character = runtime.kernel.createCharacter({ name: "苏言" });
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        thinking: "第一轮私有推理只用于生成本轮回复，不应在下一轮重复发送给模型。",
        text: "舰长，第一轮我记住了。",
      },
      {
        kind: "assistant_text",
        thinking: "第二轮根据可见对话和持久状态继续，不依赖历史私有推理。",
        text: "舰长，第二轮也接得上。",
      },
    ]);

    await runtime.kernel.sendMessage("thinking-history", {
      mode: "sms",
      characterId: character.id,
      text: "第一轮",
    });
    await runtime.kernel.sendMessage("thinking-history", {
      mode: "sms",
      characterId: character.id,
      text: "第二轮",
    });

    const secondPayload = JSON.stringify(runtime.model.requests[1].providerPayload.messages);
    assert.doesNotMatch(secondPayload, /第一轮私有推理/);
    assert.match(secondPayload, /舰长，第一轮我记住了/);
    const persisted = JSON.stringify((await runtime.kernel.getSession("thinking-history")).messages);
    assert.match(persisted, /第一轮私有推理/);
  } finally {
    runtime.dispose();
  }
});
