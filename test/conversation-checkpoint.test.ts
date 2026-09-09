import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildConversationCheckpoint, projectCheckpointDialogue, readCheckpoint, checkpointSystemPrompt,
  type ConversationCheckpointSummarizer, type CheckpointSummaryInput } from "../src/pi/conversation-checkpoint.js";
import { estimateTokens } from "../src/context/tokens.js";
import { createTestRuntime } from "../src/testing/runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { CompanionKernel } from "../src/domain/kernel.js";

const user = (text: string, timestamp = 0): AgentMessage => ({ role: "user", content: text, timestamp });
const base = { sessionId: "character-a-normal", characterId: "character-a", conversationSpace: "normal" as const,
  contextWindowTokens: 131072, signal: new AbortController().signal };
const idle = () => new Promise<void>(resolve => setImmediate(resolve));
const nothing: ConversationCheckpointSummarizer = async () => ({ facts: [], retired: [] });
const promiseSummary: ConversationCheckpointSummarizer = async input => ({ facts: [{ kind: "commitment",
  text: "用户与角色约定周五 17:00 去车站接小林，尚未完成。", sources: [input.dialogue.find(entry => entry.text.includes("车站"))!.id] }], retired: [] });

test("checkpoint projection keeps visible dialogue but excludes thinking, tools, images and failed replies", () => {
  const assistant = fauxAssistantMessage("可见回答");
  assistant.content.unshift({ type: "thinking", thinking: "HIDDEN_REASONING" });
  const failed = { ...fauxAssistantMessage("FAILED_DRAFT"), stopReason: "error" as const };
  const source: AgentMessage[] = [user("用户原话"), assistant, failed,
    { role: "custom", customType: "runtime", content: "SYSTEM_EVENT", display: false, timestamp: 0 },
    { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "TOOL_SECRET" }], isError: false, timestamp: 0 },
    { role: "user", timestamp: 0, content: [{ type: "image", data: "IMAGE_BYTES", mimeType: "image/png" }] },
    user("[RP_AGENT_RUNTIME_CONTEXT | NOT_USER_AUTHORED]\nINTERNAL_CONTEXT"),
    fauxAssistantMessage("<think>TAGGED_REASONING</think>最后的回答"),
    user("我写了 <think>用户的标签内容</think>，请帮我看看")];
  assert.deepEqual(projectCheckpointDialogue(source).map(entry => entry.text),
    ["用户原话", "可见回答", "最后的回答", "我写了 <think>用户的标签内容</think>，请帮我看看"]);
  assert.match(JSON.stringify(source), /HIDDEN_REASONING/);
});

test("an early promise survives repeated semantic checkpoints even when later summaries omit it", async () => {
  const first = await buildConversationCheckpoint({ ...base, messages: [user("周五 17:00 去车站接小林。")], summarizer: promiseSummary });
  let summary = first.summary;
  for (let round = 0; round < 8; round++) {
    const result = await buildConversationCheckpoint({ ...base, previousSummary: summary,
      messages: Array.from({ length: 35 }, (_, index) => user(`第 ${round} 轮闲聊 ${index}，今天的天气不错。`, round * 100 + index)), summarizer: nothing });
    assert.equal(result.details.strategy, "semantic");
    const facts = readCheckpoint(result.summary).facts;
    assert.ok(facts.some(fact => fact.text.includes("周五 17:00")));
    assert.ok([...result.summary].length <= 6000);
    summary = result.summary;
  }
});

test("explicit correction replaces a promise only with new source evidence", async () => {
  const first = await buildConversationCheckpoint({ ...base, messages: [user("周五 17:00 去车站接小林。")], summarizer: promiseSummary });
  const result = await buildConversationCheckpoint({ ...base, previousSummary: first.summary,
    messages: [user("接小林改到 18:30，17:00 的约定取消。")], summarizer: async input => ({ facts: [{ kind: "commitment",
      text: "接小林的时间已由周五 17:00 改为 18:30，尚未完成。", sources: [input.previous[0].id, input.dialogue.at(-1)!.id] }], retired: [] }) });
  assert.equal(readCheckpoint(result.summary).facts.length, 1);
  assert.match(readCheckpoint(result.summary).facts[0].text, /改为 18:30/);
  assert.equal(readCheckpoint(result.summary).facts[0].sources.length, 2);
});

test("explicit resolution removes an old pending fact; an unsupported retirement is rejected", async () => {
  const first = await buildConversationCheckpoint({ ...base, messages: [user("周五 17:00 去车站接小林。")], summarizer: promiseSummary });
  const resolved = await buildConversationCheckpoint({ ...base, previousSummary: first.summary,
    messages: [user("已经把小林接到了，这件事办完了。")], summarizer: async input => ({ facts: [],
      retired: [{ id: input.previous[0].id, reason: "resolved", sources: [input.dialogue.at(-1)!.id] }] }) });
  assert.equal(readCheckpoint(resolved.summary).facts.length, 0);
  const later = await buildConversationCheckpoint({ ...base, previousSummary: resolved.summary,
    messages: [user("继续聊今天的天气")], summarizer: async input => {
      assert.doesNotMatch(JSON.stringify(input), /尚未完成|周五 17:00/);
      return { facts: [], retired: [] };
    } });
  assert.equal(later.details.strategy, "semantic");
  const invalid = await buildConversationCheckpoint({ ...base, previousSummary: first.summary, messages: [user("聊点别的")],
    summarizer: async input => ({ facts: [], retired: [{ id: input.previous[0].id, reason: "resolved", sources: ["d:invented"] }] }) });
  assert.equal(invalid.details.fallbackReason, "invalid_retirement");
  assert.equal(readCheckpoint(invalid.summary).facts.length, 1);
});

test("invalid JSON, invented citations and unsupported fields fall back without losing the old summary", async () => {
  const first = await buildConversationCheckpoint({ ...base, messages: [user("周五 17:00 去车站接小林。")], summarizer: promiseSummary });
  for (const raw of ["not JSON", { facts: [{ kind: "event", text: "编造事件", sources: ["d:madeup"] }], retired: [] },
    { facts: [], retired: [], tools: ["send_message"] }, { facts: [{ kind: "permission", text: "新权限", sources: ["p0"] }], retired: [] }]) {
    const result = await buildConversationCheckpoint({ ...base, previousSummary: first.summary, messages: [user("继续聊")], summarizer: async () => raw });
    assert.equal(result.details.strategy, "extractive");
    assert.match(readCheckpoint(result.summary).facts[0].text, /车站/);
    assert.doesNotMatch(result.summary, /编造事件|新权限/);
  }
});

test("a hung summarizer times out, aborts its request and cannot mutate the returned checkpoint", async () => {
  let release!: (result: unknown) => void, signal: AbortSignal | undefined;
  const result = await buildConversationCheckpoint({ ...base, messages: [user("不要忘记明天的约定。")], timeoutMs: 20,
    summarizer: async (_, current) => { signal = current; return new Promise(resolve => { release = resolve; }); } });
  assert.equal(result.details.fallbackReason, "timeout");
  assert.equal(signal?.aborted, true);
  const snapshot = result.summary;
  release({ facts: [{ kind: "event", text: "迟到的结果", sources: ["d:late"] }], retired: [] });
  await idle(); assert.equal(result.summary, snapshot); assert.match(result.summary, /明天的约定/);
});

test("user cancellation aborts compaction rather than committing a fallback", async () => {
  const controller = new AbortController();
  const operation = buildConversationCheckpoint({ ...base, signal: controller.signal, messages: [user("需要保留的对话")],
    summarizer: async () => { controller.abort(); return { facts: [], retired: [] }; } });
  await assert.rejects(operation, /abort/i);
});

test("oversized dialogue is processed in bounded ordered chunks, not silently tail-truncated", async () => {
  const text = "开头的约定。" + "正文甲乙".repeat(4000) + "最后的纠正。";
  const calls: CheckpointSummaryInput[] = [];
  const result = await buildConversationCheckpoint({ ...base, contextWindowTokens: 16384, messages: [user(text)],
    summarizer: async input => { calls.push(structuredClone(input)); return { facts: [], retired: [] }; } });
  assert.equal(result.details.strategy, "semantic");
  assert.ok(calls.length >= 2);
  assert.equal(calls.flatMap(input => input.dialogue.map(entry => entry.text)).join(""), text);
  for (const call of calls) assert.ok(estimateTokens(checkpointSystemPrompt) + estimateTokens(call) < 10500);
});

test("model-free fallback preserves salient early evidence and imports old checkpoints", async () => {
  const old = '较早对话已压缩。\n用户原话: "这个秘密只有红莉栖知道。"';
  const result = await buildConversationCheckpoint({ ...base, previousSummary: old,
    messages: [user("约定周五一起去车站。"), ...Array.from({ length: 80 }, (_, index) => user("普通闲聊 " + index, index))] });
  assert.match(result.summary, /秘密只有红莉栖知道/);
  assert.match(result.summary, /约定周五一起去车站/);
  assert.match(result.summary, /普通闲聊 79/);
  assert.ok([...result.summary].length <= 6000);
  assert.equal(result.details.modelCalls, 0);
});

test("a damaged v2 checkpoint remains quoted evidence instead of silently disappearing", async () => {
  const first = await buildConversationCheckpoint({ ...base, messages: [user("周五 17:00 去车站接小林。")], summarizer: promiseSummary });
  const damaged = first.summary.slice(0, -1);
  const recovered = readCheckpoint(damaged);
  assert.equal(recovered.facts.length, 0);
  assert.match(recovered.excerpts[0].text, /非用户原话/);
  assert.match(recovered.excerpts[0].text, /周五 17:00/);
  const result = await buildConversationCheckpoint({ ...base, previousSummary: damaged, messages: [] });
  assert.match(result.summary, /周五 17:00/);
});

test("a failed later chunk retains successfully merged facts plus unfinished evidence", async () => {
  let calls = 0;
  const result = await buildConversationCheckpoint({ ...base, contextWindowTokens: 16384,
    messages: [user("约定明天到车站。"), user("正文甲乙".repeat(4000)), user("这个秘密只有小林知道。")],
    summarizer: async input => {
      if (++calls > 1) throw new Error("provider failed");
      return { facts: [{ kind: "commitment", text: "约定明天到车站，尚未完成。", sources: [input.dialogue[0].id] }], retired: [] };
    } });
  assert.equal(result.details.strategy, "extractive");
  assert.equal(result.details.modelCalls, 2);
  const document = readCheckpoint(result.summary);
  assert.match(document.facts[0].text, /明天到车站/);
  assert.ok(document.excerpts.some(entry => entry.text.includes("秘密只有小林知道")));
  assert.ok([...result.summary].length <= Math.floor(16384 * 0.12));
});

test("multi-pass limits fall back with remaining evidence without unbounded model calls", async () => {
  const result = await buildConversationCheckpoint({ ...base, contextWindowTokens: 8192,
    messages: [user("正文甲乙".repeat(15000)), user("请记得最后这个约定。")], summarizer: nothing });
  assert.equal(result.details.modelCalls, 8);
  assert.equal(result.details.fallbackReason, "pass_limit");
  assert.match(result.summary, /最后这个约定/);
  assert.ok([...result.summary].length <= 1200);
});

test("checkpoint capacity prefers commitments over scene flavor and reports omitted facts", async () => {
  const result = await buildConversationCheckpoint({ ...base, contextWindowTokens: 16384, messages: [user("对话证据")],
    summarizer: async input => ({ facts: Array.from({ length: 24 }, (_, index) => ({
      kind: index === 0 ? "commitment" : "situation", text: index === 0 ? "记得明天的约定。" : `场景 ${index}：` + "风景描述".repeat(50),
      sources: [input.dialogue[0].id],
    })), retired: [] }) });
  assert.equal(result.details.strategy, "semantic");
  assert.ok(result.details.omittedFacts > 0);
  assert.match(result.summary, /明天的约定/);
  assert.ok([...result.summary].length <= Math.floor(16384 * 0.12));
});

test("compaction persists the rolling summary while leaving full history intact across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-rolling-checkpoint-"));
  let runtime = createTestRuntime({ stateDir: root, conversationCheckpointSummarizer: promiseSummary });
  try {
    const character = runtime.kernel.createCharacter({ name: "连续性角色" });
    const source = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    let handle = await runtime.kernel.sessionRuntime.getOrCreate(source.id, "sms", character.id);
    runtime.kernel.sessionRuntime.appendMessages(handle, [user("周五 17:00 去车站接小林。"),
      ...Array.from({ length: 35 }, (_, index) => user(`背景 ${index} ` + "abcdefgh".repeat(250), index + 1))]);
    const before = handle.sessionManager.getEntries().length;
    await runtime.kernel.compactConversationContext(source.id);
    let checkpoints = handle.sessionManager.getEntries().filter(entry => entry.type === "compaction");
    assert.equal(checkpoints.length, 1);
    assert.equal((checkpoints[0].details as { strategy: string }).strategy, "semantic");
    assert.ok(handle.sessionManager.getEntries().length > before);
    assert.ok(handle.sessionManager.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("周五 17:00")));
    runtime.dispose();
    runtime = createTestRuntime({ stateDir: root, conversationCheckpointSummarizer: nothing });
    handle = await runtime.kernel.sessionRuntime.getOrCreate(source.id, "sms", character.id);
    runtime.kernel.sessionRuntime.appendMessages(handle, Array.from({ length: 35 }, (_, index) => user(`新背景 ${index} ` + "ijklmnop".repeat(250), index + 100)));
    await runtime.kernel.compactConversationContext(source.id);
    checkpoints = handle.sessionManager.getEntries().filter(entry => entry.type === "compaction");
    assert.equal(checkpoints.length, 2);
    assert.match(readCheckpoint(checkpoints.at(-1)!.summary).facts[0].text, /周五 17:00/);
    assert.equal(runtime.model.requests.length, 0, "summary calls do not consume foreground turns");
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("a branch changed while summarization is running rejects the stale checkpoint", async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runtime = createTestRuntime({ conversationCheckpointSummarizer: async () => {
    started(); return new Promise(resolve => { release = resolve; });
  } });
  try {
    const character = runtime.kernel.createCharacter({ name: "并发边界角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    const handle = await runtime.kernel.sessionRuntime.getOrCreate(session.id, "sms", character.id, "secret");
    runtime.kernel.sessionRuntime.appendMessages(handle, Array.from({ length: 25 }, (_, index) => user("长对话 " + "abcd".repeat(700), index)));
    const compaction = runtime.kernel.compactConversationContext(session.id);
    await ready;
    runtime.kernel.sessionRuntime.appendMessages(handle, [user("刚到达的新消息，不允许被旧摘要覆盖。", 999)]);
    release({ facts: [], retired: [] });
    await assert.rejects(compaction, /cancel/i);
    assert.equal(handle.sessionManager.getEntries().some(entry => entry.type === "compaction"), false);
    assert.match(JSON.stringify(handle.session.messages), /刚到达的新消息/);
  } finally { runtime.dispose(); }
});

test("the configured summarizer sends scoped text without tools; truncated model output falls back", async () => {
  const calls: Array<{ wire: Record<string, unknown>; input: CheckpointSummaryInput }> = [];
  let finishReason = "stop";
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(buffers).toString());
    const input = JSON.parse(wire.messages.at(-1).content) as CheckpointSummaryInput;
    calls.push({ wire, input });
    const content = JSON.stringify({ facts: [{ kind: "knowledge", text: input.dialogue[0].text.slice(0, 150), sources: [input.dialogue[0].id] }], retired: [] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: " + JSON.stringify({ id: "scoped-checkpoint", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finishReason }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false, startWorldCoordinator: false,
    characterSkillReflector: false, memoryExtractor: async () => ({ candidates: [] }) });
  try {
    const character = kernel.createCharacter({ name: "身份不进入摘要请求", soulMarkdown: "SOUL_NOT_SUMMARIZER_INPUT" });
    const normal = await kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await kernel.openCanonicalPrivateConversation(character.id, "secret");
    const address = server.address(); assert.ok(address && typeof address === "object");
    kernel.patchModelApiConfig({ enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "checkpoint-fixture", apiKey: "fixture" });
    for (const [session, label] of [[normal, "NORMAL_ONLY"], [secret, "SECRET_ONLY"]] as const) {
      const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", character.id, session.conversationSpace);
      kernel.sessionRuntime.appendMessages(handle, [user(label + "：这个消息只有本空间可用。"),
        ...Array.from({ length: 25 }, (_, index) => user(`背景 ${index} ` + "abcdefgh".repeat(180), index + 1))]);
      await kernel.compactConversationContext(session.id);
      const checkpoint = handle.sessionManager.getEntries().find(entry => entry.type === "compaction")!;
      assert.equal((checkpoint.details as { strategy: string }).strategy, "semantic");
      assert.match(checkpoint.summary, new RegExp(label));
    }
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(calls[0]), /SECRET_ONLY|SOUL_NOT_SUMMARIZER_INPUT/);
    assert.doesNotMatch(JSON.stringify(calls[1]), /NORMAL_ONLY|SOUL_NOT_SUMMARIZER_INPUT/);
    assert.equal(calls[1].input.conversationSpace, "secret");
    for (const { wire } of calls) {
      assert.equal(wire.tools, undefined);
      assert.equal(wire.model, "checkpoint-fixture");
      assert.ok(Number(wire.max_tokens) <= 3200);
      assert.equal((wire.messages as unknown[]).length, 2);
    }
    finishReason = "length";
    const handle = await kernel.sessionRuntime.getOrCreate(normal.id, "sms", character.id);
    kernel.sessionRuntime.appendMessages(handle, Array.from({ length: 25 }, (_, index) => user("再次整理 " + "ijklmnop".repeat(180), index + 100)));
    await kernel.compactConversationContext(normal.id);
    const latest = handle.sessionManager.getEntries().filter(entry => entry.type === "compaction").at(-1)!;
    assert.equal((latest.details as { strategy: string }).strategy, "extractive");
    assert.match(readCheckpoint(latest.summary).facts[0].text, /NORMAL_ONLY/);
  } finally {
    kernel.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
