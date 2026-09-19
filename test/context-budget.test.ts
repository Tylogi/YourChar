import assert from "node:assert/strict";
import test from "node:test";
import { buildContextBudget } from "../src/context/index.js";
import { measuredContextInputTokens } from "../src/context/provider-usage.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("context budget deducts output and safety reserves from a configured model window", () => {
  const budget = buildContextBudget({
    sessionId: "budget-unit",
    modelProfileId: "small-model",
    model: "small",
    contextWindowTokens: 32_768,
    maxOutputTokens: 2_048,
    estimatedInputTokens: 9_000,
    actualInputTokens: 10_000,
    updatedAt: "2026-07-20T01:00:00.000Z",
  });

  assert.equal(budget.contextWindowSource, "configured");
  assert.equal(budget.safetyReserveTokens, 2_622);
  assert.equal(budget.usableInputTokens, 28_098);
  assert.equal(budget.usedInputTokens, 10_000);
  assert.equal(budget.usageSource, "measured");
  assert.equal(budget.remainingTokens, 18_098);
  assert.equal(budget.level, "healthy");
});

test("planned compaction uses a ninety-percent fallback for 128k windows and a 128 Ki-token cap for larger profiles", () => {
  const fallback = buildContextBudget({
    sessionId: "planned-fallback",
    modelProfileId: "128k-model",
    model: "medium",
    contextWindowTokens: 131_072,
    maxOutputTokens: 4_096,
    estimatedInputTokens: 0,
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  assert.ok(Math.abs(fallback.plannedThresholdTokens - Math.floor(fallback.usableInputTokens * 0.9)) <= 1);
  assert.ok(fallback.plannedThresholdTokens < 128 * 1_024);

  const belowFallback = buildContextBudget({
    sessionId: "planned-fallback-below",
    modelProfileId: "128k-model",
    model: "medium",
    contextWindowTokens: 131_072,
    maxOutputTokens: 4_096,
    estimatedInputTokens: fallback.plannedThresholdTokens - 1,
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  const atFallback = buildContextBudget({
    sessionId: "planned-fallback-at",
    modelProfileId: "128k-model",
    model: "medium",
    contextWindowTokens: 131_072,
    maxOutputTokens: 4_096,
    estimatedInputTokens: fallback.plannedThresholdTokens,
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  assert.equal(belowFallback.shouldCompact, false);
  assert.equal(atFallback.shouldCompact, true);

  const large = buildContextBudget({
    sessionId: "planned-cap",
    modelProfileId: "256k-model",
    model: "large",
    contextWindowTokens: 262_144,
    maxOutputTokens: 4_096,
    estimatedInputTokens: 128 * 1_024,
    updatedAt: "2026-07-20T01:00:00.000Z",
  });
  assert.equal(large.plannedThresholdTokens, 128 * 1_024);
  assert.equal(large.shouldCompact, true);
  assert.ok(large.plannedThresholdTokens < Math.floor(large.usableInputTokens * 0.9));
});

test("cached provider input counts toward the occupied context window", async () => {
  assert.equal(measuredContextInputTokens({
    inputTokens: 913,
    outputTokens: 247,
    cacheReadTokens: 24_064,
    cacheWriteTokens: 0,
  }), 24_977);

  const runtime = createTestRuntime({ seed: "context-budget-cache-usage" });
  try {
    runtime.kernel.patchModelApiConfig({
      contextWindowTokens: 131_072,
      maxTokens: 4_096,
    });
    const character = runtime.kernel.createCharacter({ name: "缓存预算角色" });
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "缓存上下文也属于模型本轮实际读取的输入。",
      usage: { input: 913, output: 247, cacheRead: 24_064 },
    }]);
    await runtime.kernel.sendMessage("cached-context-budget", {
      mode: "sms",
      characterId: character.id,
      text: "检查缓存后的上下文余量",
    });

    const actual = runtime.kernel.recentContextEconomics(1)[0].actual;
    const measured = measuredContextInputTokens(actual);
    assert.notEqual(measured, null);
    assert.ok((actual.cacheReadTokens ?? 0) > 0 || (actual.cacheWriteTokens ?? 0) > 0);
    const budget = await runtime.kernel.getConversationContextBudget("cached-context-budget");
    assert.equal(budget.actualInputTokens, measured);
    assert.equal(budget.usedInputTokens, measured);
    assert.ok(budget.usedInputTokens > (actual.inputTokens ?? 0));
    assert.equal(budget.remainingTokens, budget.usableInputTokens - budget.usedInputTokens);
  } finally {
    runtime.dispose();
  }
});

test("a character-bound session reports its model budget and manual compaction through HTTP", async () => {
  const runtime = createTestRuntime({ seed: "context-budget-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  try {
    runtime.kernel.patchModelApiConfig({
      contextWindowTokens: 65_536,
      maxTokens: 2_048,
    });
    const character = runtime.kernel.createCharacter({ name: "上下文测试角色" });
    runtime.model.enqueue(Array.from({ length: 4 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `第 ${index + 1} 轮回复。${"连续内容".repeat(650)}`,
      usage: { input: 7_000 + index * 2_000, output: 900 },
    })));
    for (let index = 0; index < 4; index += 1) {
      await runtime.kernel.sendMessage("context-budget-session", {
        mode: "sms",
        characterId: character.id,
        text: `第 ${index + 1} 轮输入。${"上下文条件".repeat(650)}`,
      });
    }

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const beforeResponse = await fetch(`${baseUrl}/api/v1/sessions/context-budget-session/context-budget`);
    assert.equal(beforeResponse.status, 200);
    const before = (await beforeResponse.json()) as {
      budget: {
        contextWindowTokens: number;
        maxOutputTokens: number;
        usageSource: string;
        remainingTokens: number;
        estimatedInputTokens: number;
      };
    };
    assert.equal(before.budget.contextWindowTokens, 65_536);
    assert.equal(before.budget.maxOutputTokens, 2_048);
    assert.equal(before.budget.usageSource, "measured");

    const compactResponse = await fetch(`${baseUrl}/api/v1/sessions/context-budget-session/compact`, {
      method: "POST",
    });
    assert.equal(compactResponse.status, 200);
    const compacted = (await compactResponse.json()) as {
      result: {
        compacted: boolean;
        reason: string;
        budgetAfter: {
          remainingTokens: number;
          estimatedInputTokens: number;
          lastCompaction?: { status: string; reason: string };
        };
      };
    };
    assert.equal(compacted.result.compacted, true);
    assert.equal(compacted.result.reason, "manual");
    assert.equal(compacted.result.budgetAfter.lastCompaction?.status, "completed");
    assert.equal(compacted.result.budgetAfter.lastCompaction?.reason, "manual");
    assert.ok(compacted.result.budgetAfter.estimatedInputTokens < before.budget.estimatedInputTokens);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
  }
});

test("model-relative pressure triggers one proactive checkpoint with hysteresis", async () => {
  const runtime = createTestRuntime({ seed: "context-budget-proactive" });
  try {
    // This small-window fixture is calibrated for the non-Workspace tool set.
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "off" });
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 32_768, maxTokens: 2_048 });
    const character = runtime.kernel.createCharacter({ name: "主动整理角色" });
    runtime.model.enqueue(Array.from({ length: 14 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `长回复 ${index + 1}。${"连续回复内容".repeat(1_200)}`,
    })));

    let compactionCount = 0;
    for (let index = 0; index < 12; index += 1) {
      const response = await runtime.kernel.sendMessage("proactive-budget-session", {
        mode: "sms",
        characterId: character.id,
        text: `长输入 ${index + 1}。${"连续输入条件".repeat(1_200)}`,
      });
      assert.equal(response.status, "completed");
      const handle = await runtime.kernel.sessionRuntime.getOrCreate(
        "proactive-budget-session",
        "sms",
        character.id,
      );
      compactionCount = handle.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
      if (compactionCount > 0) break;
    }

    assert.equal(compactionCount, 1);
    const metadata = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "proactive-budget-session"
    );
    assert.ok(["budget_planned", "budget_preflight"].includes(metadata?.lastCompactionReason ?? ""));
    assert.equal(metadata?.lastCompactionStatus, "completed");

    await runtime.kernel.sendMessage("proactive-budget-session", {
      mode: "sms",
      characterId: character.id,
      text: "整理后的一条短消息",
    });
    const handle = await runtime.kernel.sessionRuntime.getOrCreate(
      "proactive-budget-session",
      "sms",
      character.id,
    );
    assert.equal(
      handle.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
      1,
      "a small amount of post-checkpoint growth must not immediately compact again",
    );
  } finally {
    runtime.dispose();
  }
});
