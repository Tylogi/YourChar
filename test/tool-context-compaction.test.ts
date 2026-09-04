import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("large tool results are bounded for the provider without rewriting the transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-tool-context-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({ seed: "tool-context-compaction", workspaceDir });
  try {
    const fullPayload = `${"0123456789".repeat(9_000)}FULL_TRANSCRIPT_TAIL`;
    const secondPayload = `${"abcdefghij".repeat(9_000)}SECOND_TRANSCRIPT_TAIL`;
    writeFileSync(join(workspaceDir, "large.txt"), fullPayload, "utf8");
    writeFileSync(join(workspaceDir, "second.txt"), secondPayload, "utf8");
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "read", arguments: { path: "large.txt", limit: 1 } },
      { kind: "assistant_text", text: "文件已读取。" },
      { kind: "tool_call", name: "read", arguments: { path: "second.txt", limit: 1 } },
      { kind: "assistant_text", text: "第二个文件也已读取。" },
      { kind: "assistant_text", text: "继续。" },
    ]);

    await runtime.kernel.sendMessage("large-tool-context", { mode: "sms", text: "读取大文件" });
    const currentResult = toolResultText(runtime.model.requests[1].messages);
    assert.ok(currentResult.length <= 32_000, `current tool context was ${currentResult.length} characters`);
    assert.match(currentResult, /Tool result compacted for active model context/);

    const session = await runtime.kernel.getSession("large-tool-context");
    const persistedResult = toolResultText(session.messages);
    assert.ok(persistedResult.length > 90_000);
    assert.match(persistedResult, /FULL_TRANSCRIPT_TAIL/);
    assert.doesNotMatch(persistedResult, /Tool result compacted for active model context/);

    await runtime.kernel.sendMessage("large-tool-context", { mode: "sms", text: "再读取第二个文件" });
    const historicalResult = toolResultText(runtime.model.requests[2].messages);
    assert.ok(historicalResult.length <= 6_000, `historical tool context was ${historicalResult.length} characters`);
    assert.match(historicalResult, /Tool result compacted for active model context/);

    await runtime.kernel.sendMessage("large-tool-context", { mode: "sms", text: "综合两个结果" });
    const finalProviderMessages = runtime.model.requests[4].messages;
    const finalToolResults = messagesWithRole(finalProviderMessages, "toolResult");
    assert.equal(finalToolResults.length, 1);
    assert.match(toolResultText(finalProviderMessages), /SECOND_TRANSCRIPT_TAIL/);
    const finalToolCalls = finalProviderMessages.flatMap((entry) => assistantToolCallIds(entry));
    assert.equal(finalToolCalls.length, 1);

    const persistedAfterNextTurn = messagesWithRole(
      (await runtime.kernel.getSession("large-tool-context")).messages,
      "toolResult",
    );
    assert.equal(persistedAfterNextTurn.length, 2);
    assert.ok(toolResultText(persistedAfterNextTurn).length > 90_000);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("current-turn tool results retain an append-only provider prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-tool-prefix-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({ seed: "tool-prefix-stability", workspaceDir });
  try {
    for (const [name, character] of [["first.txt", "a"], ["second.txt", "b"], ["third.txt", "c"]]) {
      writeFileSync(join(workspaceDir, name), character.repeat(90_000), "utf8");
    }
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "read", arguments: { path: "first.txt", limit: 1 } },
      { kind: "tool_call", name: "read", arguments: { path: "second.txt", limit: 1 } },
      { kind: "tool_call", name: "read", arguments: { path: "third.txt", limit: 1 } },
      { kind: "assistant_text", text: "三个文件均已读取。" },
    ]);

    await runtime.kernel.sendMessage("append-only-tool-prefix", {
      mode: "sms",
      text: "依次读取三个大文件",
    });

    assert.equal(runtime.model.requests.length, 4);
    for (let index = 1; index < runtime.model.requests.length - 1; index += 1) {
      const previous = runtime.model.requests[index].messages;
      const next = runtime.model.requests[index + 1].messages;
      assert.deepEqual(
        next.slice(0, previous.length),
        previous,
        `provider request ${index + 1} rewrote an existing message prefix`,
      );
    }

    const resultLengths = toolResultTexts(runtime.model.requests.at(-1)?.messages ?? [])
      .map((text) => text.length);
    assert.equal(resultLengths.length, 3);
    assert.ok(resultLengths[0] <= 32_000, `first result was ${resultLengths[0]} characters`);
    assert.ok(resultLengths[1] <= 16_000, `second result was ${resultLengths[1]} characters`);
    assert.ok(resultLengths[2] <= 256, `third result was ${resultLengths[2]} characters`);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

function toolResultText(messages: readonly unknown[]): string {
  const message = messages.find((entry) =>
    Boolean(entry && typeof entry === "object" && "role" in entry && entry.role === "toolResult")
  );
  if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) {
    return "";
  }
  return message.content.flatMap((block) =>
    block && typeof block === "object" && "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string"
      ? [block.text]
      : []
  ).join("\n");
}

function toolResultTexts(messages: readonly unknown[]): string[] {
  return messagesWithRole(messages, "toolResult").map((message) => toolResultText([message]));
}

function messagesWithRole(messages: readonly unknown[], role: string): unknown[] {
  return messages.filter((entry) =>
    Boolean(entry && typeof entry === "object" && "role" in entry && entry.role === role)
  );
}

function assistantToolCallIds(message: unknown): string[] {
  if (
    !message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" ||
    !("content" in message) || !Array.isArray(message.content)
  ) return [];
  return message.content.flatMap((block) =>
    block && typeof block === "object" && "type" in block && block.type === "toolCall" &&
      "id" in block && typeof block.id === "string"
      ? [block.id]
      : []
  );
}
