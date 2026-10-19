import assert from "node:assert/strict";
import test from "node:test";
import { estimateModelMessageTokens, estimatedImageTokens } from "../src/context/tokens.js";
import { createTestRuntime } from "../src/testing/index.js";

test("image transport encodings do not count as text in provider or Pi messages", () => {
  for (const makeImage of [
    (data: string) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + data } }),
    (data: string) => ({ type: "input_image", image_url: "data:image/png;base64," + data }),
    (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } }),
    (data: string) => ({ type: "image", mimeType: "image/png", data }),
    (data: string) => ({ inlineData: { mimeType: "image/png", data } }),
  ]) {
    const small = estimateModelMessageTokens({ role: "user", content: [makeImage("AAAA")] });
    const large = estimateModelMessageTokens({ role: "user", content: [makeImage("A".repeat(2_000_000))] });
    assert.equal(large, small);
    assert.ok(large >= estimatedImageTokens && large < estimatedImageTokens + 100);
  }
  assert.ok(estimateModelMessageTokens({ role: "user", content: "A".repeat(40_000) }) > 10_000,
    "ordinary long text must still consume its real estimate");
});

test("three screenshots and a short follow-up do not trigger false context exhaustion", async () => {
  const runtime = createTestRuntime({ seed: "image-budget" });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 65_536, maxTokens: 4_096 });
    const character = runtime.kernel.createCharacter({ name: "截图预算" });
    const handle = await runtime.kernel.sessionRuntime.getOrCreate("image-budget", "sms", character.id);
    runtime.kernel.sessionRuntime.appendMessages(handle, [{ role: "user", timestamp: runtime.clock.now().getTime(), content: [
      { type: "text", text: "请看三张截图。" },
      ...Array.from({ length: 3 }, () => ({ type: "image" as const, mimeType: "image/png", data: "A".repeat(800_000) })),
    ] }]);
    runtime.model.enqueue([
      { kind: "assistant_text", text: "看到了。", usage: { input: 26_000, output: 100 } },
      { kind: "assistant_text", text: "好的，不归档。", usage: { input: 27_000, output: 100 } },
    ]);
    const first = await runtime.kernel.sendMessage("image-budget", { mode: "sms", characterId: character.id, text: "回答问题。" });
    assert.equal(first.status, "completed");
    const economics = runtime.kernel.recentContextEconomics(1)[0];
    assert.ok(economics.estimatedInputTokens < 65_536, String(economics.estimatedInputTokens));
    // Reproduce a persisted estimate from the old release. Actual provider
    // usage must take precedence when projecting the next request.
    const metricsRow = runtime.kernel.database.connection.prepare("SELECT metrics_json FROM context_economics WHERE id = ?").get(economics.id) as { metrics_json: string };
    runtime.kernel.database.connection.prepare("UPDATE context_economics SET metrics_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(metricsRow.metrics_json), estimatedInputTokens: 600_000 }), economics.id);
    const second = await runtime.kernel.sendMessage("image-budget", { mode: "sms", characterId: character.id, text: "截图不用归档。" });
    assert.equal(second.status, "completed");
    assert.equal(runtime.model.requests.length, 2);
    assert.equal(handle.sessionManager.getEntries().filter(entry => entry.type === "compaction").length, 0);

    // Old compaction metadata carried the Base64 error forward forever.
    handle.metadata.lastCompactionAt = "2099-01-01T00:00:00.000Z";
    handle.metadata.lastCompactionEstimatedTokensAfter = 600_000;
    const restored = await runtime.kernel.getConversationContextBudget("image-budget");
    assert.ok(restored.usedInputTokens < 65_536, String(restored.usedInputTokens));
    assert.notEqual(restored.level, "critical");
  } finally { runtime.dispose(); }
});
