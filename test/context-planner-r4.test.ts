import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeActualProviderUsage } from "../src/context/provider-usage.js";
import { createHttpServer } from "../src/http/router.js";
import { memoryCoordinatorMcpModuleId } from "../src/modules/catalog.js";
import type { MemoryCandidateInput } from "../src/memory-coordinator/types.js";
import type { RpMemory } from "../src/rp/types.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("retrieval scores exact, tag, FTS, and Chinese matches with deterministic strict realm filters", () => {
  const runtime = createTestRuntime({ seed: "r4-retrieval", now: "2026-07-16T02:00:00.000Z" });
  try {
    const alpha = runtime.kernel.createCharacter({ name: "Alpha" });
    const beta = runtime.kernel.createCharacter({ name: "Beta" });
    const home = active(runtime, {
      realm: "reality",
      type: "user_fact",
      key: "home.city",
      content: "用户来自杭州",
      tags: ["家乡", "身份"],
      salience: 0.72,
    });
    const project = active(runtime, {
      realm: "reality",
      type: "project",
      key: "project.nebula",
      content: "Project Nebula uses Rust for the storage service",
      tags: ["engineering"],
      salience: 0.72,
    });
    const alphaRp = active(runtime, {
      realm: "roleplay",
      characterId: alpha.id,
      type: "plot_event",
      content: "玻璃温室里保存着银色钥匙",
      tags: ["钥匙"],
    });
    const betaRp = active(runtime, {
      realm: "roleplay",
      characterId: beta.id,
      type: "plot_event",
      content: "玻璃温室里保存着银色钥匙",
      tags: ["钥匙"],
    });
    const agreement = active(runtime, {
      realm: "roleplay",
      characterId: alpha.id,
      type: "relationship_event",
      content: "用户与角色约定遇到问题时直说",
      tags: ["约定"],
    });
    const pending = runtime.kernel.memoryLifecycle.propose(candidate({
      realm: "reality",
      type: "preference",
      content: "用户偏好绝不能进入 active 检索的待确认内容",
      tags: ["家乡"],
    }, "pending"));
    runtime.kernel.rejectMemory(pending.id);

    const chinese = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-chinese",
      query: "杭州在哪里",
      allowBootstrap: false,
    });
    assert.deepEqual(chinese.selectedMemoryIds, [home.id]);
    assert.equal(chinese.retrieval[0].candidates.find((entry) => entry.memoryId === home.id)?.breakdown.exactContent, false);
    assert.ok((chinese.retrieval[0].candidates.find((entry) => entry.memoryId === home.id)?.breakdown.lexical ?? 0) > 0);

    const tag = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-tag",
      query: "家乡",
      allowBootstrap: false,
    });
    assert.equal(tag.retrieval[0].candidates.find((entry) => entry.memoryId === home.id)?.breakdown.exactTag, true);

    const fts = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-fts",
      query: "Nebula storage",
      allowBootstrap: false,
    });
    const ftsCandidate = fts.retrieval[0].candidates.find((entry) => entry.memoryId === project.id);
    assert.ok((ftsCandidate?.breakdown.fts ?? 0) > 0);
    assert.match(ftsCandidate?.reason ?? "", /fts_bm25/);

    const noMatch = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-no-match",
      query: "量子香蕉航线",
      allowBootstrap: false,
    });
    assert.deepEqual(noMatch.selectedMemoryIds, []);
    assert.equal(noMatch.retrieval[0].candidates.every((entry) => entry.exclusionReason === "no_relevance"), true);
    assert.equal(noMatch.turnContext.includes(home.content), false);

    const rp = runtime.kernel.previewContextPlan({
      mode: "rp",
      sessionId: "preview-rp",
      characterId: alpha.id,
      query: "银色钥匙",
      allowBootstrap: false,
    });
    const rpPlan = rp.retrieval.find((entry) => entry.realm === "roleplay");
    assert.equal(rpPlan?.candidates.some((entry) => entry.memoryId === alphaRp.id), true);
    assert.equal(rpPlan?.candidates.some((entry) => entry.memoryId === agreement.id), true);
    assert.equal(rpPlan?.candidates.some((entry) => entry.memoryId === betaRp.id), false);

    const sms = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-sms-with-character",
      characterId: alpha.id,
      query: "银色钥匙",
      allowBootstrap: false,
    });
    assert.deepEqual(sms.retrieval.map((entry) => entry.realm), ["reality", "roleplay"]);
    assert.equal(sms.selectedMemoryIds.includes(alphaRp.id), true);
    assert.equal(sms.selectedMemoryIds.includes(betaRp.id), false);

    const conversationalIntent = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-chinese-intent",
      characterId: alpha.id,
      query: "还记得我们的约定吗？",
      allowBootstrap: false,
    });
    assert.equal(conversationalIntent.selectedMemoryIds.includes(agreement.id), true);
    assert.equal(
      conversationalIntent.retrieval.find((entry) => entry.realm === "roleplay")?.normalizedQuery,
      "约定",
    );

    const tieOne = active(runtime, {
      realm: "reality",
      type: "user_fact",
      content: "并列事实甲",
      tags: ["并列"],
      salience: 0.5,
      confidence: 0.9,
    });
    const tieTwo = active(runtime, {
      realm: "reality",
      type: "user_fact",
      content: "并列事实乙",
      tags: ["并列"],
      salience: 0.5,
      confidence: 0.9,
    });
    const tie = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-tie",
      query: "并列",
      allowBootstrap: false,
    });
    assert.deepEqual(
      tie.selectedMemoryIds.filter((id) => id === tieOne.id || id === tieTwo.id),
      [tieOne.id, tieTwo.id].sort(),
    );
  } finally {
    runtime.dispose();
  }
});

test("planner enforces whole-item budgets, manual-profile dedup, and only injected memories are touched", async () => {
  const runtime = createTestRuntime({ seed: "r4-budget-touch" });
  try {
    const memories = Array.from({ length: 4 }, (_, index) => active(runtime, {
      realm: "reality",
      type: "user_fact",
      content: `预算事实${index + 1}：${"完整正文".repeat(12)}`,
      tags: ["预算命中"],
      salience: 0.6,
    }));
    const tight = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "budget-preview",
      query: "预算命中",
      allowBootstrap: false,
      budgets: { memoryTokens: 110, realityMemoryTokens: 110, realityItems: 4 },
    });
    assert.ok(tight.memoryEstimatedTokens <= 110);
    assert.ok(tight.selectedMemoryIds.length < memories.length);
    assert.ok(tight.retrieval[0].candidates.some((entry) => entry.exclusionReason?.startsWith("budget_")));
    for (const memory of memories) {
      assert.equal(tight.turnContext.includes(memory.content), tight.selectedMemoryIds.includes(memory.id));
    }
    assert.equal(runtime.kernel.contextEconomics.contextState().bootstrapSessions.length, 0);
    assert.equal(runtime.kernel.listMemories().every((entry) => entry.lastUsedAt === undefined), true);

    const dynamicTight = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "dynamic-budget-preview",
      query: "预算命中",
      allowBootstrap: false,
      budgets: { dynamicTokens: 256 },
    });
    assert.ok(dynamicTight.dynamicEstimatedTokens <= dynamicTight.budgets.dynamicTokens);
    assert.equal(dynamicTight.truncated, true);

    runtime.kernel.updateUserProfile(`# 手写画像\n\n${memories[0].content}`);
    const dedup = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "dedup-preview",
      query: "预算命中",
      allowBootstrap: false,
    });
    assert.equal(
      dedup.retrieval[0].candidates.find((entry) => entry.memoryId === memories[0].id)?.exclusionReason,
      "duplicate_profile_manual",
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "预算检索完成。" }]);
    await runtime.kernel.sendMessage("touch-session", { mode: "sms", text: "预算命中" });
    const economics = runtime.kernel.recentContextEconomics(1)[0];
    assert.equal(economics.memoryIds.length, 3);
    const after = new Map(runtime.kernel.listMemories().map((entry) => [entry.id, entry]));
    for (const memory of memories) {
      assert.equal(Boolean(after.get(memory.id)?.lastUsedAt), economics.memoryIds.includes(memory.id));
    }
    assert.deepEqual(
      runtime.kernel.memoryRetrievalStats().map((entry) => entry.memoryId).sort(),
      [...economics.memoryIds].sort(),
    );
  } finally {
    runtime.dispose();
  }
});

test("bootstrap is preview-safe, survives preparation failure, and commits only on a real provider request", async () => {
  const runtime = createTestRuntime({ seed: "r4-bootstrap" });
  try {
    const core = active(runtime, {
      realm: "reality",
      type: "boundary",
      content: "核心边界：不要在清晨安排电话",
      tags: ["core"],
      salience: 0.95,
    });
    const firstPreview = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "bootstrap-session",
      query: "普通问候",
    });
    assert.deepEqual(firstPreview.selectedMemoryIds, [core.id]);
    assert.equal(firstPreview.bootstrapApplied, true);
    assert.deepEqual(runtime.kernel.contextEconomics.contextState().bootstrapSessions, []);

    const originalPrepare = runtime.kernel.sessionRuntime.prepareForTurn.bind(runtime.kernel.sessionRuntime);
    runtime.kernel.sessionRuntime.prepareForTurn = async () => {
      throw new Error("synthetic preparation failure");
    };
    await assert.rejects(
      runtime.kernel.sendMessage("bootstrap-session", { mode: "sms", text: "第一次尝试" }),
      /synthetic preparation failure/,
    );
    runtime.kernel.sessionRuntime.prepareForTurn = originalPrepare;
    assert.equal(runtime.kernel.contextEconomics.bootstrapConsumed("bootstrap-session"), false);

    runtime.model.enqueue([{ kind: "assistant_text", text: "首次实际回复。" }]);
    await runtime.kernel.sendMessage("bootstrap-session", { mode: "sms", text: "第二次尝试" });
    assert.equal(runtime.kernel.contextEconomics.bootstrapConsumed("bootstrap-session"), true);
    assert.deepEqual(runtime.kernel.recentContextEconomics(1)[0].memoryIds, [core.id]);

    const later = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "bootstrap-session",
      query: "仍然无关",
    });
    assert.equal(later.bootstrapAlreadyConsumed, true);
    assert.deepEqual(later.selectedMemoryIds, []);
    assert.equal(
      later.retrieval[0].candidates.find((entry) => entry.memoryId === core.id)?.exclusionReason,
      "no_relevance",
    );
  } finally {
    runtime.dispose();
  }
});

test("correction, forget, external edit, and module disable remove stale memory snapshots from the next payload", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-stale-"));
  const runtime = createTestRuntime({ stateDir, seed: "r4-stale" });
  try {
    const original = active(runtime, {
      realm: "reality",
      type: "preference",
      key: "drink.preference",
      content: "用户只喝旧配方红茶",
      tags: ["饮品"],
    });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一轮完成。" },
      { kind: "assistant_text", text: "第二轮完成。" },
      { kind: "assistant_text", text: "第三轮完成。" },
      { kind: "assistant_text", text: "第四轮完成。" },
      { kind: "assistant_text", text: "第五轮完成。" },
      { kind: "assistant_text", text: "第六轮完成。" },
    ]);
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "饮品偏好是什么" });
    assert.match(JSON.stringify(runtime.model.requests[0].messages), /用户只喝旧配方红茶/);

    const corrected = runtime.kernel.correctMemory(original.id, { content: "用户只喝新配方绿茶" }).memory;
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "饮品偏好是什么" });
    const correctionPayload = JSON.stringify(runtime.model.requests[1].messages);
    assert.doesNotMatch(correctionPayload, /用户只喝旧配方红茶/);
    assert.match(correctionPayload, /用户只喝新配方绿茶/);

    runtime.kernel.forgetMemory(corrected.id);
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "饮品偏好是什么" });
    const forgottenPayload = JSON.stringify(runtime.model.requests[2].messages);
    assert.doesNotMatch(forgottenPayload, /用户只喝旧配方红茶|用户只喝新配方绿茶/);

    const external = active(runtime, {
      realm: "reality",
      type: "project",
      key: "project.external",
      content: "外部项目使用旧代号苍穹",
      tags: ["外部项目"],
    });
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "外部项目代号" });
    assert.match(JSON.stringify(runtime.model.requests[3].messages), /旧代号苍穹/);
    const path = join(stateDir, "memory-vault", "reality", "memories", `${external.id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("外部项目使用旧代号苍穹", "外部项目使用新代号星河"), {
      mode: 0o600,
    });
    const externalPreview = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "stale-session",
      query: "外部项目代号",
      allowBootstrap: false,
    });
    assert.match(externalPreview.turnContext, /新代号星河/);
    assert.doesNotMatch(externalPreview.turnContext, /旧代号苍穹/);
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "外部项目代号" });
    const externalPayload = JSON.stringify(runtime.model.requests[4].messages);
    assert.match(externalPayload, /新代号星河/);
    assert.doesNotMatch(externalPayload, /旧代号苍穹/);

    runtime.kernel.setAgentModuleEnabled(memoryCoordinatorMcpModuleId, false);
    await runtime.kernel.sendMessage("stale-session", { mode: "sms", text: "外部项目代号" });
    const disabledPayload = JSON.stringify(runtime.model.requests[5].messages);
    assert.doesNotMatch(disabledPayload, /旧代号苍穹|新代号星河/);
    assert.match(runtime.kernel.recentContextEconomics(1)[0].cacheBreakReason ?? "", /module_toggle|memory_module_disabled/);
    assert.match(runtime.kernel.recentContextEconomics(1)[0].cacheBreakReason ?? "", /tool_schema_changed/);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("economics keeps stable system hashes, exact LCP evidence, and actual usage distinct from estimates", async () => {
  assert.deepEqual(
    normalizeActualProviderUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
  );
  assert.deepEqual(
    normalizeActualProviderUsage({ input: 120, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 128 }),
    { inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );

  const runtime = createTestRuntime({ seed: "r4-economics", now: "2026-07-16T02:00:00.000Z" });
  try {
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一轮。" },
      { kind: "assistant_text", text: "第二轮。" },
    ]);
    await runtime.kernel.sendMessage("economics-session", { mode: "sms", text: "第一轮问题" });
    runtime.clock.advance(60_000);
    await runtime.kernel.sendMessage("economics-session", { mode: "sms", text: "第二轮问题" });
    const [second, first] = runtime.kernel.recentContextEconomics(2);
    assert.equal(second.systemHash, first.systemHash);
    assert.equal(second.toolSchemaHash, first.toolSchemaHash);
    assert.equal(second.lcpMessageCount, first.messageCount - 2);
    assert.match(second.cacheBreakReason ?? "", /historical_volatile_context_filtered/);
    assert.ok(second.lcpEstimatedTokens > 0);
    assert.ok(second.prefixReuseRatio > 0 && second.prefixReuseRatio <= 1);
    assert.ok(second.estimatedInputTokens >= second.lcpEstimatedTokens + second.toolEstimatedTokens);
    assert.notEqual(second.plan.generatedAt, first.plan.generatedAt);
    assert.notEqual(
      second.plan.sections.find((entry) => entry.id === "latest_time")?.estimatedTokens,
      70,
    );
    assert.ok((second.actual.inputTokens ?? 0) > 0);
    assert.ok((second.actual.outputTokens ?? 0) > 0);
    assert.equal(typeof second.actual.cacheReadTokens, "number");
    assert.equal(second.plan.query, null);
    assert.equal(JSON.stringify(second).includes("第二轮问题"), false);
  } finally {
    runtime.dispose();
  }
});

test("40 long turns defer compaction until rest and preserve bounded memory context after waking", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-long-"));
  const runtime = createTestRuntime({ stateDir, seed: "r4-long" });
  try {
    const core = active(runtime, {
      realm: "reality",
      type: "boundary",
      content: "长会话核心边界是禁止自动公开私人草稿",
      tags: ["长会话核心"],
      salience: 0.96,
    });
    runtime.model.enqueue(Array.from({ length: 40 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `第${index + 1}轮回复。${"稳定记录".repeat(220)}`,
    })));
    for (let index = 0; index < 40; index += 1) {
      await runtime.kernel.sendMessage("long-context", {
        mode: "sms",
        text: `第${index + 1}轮询问长会话核心。${"输入条件".repeat(220)}`,
      });
      runtime.clock.advance(60_000);
    }
    const handle = await runtime.kernel.sessionRuntime.getOrCreate("long-context", "sms");
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
    assert.equal(runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "long-context"
    )?.sleepState, "tired");

    runtime.model.enqueue([
      { kind: "assistant_text", text: "晚安，舰长。我也确实困了，等醒来再陪你继续。" },
      { kind: "assistant_text", text: "我醒了，舰长。刚才的约定和边界我都还记得。" },
    ]);
    const sleeping = await runtime.kernel.sendMessage("long-context", {
      mode: "sms",
      text: "晚安咯",
    });
    assert.equal(sleeping.status, "completed");
    assert.ok(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.equal(runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "long-context"
    )?.sleepState, "sleeping");
    const waking = await runtime.kernel.sendMessage("long-context", {
      mode: "sms",
      text: "醒了吗？",
    });
    assert.equal(waking.status, "completed");
    assert.equal(runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "long-context"
    )?.sleepState, "awake");

    const economics = runtime.kernel.recentContextEconomics(100)
      .filter((entry) => entry.sessionId === "long-context");
    const injections = economics.filter((entry) => entry.memoryIds.includes(core.id));
    const compactionCount = handle.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
    assert.ok(injections.length >= 1, "the selected memory must remain represented after compaction");
    assert.ok(injections.length <= compactionCount + 1, "re-injection must be bounded by compaction resets");
    const chronological = [...economics].reverse();
    const beforeFirstCompaction = chronological.slice(0, chronological.findIndex((entry) =>
      entry.cacheBreakReason?.includes("context_compacted")
    ));
    assert.equal(beforeFirstCompaction.filter((entry) => entry.memoryIds.includes(core.id)).length, 1);
    assert.ok(Math.max(...economics.map((entry) => entry.estimatedInputTokens)) < 110_000);
    assert.ok((chronological.at(-1)?.messageCount ?? 100) <= 35);
    const latestPayload = JSON.stringify(runtime.model.requests.at(-1)?.messages);
    assert.ok((latestPayload.match(/长会话核心边界是禁止自动公开私人草稿/g) ?? []).length <= 1);
    assert.ok((runtime.model.requests.at(-1)?.messages.length ?? 100) < 40);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("preview APIs are read-only and session deletion/export/delete-all cover context checkpoints", async () => {
  const runtime = createTestRuntime({ seed: "r4-api" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const memory = active(runtime, {
      realm: "reality",
      type: "goal",
      content: "用户的核心目标是完成跨会话评测",
      tags: ["core", "评测"],
      salience: 0.95,
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const params = new URLSearchParams({
      mode: "sms",
      sessionId: "api-session",
      query: "跨会话评测",
      timezone: "Asia/Shanghai",
      bootstrap: "1",
    });
    const preview = await (await fetch(`${base}/api/v1/context-plan/preview?${params}`)).json() as {
      plan: { selectedMemoryIds: string[] };
    };
    assert.deepEqual(preview.plan.selectedMemoryIds, [memory.id]);
    const retrieval = await (await fetch(`${base}/api/v1/memory-retrieval/preview?${params}`)).json() as {
      selectedMemoryIds: string[];
    };
    assert.deepEqual(retrieval.selectedMemoryIds, [memory.id]);
    assert.equal(runtime.kernel.contextEconomics.bootstrapConsumed("api-session"), false);
    assert.equal(runtime.kernel.listMemories().find((entry) => entry.id === memory.id)?.lastUsedAt, undefined);

    runtime.model.enqueue([{ kind: "assistant_text", text: "API 会话完成。" }]);
    await runtime.kernel.sendMessage("api-session", { mode: "sms", text: "跨会话评测" });
    const economics = await (await fetch(`${base}/api/debug/context-economics`)).json() as {
      economics: Array<{ sessionId: string }>;
    };
    assert.equal(economics.economics[0].sessionId, "api-session");
    const exported = await (await fetch(`${base}/api/v1/export`)).json() as {
      memoryContextState: { bootstrapSessions: unknown[]; residentMemories: unknown[] };
    };
    assert.equal(exported.memoryContextState.bootstrapSessions.length, 1);
    assert.equal(exported.memoryContextState.residentMemories.length, 1);

    await runtime.kernel.deleteConversation("api-session", "跨会话评测");
    assert.deepEqual(runtime.kernel.contextEconomics.contextState(), {
      bootstrapSessions: [],
      residentMemories: [],
    });
    assert.deepEqual(runtime.kernel.recentContextEconomics(), []);

    runtime.model.enqueue([{ kind: "assistant_text", text: "删除前会话。" }]);
    await runtime.kernel.sendMessage("delete-all-session", { mode: "sms", text: "跨会话评测" });
    runtime.kernel.deleteAllUserData();
    assert.deepEqual(runtime.kernel.contextEconomics.contextState(), {
      bootstrapSessions: [],
      residentMemories: [],
    });
    assert.deepEqual(runtime.kernel.recentContextEconomics(), []);
    assert.deepEqual(runtime.kernel.memoryRetrievalStats(), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

function active(
  runtime: ReturnType<typeof createTestRuntime>,
  input: Omit<MemoryCandidateInput, "sourceSessionId" | "sourceMessageId" | "idempotencyKey">,
): RpMemory {
  const suffix = runtime.kernel.store.idGenerator.next("r4-source");
  return runtime.kernel.createControlPlaneMemory({
    ...input,
    sourceSessionId: "r4-control-plane",
    sourceMessageId: suffix,
    idempotencyKey: `r4:${suffix}`,
  });
}

function candidate(
  input: Omit<MemoryCandidateInput, "sourceSessionId" | "sourceMessageId" | "idempotencyKey">,
  suffix: string,
): MemoryCandidateInput {
  return {
    ...input,
    sourceSessionId: "r4-control-plane",
    sourceMessageId: `r4-${suffix}`,
    idempotencyKey: `r4:${suffix}`,
  };
}
