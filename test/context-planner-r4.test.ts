import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  measuredContextInputTokens,
  normalizeActualProviderUsage,
} from "../src/context/provider-usage.js";
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

test("conversation fatigue follows the canonical model budget instead of raw oversized tool transcripts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-budget-lifecycle-"));
  const workspaceDir = join(stateDir, "workspace");
  const runtime = createTestRuntime({ stateDir, workspaceDir, seed: "r4-budget-lifecycle" });
  try {
    // Leave enough resident-tool headroom that the compacted view of the raw
    // result remains below projected planned pressure.
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 36_864, maxTokens: 2_048 });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    writeFileSync(
      join(workspaceDir, "oversized-result.txt"),
      `${"0123456789".repeat(16_000)}RAW_TOOL_RESULT_TAIL`,
      "utf8",
    );
    runtime.model.enqueue([
      { kind: "tool_call", name: "read", arguments: { path: "oversized-result.txt", limit: 1 } },
      {
        kind: "assistant_text",
        text: "大文件已经读取，当前模型上下文仍有充足余量。",
      },
      {
        kind: "assistant_text",
        text: "我可以继续处理。",
      },
    ]);

    await runtime.kernel.sendMessage("raw-tool-budget", { mode: "sms", text: "读取这个大文件" });
    assert.ok(
      JSON.stringify((await runtime.kernel.getSession("raw-tool-budget")).messages).length > 128_000,
      "the durable transcript must retain the raw tool result used by this regression",
    );
    await runtime.kernel.sendMessage("raw-tool-budget", { mode: "sms", text: "继续分析" });

    const metadata = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "raw-tool-budget"
    );
    const budget = await runtime.kernel.getConversationContextBudget("raw-tool-budget");
    const followUpRequest = runtime.model.requests.find((request) =>
      JSON.stringify(request.messages).includes("继续分析")
    );
    const handle = await runtime.kernel.sessionRuntime.getOrCreate("raw-tool-budget", "sms");
    assert.equal(budget.level, "healthy");
    assert.equal(
      budget.usedInputTokens,
      measuredContextInputTokens(runtime.kernel.recentContextEconomics(1)[0].actual),
    );
    assert.ok(budget.usedInputTokens < budget.plannedThresholdTokens);
    assert.equal(metadata?.sleepState ?? "awake", "awake");
    assert.doesNotMatch(JSON.stringify(followUpRequest?.messages), /conversation_lifecycle[^]*state=\\?"tired/);
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("planned pressure starts near ninety percent of a small simulated window, not at warning pressure", async () => {
  // Padding accounts for the resident reminder plus durable goal/workflow tool schemas.
  // Keep all measured warning/planned-pressure assertions below as the contract.
  const runtime = createTestRuntime({ seed: "r4-planned-pressure" });
  try {
    // Keep the fixed token padding independent of newly enabled file tools.
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "off" });
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 32_768, maxTokens: 2_048 });
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        text: `八成多的占用还不需要打断对话。${"abcd".repeat(6_556)}`,
      },
      {
        kind: "assistant_text",
        text: "我仍然可以自然地继续。",
      },
      { kind: "assistant_text", text: "继续也不需要发出困倦提示。" },
    ]);

    await runtime.kernel.sendMessage("planned-pressure", { mode: "sms", text: "第一轮" });
    await runtime.kernel.sendMessage("planned-pressure", { mode: "sms", text: "第二轮" });
    const warningBudget = await runtime.kernel.getConversationContextBudget("planned-pressure");
    assert.equal(warningBudget.level, "warning");
    assert.ok(warningBudget.usedInputTokens >= warningBudget.warningThresholdTokens);
    assert.ok(warningBudget.usedInputTokens < warningBudget.plannedThresholdTokens);
    assert.equal(warningBudget.shouldCompact, false);

    await runtime.kernel.sendMessage("planned-pressure", { mode: "sms", text: "再继续一轮" });
    const followUpRequest = runtime.model.requests.find((request) =>
      JSON.stringify(request.messages).includes("再继续一轮")
    );
    const handle = await runtime.kernel.sessionRuntime.getOrCreate("planned-pressure", "sms");
    assert.equal(
      runtime.kernel.listConversationMetadata().find((entry) => entry.id === "planned-pressure")
        ?.sleepState ?? "awake",
      "awake",
    );
    assert.doesNotMatch(JSON.stringify(followUpRequest?.messages), /conversation_lifecycle[^]*state=\\?"tired/);
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
  } finally {
    runtime.dispose();
  }
});

test("a conservative turn projection can suggest fatigue but cannot checkpoint below measured planned pressure", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-projection-recovery-"));
  const workspaceDir = join(stateDir, "workspace");
  const runtime = createTestRuntime({ stateDir, workspaceDir, seed: "r4-projection-recovery" });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 65_536, maxTokens: 2_048 });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: `投影边界上下文。${"abcd".repeat(40_056)}` },
      { kind: "tool_call", name: "write", arguments: { path: "projection.txt", content: "done" } },
      { kind: "assistant_text", text: "文件写好了，我有点困了。" },
      { kind: "assistant_text", text: "实测余量充足，我们正常继续。" },
    ]);

    await runtime.kernel.sendMessage("projection-recovery", { mode: "sms", text: "先保留背景" });
    await runtime.kernel.sendMessage("projection-recovery", { mode: "sms", text: "写入结果" });
    const measured = await runtime.kernel.getConversationContextBudget("projection-recovery");
    const projectedMetadata = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "projection-recovery"
    );
    const handle = await runtime.kernel.sessionRuntime.getOrCreate("projection-recovery", "sms");
    assert.ok(measured.usedInputTokens < measured.plannedThresholdTokens);
    assert.equal(projectedMetadata?.sleepState, "tired");
    assert.ok(projectedMetadata?.sleepSuggestedAt);
    assert.equal(projectedMetadata?.pendingCompactionAt, undefined);
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);

    await runtime.kernel.sendMessage("projection-recovery", { mode: "sms", text: "继续" });
    const healed = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "projection-recovery"
    );
    assert.equal(healed?.sleepState, "awake");
    assert.equal(healed?.sleepSuggestedAt, undefined);
    assert.equal(healed?.pendingCompactionAt, undefined);
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a tired tool turn is checkpointed at the next safe boundary without another fatigue prompt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-pending-checkpoint-"));
  const workspaceDir = join(stateDir, "workspace");
  const runtime = createTestRuntime({ stateDir, workspaceDir, seed: "r4-pending-checkpoint" });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 65_536, maxTokens: 2_048 });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        // Exercise planned pressure, with room for tool-schema growth below the
        // emergency preflight threshold (which is tested separately).
        text: `这是后续操作需要保留的上下文。${"abcd".repeat(41_456)}`,
      },
      { kind: "tool_call", name: "write", arguments: { path: "second.txt", content: "second" } },
      {
        kind: "assistant_text",
        text: "第二项也完成了，我确实有点困了，想在安全的时候休息一下。",
      },
      {
        kind: "assistant_text",
        text: "当前操作链结束了。",
      },
      { kind: "assistant_text", text: "较早对话的安全整理摘要。" },
    ]);

    await runtime.kernel.sendMessage("pending-checkpoint", { mode: "sms", text: "先梳理操作背景" });
    await runtime.kernel.sendMessage("pending-checkpoint", { mode: "sms", text: "再写第二个文件" });
    const afterSideEffect = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "pending-checkpoint"
    );
    assert.equal(afterSideEffect?.sleepState, "tired");
    assert.ok(afterSideEffect?.sleepSuggestedAt, "a fatigue line must be latched even on a tool side-effect turn");
    assert.ok(afterSideEffect?.pendingCompactionAt, "the deferred safe checkpoint must be durable");
    assert.ok(
      afterSideEffect?.pendingCompactionReason === "conversation_sleep" ||
        afterSideEffect?.pendingCompactionReason === "budget_planned",
    );
    const pendingBudget = await runtime.kernel.getConversationContextBudget("pending-checkpoint");
    assert.ok(pendingBudget.usedInputTokens >= pendingBudget.plannedThresholdTokens);
    const beforeSafeHandle = await runtime.kernel.sessionRuntime.getOrCreate("pending-checkpoint", "sms");
    assert.equal(
      beforeSafeHandle.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );

    await runtime.kernel.sendMessage("pending-checkpoint", { mode: "sms", text: "现在继续" });
    const safeBoundaryRequest = runtime.model.requests.find((request) =>
      JSON.stringify(request.messages).includes("现在继续")
    );
    const safeBoundaryPayload = JSON.stringify(safeBoundaryRequest?.messages);
    assert.doesNotMatch(safeBoundaryPayload, /naturally say once that the character is getting tired/);
    assert.ok(beforeSafeHandle.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    const afterCheckpoint = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "pending-checkpoint"
    );
    assert.equal(afterCheckpoint?.sleepSuggestedAt, undefined);
    assert.equal(afterCheckpoint?.pendingCompactionAt, undefined);
    assert.equal(afterCheckpoint?.pendingCompactionReason, undefined);
    assert.equal(
      runtime.kernel.store.actions.some((action) =>
        action.actionType === "conversation_sleep_checkpoint" && action.status === "completed"
      ) || runtime.kernel.store.actions.some((action) =>
        action.actionType === "context_compaction" && action.status === "completed"
      ),
      true,
    );
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Pi threshold compaction is cancelled inside a side-effect turn and recorded as pending", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-pi-threshold-"));
  const workspaceDir = join(stateDir, "workspace");
  const runtime = createTestRuntime({
    stateDir,
    workspaceDir,
    seed: "r4-pi-threshold",
    scriptedModelContextWindowTokens: 10_000,
    conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
  });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 32_768, maxTokens: 2_048 });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "前置交流完成。" },
      { kind: "tool_call", name: "write", arguments: { path: "threshold.txt", content: "done" } },
      { kind: "assistant_text", text: "文件已经写完，我有些困了。" },
    ]);

    await runtime.kernel.sendMessage("pi-threshold-side-effect", { mode: "sms", text: "先聊一句" });
    await runtime.kernel.sendMessage("pi-threshold-side-effect", { mode: "sms", text: "你先休息吧" });

    const handle = await runtime.kernel.sessionRuntime.getOrCreate("pi-threshold-side-effect", "sms");
    const metadata = runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "pi-threshold-side-effect"
    );
    assert.equal(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
    assert.ok(metadata?.pendingCompactionAt);
    assert.equal(metadata?.pendingCompactionReason, "conversation_sleep");
    assert.equal(metadata?.sleepState, "tired");
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("natural rest consent and the exact legacy good-night phrase both checkpoint and proactively wake", async (context) => {
  const cases = [
    {
      name: "natural long consent",
      userText: "好啦，你今天也忙了很久，就先安心休息一下吧，我们明天醒来再继续聊。",
    },
    { name: "legacy exact good-night", userText: "晚安咯" },
  ];
  for (const [index, scenario] of cases.entries()) {
    await context.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), `rp-agent-r4-rest-consent-${index}-`));
      const runtime = createTestRuntime({
        stateDir: root,
        workspaceDir: join(root, "workspace"),
        seed: `r4-rest-consent-${index}`,
        conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      });
      try {
        runtime.model.enqueue([
          { kind: "assistant_text", text: `前置交流完成。${"abcd".repeat(6_000)}` },
          { kind: "assistant_text", text: "晚安，我先安心休息，醒来后我们再继续。" },
          { kind: "assistant_text", text: "保留关系、约定和未完成事项的整理摘要。" },
        ]);
        const sessionId = `rest-consent-${index}`;
        await runtime.kernel.sendMessage(sessionId, { mode: "sms", text: "先聊一句" });
        const resting = await runtime.kernel.sendMessage(sessionId, {
          mode: "sms",
          text: scenario.userText,
        });
        const handle = await runtime.kernel.sessionRuntime.getOrCreate(sessionId, "sms");
        assert.equal(resting.status, "completed");
        assert.ok(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
        await runtime.kernel.flushConversationWakeNotifications(sessionId);
        assert.equal(
          runtime.kernel.listConversationMetadata().find((entry) => entry.id === sessionId)?.sleepState,
          "awake",
        );
        assert.equal(
          (await runtime.kernel.getSession(sessionId)).messages.filter((message) =>
            message.role === "custom" && message.customType === "rp-agent/conversation_wake"
          ).length,
          1,
        );
      } finally {
        runtime.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("a completed rest checkpoint sends exactly one separate wake message and resumes awake", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r4-proactive-wake-"));
  const wakeStarted = deferredValue<void>();
  const releaseWake = deferredValue<string>();
  let wakeComposerCalls = 0;
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    seed: "r4-proactive-wake",
    conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    conversationWakeComposer: async () => {
      wakeComposerCalls += 1;
      wakeStarted.resolve();
      return releaseWake.promise;
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "主动唤醒角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: `先把今天的事情聊完。${"abcd".repeat(6_000)}` },
      { kind: "assistant_text", text: "晚安，我先休息一下，醒来后再找你。" },
      { kind: "assistant_text", text: "下一轮保持自然交流。" },
    ]);
    const sessionId = "proactive-wake";
    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: character.id,
      text: "先聊一会儿",
    });
    const unreadBeforeRest = runtime.kernel.getConversationMetadata(sessionId)?.unreadCount ?? 0;

    const resting = await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: character.id,
      text: "晚安咯",
    });
    assert.equal(resting.reply, "晚安，我先休息一下，醒来后再找你。");
    assert.equal(resting.status, "completed");

    const flush = runtime.kernel.flushConversationWakeNotifications(sessionId);
    await wakeStarted.promise;
    releaseWake.resolve("我睡醒啦，又可以继续陪你了。");
    await flush;
    assert.equal(await runtime.kernel.flushConversationWakeNotifications(sessionId), 0);

    const transcript = await runtime.kernel.getSession(sessionId);
    const assistantTexts = transcript.messages.flatMap((message) =>
      message.role === "assistant"
        ? [message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")]
        : []
    );
    assert.deepEqual(assistantTexts.slice(-2), [
      "晚安，我先休息一下，醒来后再找你。",
      "我睡醒啦，又可以继续陪你了。",
    ]);
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
    const metadata = runtime.kernel.getConversationMetadata(sessionId);
    assert.equal(metadata?.sleepState, "awake");
    assert.equal(metadata?.pendingWakeNotificationId, undefined);
    assert.ok(metadata?.lastWakeNotificationId);
    assert.ok(metadata?.wakeNotificationDeliveredAt);
    assert.equal((metadata?.unreadCount ?? 0) - unreadBeforeRest, 2, "rest and wake are two incoming replies");
    assert.equal(wakeComposerCalls, 1);
    assert.equal(
      runtime.kernel.store.actions.filter((action) =>
        action.actionType === "conversation_wake_notification" && action.status === "completed"
      ).length,
      1,
    );

    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: character.id,
      text: "那我们继续吧",
    });
    assert.doesNotMatch(
      JSON.stringify(runtime.model.requests.at(-1)?.messages),
      /conversation_lifecycle[^]*state=\\?"waking/,
    );
  } finally {
    releaseWake.resolve("我睡醒了。");
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("planned and manual context compaction do not send a wake notification", async () => {
  let wakeComposerCalls = 0;
  const runtime = createTestRuntime({
    seed: "r4-no-wake-for-maintenance",
    conversationWakeComposer: async () => {
      wakeComposerCalls += 1;
      return "不应发送的醒来消息";
    },
  });
  try {
    // Exercise planned (not preflight) pressure with the calibrated tool set.
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "off" });
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 32_768, maxTokens: 2_048 });
    const character = runtime.kernel.createCharacter({ name: "静默整理角色" });
    runtime.model.enqueue([
      {
        kind: "assistant_text",
        text: `这轮先保留较长背景。${"abcd".repeat(12_000)}`,
      },
      {
        kind: "assistant_text",
        text: "背景已经自然接续。",
      },
      { kind: "assistant_text", text: `手动整理前的普通回复。${"abcd".repeat(6_000)}` },
    ]);
    await runtime.kernel.sendMessage("planned-no-wake", {
      mode: "sms",
      characterId: character.id,
      text: "保留背景",
    });
    await runtime.kernel.sendMessage("planned-no-wake", {
      mode: "sms",
      characterId: character.id,
      text: "继续，但不需要说困了",
    });
    await runtime.kernel.flushConversationWakeNotifications("planned-no-wake");
    assert.equal(
      runtime.kernel.getConversationMetadata("planned-no-wake")?.lastCompactionReason,
      "budget_planned",
    );

    await runtime.kernel.sendMessage("manual-no-wake", {
      mode: "sms",
      characterId: character.id,
      text: "普通交流",
    });
    await runtime.kernel.compactConversationContext("manual-no-wake");
    await runtime.kernel.flushConversationWakeNotifications("manual-no-wake");
    assert.equal(runtime.kernel.getConversationMetadata("manual-no-wake")?.lastCompactionReason, "manual");

    assert.equal(wakeComposerCalls, 0);
    assert.equal(
      runtime.kernel.store.actions.filter((action) =>
        action.actionType === "conversation_wake_notification"
      ).length,
      0,
    );
  } finally {
    runtime.dispose();
  }
});

test("a side-effect-deferred rest checkpoint wakes once at its later safe boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r4-deferred-wake-"));
  const workspaceDir = join(root, "workspace");
  let wakeComposerCalls = 0;
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir,
    seed: "r4-deferred-wake",
    conversationWakeComposer: async () => {
      wakeComposerCalls += 1;
      return "我已经休息好了，现在回来找你啦。";
    },
  });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 65_536, maxTokens: 2_048 });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    const character = runtime.kernel.createCharacter({ name: "延后唤醒角色" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: `这是操作所需的较长背景。${"abcd".repeat(39_656)}` },
      { kind: "tool_call", name: "write", arguments: { path: "deferred-wake.txt", content: "done" } },
      { kind: "assistant_text", text: "文件写完了，我确实有点困，想休息一下。" },
      { kind: "assistant_text", text: "好，等我休息好再回来。" },
    ]);
    const request = (text: string) => ({
      mode: "sms" as const,
      characterId: character.id,
      text,
    });
    await runtime.kernel.sendMessage("deferred-wake", request("先说明操作背景"));
    await runtime.kernel.sendMessage("deferred-wake", request("现在写入文件"));
    assert.ok(runtime.kernel.getConversationMetadata("deferred-wake")?.pendingCompactionAt);
    assert.equal(await runtime.kernel.flushConversationWakeNotifications("deferred-wake"), 0);
    assert.equal(wakeComposerCalls, 0);

    await runtime.kernel.sendMessage("deferred-wake", request("晚安咯"));
    await runtime.kernel.flushConversationWakeNotifications("deferred-wake");
    assert.equal(await runtime.kernel.flushConversationWakeNotifications("deferred-wake"), 0);
    assert.equal(wakeComposerCalls, 1);
    assert.equal(runtime.kernel.getConversationMetadata("deferred-wake")?.sleepState, "awake");
    assert.equal(
      runtime.kernel.store.actions.filter((action) =>
        action.actionType === "conversation_wake_notification" && action.status === "completed"
      ).length,
      1,
    );
    const transcript = await runtime.kernel.getSession("deferred-wake");
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a private-space wake notification stays inside that character's private partition", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r4-private-wake-"));
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    seed: "r4-private-wake",
    conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    conversationWakeComposer: async () => "我已经醒了，这句话只留在我们的私密对话里。",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密唤醒角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.model.enqueue([
      { kind: "assistant_text", text: `这里是私密连续性。${"abcd".repeat(6_000)}` },
      { kind: "assistant_text", text: "晚安，我会在这里休息。" },
    ]);
    const request = (text: string) => ({
      mode: "sms" as const,
      conversationSpace: "secret" as const,
      characterId: character.id,
      text,
    });
    await runtime.kernel.sendMessage(secret.id, request("先在私密空间聊一句"));
    await runtime.kernel.sendMessage(secret.id, request("晚安咯"));
    await runtime.kernel.flushConversationWakeNotifications(secret.id);

    const privateTranscript = await runtime.kernel.getSession(secret.id);
    assert.equal(
      privateTranscript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
    assert.ok(privateTranscript.messages.some((message) =>
      message.role === "assistant" && message.content.some((block) =>
        block.type === "text" && block.text.includes("只留在我们的私密对话"))
    ));
    const normalTranscript = await runtime.kernel.getSession(normal.id);
    assert.doesNotMatch(JSON.stringify(normalTranscript.messages), /只留在我们的私密对话|conversation_wake/);
    assert.deepEqual(runtime.kernel.listUnreadConversations("normal"), []);
    assert.equal(runtime.kernel.listUnreadConversations("secret", character.id)[0]?.sessionId, secret.id);
    const actions = runtime.kernel.store.actions.filter((action) =>
      action.actionType === "conversation_wake_notification" && action.status === "completed"
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.conversationSpace, "secret");
    assert.equal(actions[0]?.secretOwnerCharacterId, character.id);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("30 long turns defer compaction until rest and preserve bounded memory context after waking", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r4-long-"));
  const runtime = createTestRuntime({
    stateDir,
    seed: "r4-long",
    conversationLifecycleThresholds: { tiredTokens: 32_000, hardSleepTokens: 60_000 },
  });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 262_144, maxTokens: 4_096 });
    const core = active(runtime, {
      realm: "reality",
      type: "boundary",
      content: "长会话核心边界是禁止自动公开私人草稿",
      tags: ["长会话核心"],
      salience: 0.96,
    });
    runtime.model.enqueue(Array.from({ length: 30 }, (_, index) => ({
      kind: "assistant_text" as const,
      text: `第${index + 1}轮回复。${"稳定记录".repeat(220)}`,
    })));
    for (let index = 0; index < 30; index += 1) {
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
    await runtime.kernel.flushConversationWakeNotifications("long-context");
    assert.equal(runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === "long-context"
    )?.sleepState, "awake");
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
    await runtime.kernel.deleteAllUserData();
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

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
