import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel, GroupChatValidationError } from "../src/domain/index.js";

test("group chat routes each character through its model and later gates see earlier replies", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-group-chat-"));
  const requests: Array<{ model: string; body: string }> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ content?: string }> };
    const model = parsed.model ?? "unknown";
    requests.push({ model, body });
    const prompt = JSON.stringify(parsed.messages ?? []);
    const content = prompt.includes("participation controller for Alice")
      ? prompt.includes("Messages already sent by Alice in this user turn: 0")
        ? '{"speak":true,"reasonCode":"relevant"}'
        : '{"speak":false,"reasonCode":"none"}'
      : prompt.includes("participation controller for Bob")
        ? 'Decision: {"speak":false,"reasonCode":"none"}'
        : model === "alice-model"
          ? "Alice先发了一条消息"
          : "Bob不应生成这条消息";
    writeChatCompletionStream(response, model, content);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  let kernel: CompanionKernel | undefined;
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    kernel = new CompanionKernel({ stateDir, startScheduler: false });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "alice-model" });
    const bobProfile = kernel.createModelApiProfile({ name: "Bob 模型", enabled: true, baseUrl, model: "bob-model" });
    const alice = kernel.createCharacter({ name: "Alice" });
    const bob = kernel.createCharacter({ name: "Bob", modelProfileId: bobProfile.id });
    const group = kernel.createGroupChat({ characterIds: [alice.id, bob.id], maxSpeakers: 2 });
    const events: string[] = [];

    const result = await kernel.sendGroupMessage(group.id, "大家怎么看？", "Asia/Shanghai", (event) => {
      if (event.type === "participant_state") events.push(`${event.characterId}:${event.phase}`);
      if (event.type === "message") events.push(`${event.message.senderId}:message`);
    });

    assert.equal(result.turn.status, "completed");
    assert.equal(result.turn.modelCalls, 5);
    assert.equal(result.turn.speakerCount, 1);
    assert.equal(result.turn.messageCount, 1);
    assert.equal(result.messages[0].content, "Alice先发了一条消息");
    assert.deepEqual(result.decisions.map((entry) => [entry.characterId, entry.outcome]), [
      [alice.id, "speak"],
      [bob.id, "silent"],
      [bob.id, "silent"],
      [alice.id, "silent"],
    ]);
    assert.deepEqual(requests.map((entry) => entry.model), [
      "alice-model", "alice-model", "bob-model", "bob-model", "alice-model",
    ]);
    assert.equal((JSON.parse(requests[0].body) as { max_tokens?: number }).max_tokens, 768);
    assert.match(requests[2].body, /Alice先发了一条消息/);
    assert.deepEqual(events, [
      `${alice.id}:evaluating`,
      `${alice.id}:typing`,
      `${alice.id}:message`,
      `${bob.id}:evaluating`,
      `${bob.id}:silent`,
      `${bob.id}:evaluating`,
      `${bob.id}:silent`,
      `${alice.id}:evaluating`,
      `${alice.id}:silent`,
    ]);
    assert.deepEqual(kernel.listGroupChatMessages(group.id).map((entry) => entry.senderType), ["user", "character"]);
    assert.deepEqual(kernel.recentModelContextTraces(10).map((entry) => entry.turnKind), [
      "group_gate",
      "group_gate",
      "group_gate",
      "group_reply",
      "group_gate",
    ]);
  } finally {
    kernel?.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("group chat validates membership and enforces speaker and per-character message caps", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-group-cap-"));
  let calls = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    calls += 1;
    writeChatCompletionStream(
      response,
      "group-model",
      body.includes("participation controller")
        ? '{"speak":true,"reasonCode":"reaction"}'
        : "只允许第一位角色回复",
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  let kernel: CompanionKernel | undefined;
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    kernel = new CompanionKernel({ stateDir, startScheduler: false });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "group-model",
    });
    const first = kernel.createCharacter({ name: "First" });
    const second = kernel.createCharacter({ name: "Second" });
    assert.throws(
      () => kernel!.createGroupChat({ characterIds: [first.id, first.id] }),
      GroupChatValidationError,
    );
    const group = kernel.createGroupChat({ characterIds: [first.id, second.id], maxSpeakers: 1 });
    const result = await kernel.sendGroupMessage(group.id, "继续");
    assert.equal(result.turn.speakerCount, 1);
    assert.equal(result.turn.messageCount, 10);
    assert.equal(result.messages.length, 10);
    assert.equal(result.decisions.length, 10);
    assert.equal(calls, 20);
  } finally {
    kernel?.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function writeChatCompletionStream(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-group",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-group",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
