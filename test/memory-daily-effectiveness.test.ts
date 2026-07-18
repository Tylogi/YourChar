import assert from "node:assert/strict";
import test from "node:test";
import {
  hasDurableSignal,
  isSensitiveDailyMemory,
  parseExtractorOutput,
} from "../src/memory-coordinator/index.js";
import { createTestRuntime } from "../src/testing/index.js";

test("daily-chat durable gate has high recall without treating transient chatter as memory", () => {
  const durable = [
    "我平时工作日早上七点起床。",
    "我不吃香菜。",
    "我最近在做一个叫星桥的长期项目。",
    "我妹妹叫小雨，她在上海工作。",
    "我希望年底前把论文投出去。",
    "以后回复我时尽量先说结论。",
    "I usually start work at 9 and prefer concise replies.",
  ];
  const transient = [
    "我今天有点累。",
    "窗外在下雨。",
    "你怎么看？",
    "刚刚吃完饭。",
  ];
  for (const text of durable) assert.equal(hasDurableSignal(text, "sms"), true, text);
  for (const text of transient) assert.equal(hasDurableSignal(text, "sms"), false, text);
});

test("memory extractor accepts fenced JSON with exact evidence", () => {
  const input = {
    mode: "sms" as const,
    realm: "reality" as const,
    sourceSessionId: "daily-parser",
    sourceMessageId: "daily-parser-message",
    userText: "我不吃香菜。",
    assistantText: "知道了。",
  };
  const candidates = parseExtractorOutput(`\`\`\`json
{"candidates":[{"type":"preference","content":"用户不吃香菜","confidence":0.96,"evidence":{"user":"我不吃香菜"}}]}
\`\`\``, input);
  assert.equal(candidates[0].evidence?.user, "我不吃香菜");

  const split = parseExtractorOutput(`\`\`\`json
{"candidates":[{"type":"user_fact","content":"工作日起床时间","confidence":0.95,"evidence":{"user":"我平时工作日早上七点起床"}}]}
\`\`\`
\`\`\`json
{"candidates":[{"type":"preference","content":"不吃香菜","confidence":0.96,"evidence":{"user":"我不吃香菜"}}]}
\`\`\``, { ...input, userText: "我平时工作日早上七点起床，我不吃香菜。" });
  assert.equal(split.length, 2);

  const sequence = parseExtractorOutput(`\`\`\`json
{"candidates":[{"type":"user_fact","content":"工作日起床时间","confidence":0.95,"evidence":{"user":"我平时工作日早上七点起床"}}]}
{"candidates":[{"type":"preference","content":"不吃香菜","confidence":0.96,"evidence":{"user":"我不吃香菜"}}]}
\`\`\``, { ...input, userText: "我平时工作日早上七点起床，我不吃香菜。" });
  assert.equal(sequence.length, 2);
});

test("trusted Coordinator auto-captures quoted low-risk facts and projects them across sessions", async () => {
  let extractorCalls = 0;
  const runtime = createTestRuntime({
    seed: "daily-memory-auto-capture",
    memoryExtractor: async (input) => {
      extractorCalls += 1;
      if (input.userText.includes("银行卡")) {
        return {
          candidates: [{
            type: "user_fact",
            content: "用户平时使用的银行卡号是 6222020000000000",
            confidence: 0.99,
            evidence: { user: "我平时使用的银行卡号是6222020000000000" },
          }],
        };
      }
      return {
        candidates: [
          {
            type: "user_fact",
            key: "routine.weekday_wake_time",
            content: "用户工作日早上七点起床",
            confidence: 0.96,
            evidence: { user: "我平时工作日早上七点起床" },
          },
          {
            type: "preference",
            key: "preference.food.cilantro",
            content: "用户不吃香菜",
            confidence: 0.97,
            evidence: { user: "不吃香菜" },
          },
        ],
      };
    },
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "知道了。" },
      { kind: "assistant_text", text: "这类信息会谨慎处理。" },
      { kind: "assistant_text", text: "先休息一下。" },
      { kind: "assistant_text", text: "记得。" },
    ]);

    await runtime.kernel.sendMessage("daily-source", {
      mode: "sms",
      text: "我平时工作日早上七点起床，不吃香菜。",
    });
    await runtime.kernel.memoryCoordinator.drain();
    const active = runtime.kernel.listMemories({ realm: "reality", validity: "active" });
    assert.deepEqual(active.map((memory) => memory.content).sort(), ["不吃香菜", "我平时工作日早上七点起床"].sort());
    assert.ok(active.every((memory) => memory.confirmed));
    assert.ok(active.every((memory) => memory.tags.includes("daily-auto-capture")));
    assert.match(runtime.kernel.getUserProfile().markdown, /我平时工作日早上七点起床/);
    assert.match(runtime.kernel.getUserProfile().markdown, /不吃香菜/);

    await runtime.kernel.sendMessage("daily-source", {
      mode: "sms",
      text: "我平时使用的银行卡号是6222020000000000。",
    });
    await runtime.kernel.memoryCoordinator.drain();
    const sensitive = runtime.kernel.listMemories({ realm: "reality", validity: "pending" });
    assert.equal(sensitive.length, 1);
    assert.equal(isSensitiveDailyMemory(sensitive[0].content), true);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /622202/);

    await runtime.kernel.sendMessage("daily-source", { mode: "sms", text: "我今天有点累。" });
    await runtime.kernel.memoryCoordinator.drain();
    assert.equal(extractorCalls, 2);

    await runtime.kernel.sendMessage("daily-new-session", { mode: "sms", text: "你还记得我的作息和忌口吗？" });
    const newSessionRequest = runtime.model.requests.at(-1);
    assert.match(JSON.stringify(newSessionRequest?.messages), /我平时工作日早上七点起床/);
    assert.match(JSON.stringify(newSessionRequest?.messages), /不吃香菜/);
    assert.doesNotMatch(JSON.stringify(newSessionRequest?.messages), /622202/);
  } finally {
    runtime.dispose();
  }
});
