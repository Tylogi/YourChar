import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { resolveModelPrice, type UsageSummary } from "../src/usage/index.js";
import { createTestRuntime } from "../src/testing/runtime.js";

function newKernel(clock = new VirtualClock("2026-09-17T09:00:00.000Z")) {
  return new CompanionKernel({
    stateDir: false,
    clock,
    startScheduler: false,
  });
}

function originOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())));
}

test("model prices resolve from the catalog and unknown models stay unpriced", () => {
  assert.deepEqual(resolveModelPrice("deepseek-chat"), {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2,
  });
  assert.deepEqual(resolveModelPrice("deepseek-chat-2026"), resolveModelPrice("deepseek-chat"));
  assert.deepEqual(resolveModelPrice("gpt-4o-2024-08-06"), resolveModelPrice("gpt-4o"));
  assert.equal(resolveModelPrice("totally-unknown-model"), null);
  assert.equal(resolveModelPrice(""), null);
  assert.deepEqual(
    resolveModelPrice("totally-unknown-model", {
      "totally-unknown-model": { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    }),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  );
});

test("recorded model calls aggregate into the monthly usage summary", () => {
  const service = newKernel().usageService;
  service.recordModelCall({
    provider: "openai_compatible",
    model: "deepseek-chat",
    usage: {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 2_000_000,
      cacheWrite: 0,
      totalTokens: 3_500_000,
    },
  });
  service.recordModelCall({
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });

  const summary = service.summary(undefined, {
    provider: "openai_compatible",
    model: "deepseek-chat",
  });
  assert.equal(summary.month, "2026-09");
  assert.equal(summary.calls, 2);
  assert.deepEqual(summary.bucket, {
    input: 2_000_000,
    output: 500_000,
    cacheRead: 2_000_000,
    cacheWrite: 0,
  });
  // 2e6/1e6*2 + 0.5e6/1e6*8 + 2e6/1e6*0.5 = 4 + 4 + 1
  assert.equal(summary.costYuan, 9);
  assert.equal(summary.unpricedCalls, 0);
  assert.deepEqual(
    summary.models.map((row) => [row.provider, row.calls, row.costYuan]).sort(),
    [["", 1, 2], ["openai_compatible", 1, 7]],
  );
  assert.deepEqual(summary.current.price, resolveModelPrice("deepseek-chat"));
});

test("model calls without provider usage are not written to the ledger", () => {
  const service = newKernel().usageService;
  service.recordModelCall({ model: "deepseek-chat" });
  service.recordModelCall({
    model: "deepseek-chat",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });
  const summary = service.summary(undefined, { provider: "", model: "deepseek-chat" });
  assert.equal(summary.calls, 0);
  assert.equal(summary.costYuan, 0);
  assert.deepEqual(summary.models, []);
});

test("an unknown model is counted but never priced", () => {
  const service = newKernel().usageService;
  service.recordModelCall({
    provider: "openai_compatible",
    model: "some-brand-new-model",
    usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, totalTokens: 11_000 },
  });
  const summary = service.summary(undefined, { provider: "", model: "some-brand-new-model" });
  assert.equal(summary.calls, 1);
  assert.equal(summary.unpricedCalls, 1);
  assert.equal(summary.costYuan, 0);
  assert.equal(summary.models[0].price, null);
});

test("usage is bucketed by calendar month in the local timezone", () => {
  const clock = new VirtualClock("2026-09-30T15:59:00.000Z");
  const service = newKernel(clock).usageService;
  service.recordModelCall({
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  clock.set("2026-09-30T16:01:00.000Z");
  service.recordModelCall({
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  assert.equal(service.summary("2026-09", { provider: "", model: "" }).calls, 1);
  assert.equal(service.summary("2026-10", { provider: "", model: "" }).calls, 1);
});

test("the monthly budget flags spending over the cap", () => {
  const service = newKernel().usageService;
  service.recordModelCall({
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  service.saveSettings({ monthlyBudgetYuan: 1 });
  const atLimit = service.summary(undefined, { provider: "", model: "deepseek-chat" });
  assert.equal(atLimit.budget.exceeded, true);
  assert.equal(atLimit.budget.remainingYuan, -1);

  service.saveSettings({ monthlyBudgetYuan: 100 });
  const under = service.summary(undefined, { provider: "", model: "deepseek-chat" });
  assert.equal(under.budget.exceeded, false);
  assert.equal(under.budget.remainingYuan, 98);
  assert.equal(under.budget.ratio, 0.02);

  service.saveSettings({ monthlyBudgetYuan: null });
  const unlimited = service.summary(undefined, { provider: "", model: "deepseek-chat" });
  assert.equal(unlimited.budget.limitYuan, null);
  assert.equal(unlimited.budget.exceeded, false);
});

test("usage HTTP endpoints report the month and persist settings", async () => {
  const kernel = newKernel();
  kernel.usageService.recordModelCall({
    provider: "openai_compatible",
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  const server = createHttpServer({ kernel });
  await listen(server);
  try {
    const origin = originOf(server);
    const summary = await (await fetch(`${origin}/api/v1/usage`)).json() as UsageSummary;
    assert.equal(summary.month, "2026-09");
    assert.equal(summary.calls, 1);
    assert.equal(summary.costYuan, 2);
    assert.equal(summary.budget.exceeded, false);
    assert.equal(summary.models[0].provider, "openai_compatible");

    const saved = await (await fetch(`${origin}/api/v1/usage/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monthlyBudgetYuan: 1 }),
    })).json() as { monthlyBudgetYuan: number | null };
    assert.equal(saved.monthlyBudgetYuan, 1);

    const over = await (await fetch(`${origin}/api/v1/usage?month=2026-09`)).json() as UsageSummary;
    assert.equal(over.budget.limitYuan, 1);
    assert.equal(over.budget.exceeded, true);

    const empty = await (await fetch(`${origin}/api/v1/usage?month=2026-08`)).json() as UsageSummary;
    assert.equal(empty.calls, 0);
  } finally {
    await close(server);
  }
});

test("the same model under different providers is not merged into one row", () => {
  const service = newKernel().usageService;
  service.recordModelCall({
    provider: "openai_compatible",
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  service.recordModelCall({
    provider: "second_provider",
    model: "deepseek-chat",
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  const summary = service.summary(undefined, { provider: "", model: "" });
  assert.equal(summary.calls, 2);
  assert.deepEqual(
    summary.models.map((row) => [row.provider, row.model, row.calls]).sort(),
    [["openai_compatible", "deepseek-chat", 1], ["second_provider", "deepseek-chat", 1]],
  );
});

test("a streaming reply records the configured provider and model", async () => {
  const runtime = createTestRuntime();
  try {
    const character = runtime.kernel.createCharacter({
      name: "账本角色",
      soulMarkdown: "# SOUL.md\n\n你是账本角色本人。",
    });
    runtime.model.enqueue([{ kind: "assistant_text", text: "在的。" }]);
    await runtime.kernel.sendMessage("usage-stream", {
      mode: "sms",
      characterId: character.id,
      text: "你好",
    });
    const summary = runtime.kernel.usageService.summary(undefined, { provider: "", model: "" });
    assert.equal(summary.calls, 1);
    const row = summary.models[0];
    assert.ok(row);
    const configured = runtime.kernel.store.getModelApiConfig();
    assert.equal(row.provider, configured.provider);
    assert.equal(row.model, configured.model);
    assert.ok(row.input > 0);
    assert.ok(row.output > 0);
  } finally {
    runtime.dispose();
  }
});

test("a failing usage observer never breaks the model call", async () => {
  const runtime = createTestRuntime();
  try {
    const character = runtime.kernel.createCharacter({
      name: "容错角色",
      soulMarkdown: "# SOUL.md\n\n你是容错角色本人。",
    });
    runtime.kernel.usageService.recordModelCall = () => {
      throw new Error("usage ledger is down");
    };
    runtime.model.enqueue([{ kind: "assistant_text", text: "照常回复。" }]);
    const response = await runtime.kernel.sendMessage("usage-observer-failure", {
      mode: "sms",
      characterId: character.id,
      text: "你好",
    });
    assert.equal(response.reply, "照常回复。");
  } finally {
    runtime.dispose();
  }
});

test("invalid prices and budgets never reach storage", () => {
  const kernel = newKernel();
  const service = kernel.usageService;
  service.saveSettings({ monthlyBudgetYuan: -5 });
  assert.equal(service.settings().monthlyBudgetYuan, null);
  service.saveSettings({
    priceOverrides: { "deepseek-chat": { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(service.settings().priceOverrides["deepseek-chat"], undefined);
  const stored = kernel.database.connection.prepare(
    "SELECT monthly_budget_yuan AS budget, price_overrides_json AS overrides FROM usage_settings WHERE id = 'default'",
  ).get() as { budget: number | null; overrides: string };
  assert.equal(stored.budget, null);
  assert.equal(stored.overrides.includes("deepseek-chat"), false);
  assert.deepEqual(resolveModelPrice("deepseek-chat"), {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2,
  });
  service.saveSettings({
    priceOverrides: { "my-local-model": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.deepEqual(service.settings().priceOverrides["my-local-model"], {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
});
