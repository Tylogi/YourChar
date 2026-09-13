import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentSettingsService } from "../src/modules/subagent-settings.js";
import {
  maximumSubagentRuntimeTimeoutMs,
  subagentMcpRequestTimeoutMs,
} from "../src/mcp/subagent-server.js";
import {
  defaultSubagentMaxResultCharacters,
  defaultSubagentMaxOutputTokens,
  defaultSubagentTimeoutMs,
  maxConcurrentSubagentsPerSession,
  maxSubagentTotalModelCalls,
  maxSubagentWorkModelCalls,
  subagentHttpIdleTimeoutMs,
} from "../src/pi/session-runtime.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/index.js";

test("subagent deadlines are finite and the MCP envelope stays 30 seconds wider", () => {
  assert.equal(defaultSubagentTimeoutMs, 1_800_000);
  assert.equal(defaultSubagentMaxOutputTokens, 16_384);
  assert.equal(defaultSubagentMaxResultCharacters, 64_000);
  assert.equal(maxSubagentWorkModelCalls, 32);
  assert.equal(maxSubagentTotalModelCalls, 33);
  assert.equal(maxConcurrentSubagentsPerSession, 4);
  assert.equal(subagentHttpIdleTimeoutMs, 0);
  assert.equal(subagentMcpRequestTimeoutMs(defaultSubagentTimeoutMs), 1_830_000);
  assert.equal(subagentMcpRequestTimeoutMs(3_600_000), 3_630_000);
  assert.equal(
    subagentMcpRequestTimeoutMs(maximumSubagentRuntimeTimeoutMs),
    2_147_483_647,
  );
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => subagentMcpRequestTimeoutMs(invalid),
      /positive finite number/u,
    );
    assert.throws(
      () => createTestRuntime({ seed: `subagent-invalid-${String(invalid)}`, subagentTimeoutMs: invalid }),
      /subagentTimeoutMs must be a positive finite number/u,
    );
  }
  assert.throws(
    () => subagentMcpRequestTimeoutMs(maximumSubagentRuntimeTimeoutMs + 1),
    /must not exceed/u,
  );
});

test("private Pi session delegates to an isolated read-only subagent and resumes with its result", async () => {
  const runtime = createTestRuntime({ seed: "subagent-private" });
  try {
    const character = runtime.kernel.createCharacter({
      name: "林澈",
      soulMarkdown: "# SOUL.md - 林澈\n\n私聊角色秘密：只在父会话中出现。",
    });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "subagent-note.txt",
      bytes: Buffer.from("workspace evidence: pine-17\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.kernel.patchModelApiConfig({ reasoningEffort: "xhigh" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: {
          role: "reviewer",
          task: "Read uploads/subagent-note.txt and report its evidence value.",
          context: "Check the exact value; do not guess.",
        },
      },
      { kind: "tool_call", name: "read", arguments: { path: "uploads/subagent-note.txt" } },
      { kind: "assistant_text", text: "Independent review: the evidence value is pine-17." },
      { kind: "assistant_text", text: "我让独立审查员核对过了，记录值是 pine-17。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-private-session", {
      mode: "sms",
      characterId: character.id,
      text: "请找一个独立审查员核对 workspace 记录。",
    });

    assert.equal(response.status, "completed");
    assert.match(response.reply, /pine-17/);
    assert.equal(runtime.model.requests.length, 4);
    const parentInitial = runtime.model.requests[0];
    const childInitial = runtime.model.requests[1];
    const childAfterRead = runtime.model.requests[2];
    const parentFinal = runtime.model.requests[3];
    assert.ok(parentInitial.toolNames.includes("delegate_task"));
    const parentToolDefinitions = parentInitial.providerPayload.tools as Array<{
      name?: string;
      constrainedSampling?: unknown;
    }>;
    assert.deepEqual(
      parentToolDefinitions.find((tool) => tool.name === "delegate_task")?.constrainedSampling,
      { type: "json_schema", strict: "prefer" },
    );
    assert.match(parentInitial.systemPrompt, /私聊角色秘密/);
    assert.match(childInitial.systemPrompt, /isolated reviewer subagent/);
    assert.doesNotMatch(childInitial.systemPrompt, /私聊角色秘密/);
    assert.equal(childInitial.providerTimeoutMs, 2_147_483_647);
    assert.notEqual(childInitial.providerTimeoutMs, 300_000);
    assert.deepEqual(
      childInitial.toolNames.sort(),
      ["list_workspace", "read", "read_document"],
    );
    for (const forbidden of [
      "delegate_task",
      "write",
      "edit",
      "bash",
      "create_schedule_item",
      "propose_memory",
      "update_user_profile",
      "update_current_character_soul",
      "update_scene",
    ]) {
      assert.equal(childInitial.toolNames.includes(forbidden), false, `child exposed ${forbidden}`);
    }
    assert.match(JSON.stringify(childAfterRead.messages), /workspace evidence: pine-17/);
    assert.match(JSON.stringify(parentFinal.messages), /Independent review: the evidence value is pine-17/);
    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.ok(delegation);
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.payload.role, "reviewer");
    assert.equal(delegation.payload.modelCalls, 2);
    assert.equal(delegation.payload.toolCalls, 1);
    assert.equal("task" in delegation.payload, false);
    const toolJournal = runtime.kernel.database.connection.prepare(`
      SELECT attempt, model_call, tool_call_id, tool_name, replay_policy, status,
        arguments_sha256, arguments_bytes, result_json, result_sha256,
        result_bytes, is_error, result_reason
      FROM subagent_job_tool_calls WHERE job_id = ? AND generation = 1
    `).get(String(delegation.payload.jobId)) as Record<string, unknown>;
    assert.equal(toolJournal.attempt, 1);
    assert.equal(toolJournal.model_call, 1);
    assert.equal(toolJournal.tool_name, "read");
    assert.equal(toolJournal.replay_policy, "automatic");
    assert.equal(toolJournal.status, "committed");
    assert.match(String(toolJournal.arguments_sha256), /^[a-f0-9]{64}$/u);
    assert.equal(Number(toolJournal.arguments_bytes) > 1, true);
    assert.match(String(toolJournal.result_json), /workspace evidence: pine-17/u);
    assert.match(String(toolJournal.result_sha256), /^[a-f0-9]{64}$/u);
    assert.equal(Number(toolJournal.result_bytes) > 1, true);
    assert.equal(toolJournal.is_error, 0);
    assert.equal(toolJournal.result_reason, null);
    const traces = runtime.kernel.recentModelContextTraces(10);
    assert.ok(traces.some((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-private-session:")),
    JSON.stringify(traces.map((trace) => [trace.turnKind, trace.sessionId])));
    const subagentTrace = traces.find((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-private-session:")
    );
    assert.equal(subagentTrace?.payload.reasoning_effort, "xhigh");
    assert.equal(subagentTrace?.payload.max_tokens, defaultSubagentMaxOutputTokens);
  } finally {
    runtime.dispose();
  }
});

test("a short hard deadline times out a subagent without activity-based extension", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-hard-timeout",
    // Leave enough admission time under the full parallel suite for the
    // delayed response to be claimed by the child before its fixed deadline.
    subagentTimeoutMs: 1_000,
  });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Perform a deliberately slow review." },
      },
      { kind: "assistant_text", text: "This result arrived too late.", delayMs: 1_100 },
      { kind: "assistant_text", text: "委派超过了固定时限。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-hard-timeout", {
      mode: "sms",
      text: "委派一个会超过测试时限的任务。",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.reply, "委派超过了固定时限。");
    const session = await runtime.kernel.getSession("subagent-hard-timeout");
    assert.match(JSON.stringify(session.messages), /Subagent failed \(timeout;/u);
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "failed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "completed").length, 0);
    assert.equal(delegations[0].payload.failureKind, "timeout");
    assert.equal(delegations[0].payload.retryable, true);
    const [job] = runtime.kernel.listSubagentJobs("subagent-hard-timeout");
    assert.equal(job.status, "failed");
    assert.equal(job.failure?.failureKind, "timeout");
    assert.equal(job.id, delegations[0].payload.jobId);
    const childRequest = runtime.model.requests.find((request) =>
      request.systemPrompt.includes("isolated reviewer subagent")
    );
    assert.equal(childRequest?.providerTimeoutMs, 2_147_483_647);
  } finally {
    runtime.dispose();
  }
});

test("a longer hard deadline allows multiple child model rounds and a final result", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-longer-timeout",
    subagentTimeoutMs: 300,
  });
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "deadline-note.txt",
      bytes: Buffer.from("deadline evidence: amber-42\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Read the note and return its evidence." },
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/deadline-note.txt" },
        delayMs: 60,
      },
      { kind: "assistant_text", text: "The evidence is amber-42.", delayMs: 80 },
      { kind: "assistant_text", text: "子任务核对结果是 amber-42。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-longer-timeout", {
      mode: "sms",
      text: "委派核对这条记录。",
    });

    assert.equal(response.status, "completed");
    assert.match(response.reply, /amber-42/u);
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "completed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "failed").length, 0);
    const delegation = delegations.find((action) => action.status === "completed");
    assert.ok(delegation);
    assert.equal(delegation.payload.modelCalls, 2);
    assert.equal(delegation.payload.toolCalls, 1);
  } finally {
    runtime.dispose();
  }
});

test("a delegated result above the old 32k parent-context limit reaches the parent intact", async () => {
  const runtime = createTestRuntime({ seed: "subagent-large-result" });
  const tailMarker = "SUBAGENT_LARGE_RESULT_TAIL_9f3a";
  const childOutput = `Review report\n${"0123456789".repeat(3_500)}\n${tailMarker}`;
  assert.ok(childOutput.length > 32_000 && childOutput.length < defaultSubagentMaxResultCharacters);
  try {
    const configured = runtime.kernel.patchSubagentSettings({
      maxOutputTokens: 65_536,
      maxResultCharacters: 100_000,
    }, runtime.kernel.getSubagentSettings().revision);
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Return the complete synthetic review report." },
      },
      { kind: "assistant_text", text: childOutput },
      { kind: "assistant_text", text: "长审查报告已完整接收。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-large-result", {
      mode: "sms",
      text: "委派一次长报告测试。",
    });

    assert.equal(response.status, "completed");
    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.ok(delegation);
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.payload.truncated, false);
    assert.equal(delegation.payload.maxResultCharacters, configured.maxResultCharacters);

    const childTrace = runtime.kernel.recentModelContextTraces(20).find((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-large-result:")
    );
    assert.equal(childTrace?.payload.max_tokens, 65_536);

    const parentFinalTrace = runtime.kernel.recentModelContextTraces(20).find((trace) =>
      trace.sessionId === "subagent-large-result" && trace.turnKind === "user" &&
      JSON.stringify(trace.payload).includes(tailMarker)
    );
    assert.ok(parentFinalTrace, "the parent provider request must contain the end of the delegated result");
    const parentToolTexts = providerToolMessageTexts(parentFinalTrace.payload);
    assert.equal(parentToolTexts.length, 1);
    assert.ok(parentToolTexts[0].length > 32_000);
    assert.match(parentToolTexts[0], new RegExp(tailMarker, "u"));
    assert.doesNotMatch(parentToolTexts[0], /Subagent output truncated|Tool result compacted/u);

    const storedSession = await runtime.kernel.getSession("subagent-large-result");
    const stored = JSON.stringify(storedSession.messages);
    assert.match(stored, new RegExp(tailMarker, "u"));
    assert.doesNotMatch(stored, /Subagent output truncated|Tool result compacted/u);
  } finally {
    runtime.dispose();
  }
});

test("parallel delegated results share one configured parent-context pool", async () => {
  const runtime = createTestRuntime({ seed: "subagent-large-parallel-results" });
  const tails = Array.from({ length: maxConcurrentSubagentsPerSession }, (_, index) =>
    `PARALLEL_SUBAGENT_TAIL_${index + 1}_7bc2`
  );
  const childOutputs = tails.map((tail, index) =>
    `Parallel report ${index + 1}\n${String(index + 1).repeat(34_000)}\n${tail}`
  );
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_calls",
        calls: childOutputs.map((_, index) => ({
          name: "delegate_task",
          arguments: { role: "reviewer", task: `Return synthetic parallel report ${index + 1}.` },
        })),
      },
      ...childOutputs.map((text) => ({ kind: "assistant_text" as const, text })),
      { kind: "assistant_text", text: "四份并行报告已汇总。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-large-parallel-results", {
      mode: "sms",
      text: "并行委派四份长报告。",
    });

    assert.equal(response.status, "completed");
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.length, maxConcurrentSubagentsPerSession);
    assert.ok(delegations.every((action) =>
      action.status === "completed" && action.payload.truncated === false
    ));

    const parentFinalTrace = runtime.kernel.recentModelContextTraces(20).find((trace) =>
      trace.sessionId === "subagent-large-parallel-results" && trace.turnKind === "user" &&
      tails.every((tail) => JSON.stringify(trace.payload).includes(tail))
    );
    assert.ok(parentFinalTrace);
    const parentToolTexts = providerToolMessageTexts(parentFinalTrace.payload);
    assert.equal(parentToolTexts.length, maxConcurrentSubagentsPerSession);
    const totalCharacters = parentToolTexts.reduce((total, text) => total + text.length, 0);
    assert.ok(totalCharacters <= defaultSubagentMaxResultCharacters + 2_048);
    assert.ok(parentToolTexts.every((text) => /Tool result compacted/u.test(text)));
    for (const tail of tails) {
      assert.ok(parentToolTexts.some((text) => text.includes(tail)), `missing ${tail}`);
    }

    const storedSession = await runtime.kernel.getSession("subagent-large-parallel-results");
    const stored = JSON.stringify(storedSession.messages);
    for (const tail of tails) assert.match(stored, new RegExp(tail, "u"));
    assert.doesNotMatch(stored, /Tool result compacted/u);
  } finally {
    runtime.dispose();
  }
});

test("a running delegated task keeps its admission-time settings snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-subagent-runtime-snapshot-"));
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    seed: "subagent-settings-snapshot",
  });
  let concurrentDatabase: AppDatabase | undefined;
  try {
    const initial = runtime.kernel.patchSubagentSettings({
      maxWorkModelCalls: 4,
      maxOutputTokens: 20_000,
      timeoutSeconds: 60,
    }, runtime.kernel.getSubagentSettings().revision);
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "snapshot-note.txt",
      bytes: Buffer.from("snapshot evidence\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Read the note twice, then return the evidence." },
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/snapshot-note.txt" },
        delayMs: 100,
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/snapshot-note.txt" },
      },
      { kind: "assistant_text", text: "Snapshot evidence was read twice." },
      { kind: "assistant_text", text: "运行中的子任务沿用了启动时预算。" },
    ]);

    const pending = runtime.kernel.sendMessage("subagent-settings-snapshot", {
      mode: "sms",
      text: "委派快照测试。",
    });
    await waitFor(() => runtime.model.requests.some((request) =>
      /isolated reviewer subagent/u.test(request.systemPrompt)
    ));
    // Deliberately bypass the public idle-only Kernel mutation to simulate a
    // concurrent low-level settings writer after task admission.
    concurrentDatabase = new AppDatabase(join(root, "rp-agent.sqlite"));
    new SubagentSettingsService(concurrentDatabase, runtime.clock).patch({
      maxWorkModelCalls: 1,
      maxOutputTokens: 512,
      timeoutSeconds: 3_600,
    }, initial.revision);

    const response = await pending;
    assert.equal(response.status, "completed");
    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.ok(delegation);
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.payload.modelCalls, 3);
    assert.equal(delegation.payload.toolCalls, 2);
    const childTraces = runtime.kernel.recentModelContextTraces(20).filter((trace) =>
      trace.turnKind === "subagent" && trace.sessionId.startsWith("subagent:subagent-settings-snapshot:")
    );
    assert.equal(childTraces.length, 3);
    assert.ok(childTraces.every((trace) => trace.payload.max_tokens === 20_000));
    assert.equal(runtime.kernel.getSubagentSettings().maxWorkModelCalls, 1);
    assert.equal(runtime.kernel.getSubagentSettings().maxOutputTokens, 512);
  } finally {
    concurrentDatabase?.close();
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("thirty-two work rounds receive one tool-free forced-finalization round", async () => {
  const runtime = createTestRuntime({ seed: "subagent-forced-finalization" });
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "budget-note.txt",
      bytes: Buffer.from("bounded evidence\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: {
          role: "reviewer",
          task: "Inspect the note thoroughly, then return a bounded final report.",
        },
      },
      ...Array.from({ length: maxSubagentWorkModelCalls }, () => ({
        kind: "tool_call" as const,
        name: "read",
        arguments: { path: "uploads/budget-note.txt" },
      })),
      { kind: "assistant_text", text: "Forced final report: bounded evidence was verified." },
      { kind: "assistant_text", text: "子任务在收尾回合完成，并确认了 bounded evidence。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-forced-finalization", {
      mode: "sms",
      text: "请委派审查这条记录。",
    });

    assert.equal(response.status, "completed");
    assert.match(response.reply, /bounded evidence/u);
    const childRequests = runtime.model.requests.filter((request) =>
      /isolated reviewer subagent/u.test(request.systemPrompt)
    );
    assert.equal(childRequests.length, maxSubagentTotalModelCalls);
    const forcedFinalTrace = runtime.kernel.recentModelContextTraces(20).find((trace) =>
      trace.turnKind === "subagent" && trace.payload.tool_choice === "none"
    );
    assert.ok(forcedFinalTrace);
    assert.deepEqual(forcedFinalTrace.payload.tools, []);
    assert.equal(forcedFinalTrace.payload.parallel_tool_calls, false);
    assert.match(
      JSON.stringify(forcedFinalTrace.payload.messages),
      /Finalization-only request: do not call tools\./u,
    );
    assert.equal(forcedFinalTrace.payload.max_tokens, 16_384);
    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.ok(delegation);
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.payload.modelCalls, maxSubagentTotalModelCalls);
    assert.equal(delegation.payload.toolCalls, maxSubagentWorkModelCalls);
    assert.equal(delegation.payload.forcedFinalization, true);
  } finally {
    runtime.dispose();
  }
});

test("a tool call attempted during forced finalization is rejected without another model request", async () => {
  const runtime = createTestRuntime({ seed: "subagent-forced-final-tool-rejection" });
  const sensitiveTask = "private-task-body-must-not-enter-audit";
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "forced-final-note.txt",
      bytes: Buffer.from("one line\n", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: sensitiveTask },
      },
      ...Array.from({ length: maxSubagentWorkModelCalls }, () => ({
        kind: "tool_call" as const,
        name: "read",
        arguments: { path: "uploads/forced-final-note.txt" },
      })),
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/forced-final-note.txt" },
      },
      { kind: "assistant_text", text: "子任务按预算边界安全停止。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-forced-final-tool-rejection", {
      mode: "sms",
      text: "委派一个边界检查。",
    });

    assert.equal(response.status, "completed");
    assert.equal(response.reply, "子任务按预算边界安全停止。");
    const childRequests = runtime.model.requests.filter((request) =>
      /isolated reviewer subagent/u.test(request.systemPrompt)
    );
    assert.equal(childRequests.length, maxSubagentTotalModelCalls);
    const forcedFinalTrace = runtime.kernel.recentModelContextTraces(20).find((trace) =>
      trace.turnKind === "subagent" && trace.payload.tool_choice === "none"
    );
    assert.ok(forcedFinalTrace);
    assert.deepEqual(forcedFinalTrace.payload.tools, []);
    const failed = response.actions.find((action) =>
      action.actionType === "delegate_subagent" && action.status === "failed"
    );
    assert.ok(failed);
    assert.equal(failed.payload.failureKind, "finalization_failed");
    assert.equal(failed.payload.modelCalls, maxSubagentTotalModelCalls);
    assert.equal(failed.payload.toolCalls, maxSubagentWorkModelCalls);
    assert.equal(failed.payload.forcedFinalization, true);
    assert.equal(typeof failed.payload.inputTokens, "number");
    assert.equal(typeof failed.payload.outputTokens, "number");
    assert.equal(typeof failed.payload.durationMs, "number");
    assert.equal(typeof failed.payload.retryable, "boolean");
    assert.doesNotMatch(JSON.stringify(failed.payload), new RegExp(sensitiveTask, "u"));
  } finally {
    runtime.dispose();
  }
});

test("five parallel delegations admit four and return a retryable capacity error for the fifth", async () => {
  const runtime = createTestRuntime({ seed: "subagent-concurrency-capacity" });
  const sensitiveTask = "capacity-task-body-must-not-enter-audit";
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_calls",
        calls: Array.from({ length: maxConcurrentSubagentsPerSession + 1 }, (_, index) => ({
          name: "delegate_task",
          arguments: {
            role: "reviewer",
            task: `${sensitiveTask}-${index + 1}`,
          },
        })),
      },
      ...Array.from({ length: maxConcurrentSubagentsPerSession }, (_, index) => ({
        kind: "assistant_text" as const,
        text: `Parallel review ${index + 1} completed.`,
        delayMs: 80,
      })),
      { kind: "assistant_text", text: "四项已完成；第五项容量已满，可稍后重试。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-concurrency-capacity", {
      mode: "sms",
      text: "并行委派五项独立审查。",
    });

    assert.equal(response.status, "completed");
    const delegations = response.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "completed").length, 4);
    assert.equal(delegations.filter((action) => action.status === "failed").length, 1);
    const failed = delegations.find((action) => action.status === "failed");
    assert.ok(failed);
    assert.equal(failed.payload.failureKind, "capacity");
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.modelCalls, 0);
    assert.equal(failed.payload.toolCalls, 0);
    assert.equal(failed.payload.inputTokens, 0);
    assert.equal(failed.payload.outputTokens, 0);
    assert.equal(typeof failed.payload.durationMs, "number");
    assert.doesNotMatch(JSON.stringify(failed.payload), new RegExp(sensitiveTask, "u"));
    const parentAfterDelegation = runtime.model.requests.at(-1);
    assert.ok(parentAfterDelegation);
    assert.match(
      JSON.stringify(parentAfterDelegation.messages),
      /Subagent failed \(capacity;[\s\S]*configured per-session Subagent concurrency limit is full[\s\S]*Retry after/u,
    );
  } finally {
    runtime.dispose();
  }
});

test("subagent file reads report the next offset and an explicit end-of-file boundary", async () => {
  const runtime = createTestRuntime({ seed: "subagent-read-boundaries" });
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "paged-note.txt",
      bytes: Buffer.from("alpha\nbeta\ngamma", "utf8"),
    });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Read the three-line note in two non-overlapping pages." },
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/paged-note.txt", offset: 1, limit: 2 },
      },
      {
        kind: "tool_call",
        name: "read",
        arguments: { path: "uploads/paged-note.txt", offset: 3, limit: 2 },
      },
      { kind: "assistant_text", text: "Read alpha, beta, and gamma exactly once." },
      { kind: "assistant_text", text: "分页边界清楚，三行均已读取。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-read-boundaries", {
      mode: "sms",
      text: "委派读取分页文件。",
    });

    assert.equal(response.status, "completed");
    const childRequests = runtime.model.requests.filter((request) =>
      /isolated reviewer subagent/u.test(request.systemPrompt)
    );
    assert.equal(childRequests.length, 3);
    const afterFirstRead = JSON.stringify(childRequests[1].messages);
    assert.match(afterFirstRead, /Lines: 1-2 of 3/u);
    assert.match(afterFirstRead, /Next offset: 3/u);
    assert.doesNotMatch(afterFirstRead, /End of file/u);
    const afterSecondRead = JSON.stringify(childRequests[2].messages);
    assert.match(afterSecondRead, /Lines: 3-3 of 3/u);
    assert.match(afterSecondRead, /End of file/u);
  } finally {
    runtime.dispose();
  }
});

test("external cancellation takes precedence over the subagent hard deadline", async () => {
  const runtime = createTestRuntime({
    seed: "subagent-cancel-priority",
    subagentTimeoutMs: 60,
  });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "worker", task: "Wait for external cancellation." },
      },
      { kind: "assistant_text", text: "This must never become a result.", delayMs: 180 },
    ]);
    const controller = new AbortController();
    const pending = runtime.kernel.streamMessage(
      "subagent-cancel-priority",
      { mode: "sms", text: "开始后等待我取消。" },
      () => undefined,
      controller.signal,
    );
    await waitFor(() => runtime.model.requests.length >= 2);
    controller.abort();

    const response = await pending;
    assert.equal(response.status, "cancelled");
    assert.equal(response.reply, "本轮生成已取消。");
    await waitFor(() => runtime.kernel.store.actions.some((action) =>
      action.actionType === "delegate_subagent"));
    const session = await runtime.kernel.getSession("subagent-cancel-priority");
    assert.doesNotMatch(JSON.stringify(session.messages), /Subagent timed out/u);
    const delegations = runtime.kernel.store.actions.filter((action) =>
      action.actionType === "delegate_subagent");
    assert.equal(delegations.filter((action) => action.status === "failed").length, 1);
    assert.equal(delegations.filter((action) => action.status === "completed").length, 0);
    const [job] = runtime.kernel.listSubagentJobs("subagent-cancel-priority");
    assert.equal(job.status, "cancelled");
    assert.equal(job.failure?.failureKind, "cancelled");
    assert.equal(job.id, delegations[0].payload.jobId);
  } finally {
    runtime.dispose();
  }
});

test("MLX reasoning none disables thinking for delegated subagents without a top-level effort", async () => {
  const runtime = createTestRuntime({ seed: "subagent-mlx-none" });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.kernel.patchModelApiConfig({
      model: "scripted-MLX-model",
      reasoningEffort: "none",
    });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task: "Return a short independent check." },
      },
      { kind: "assistant_text", text: "Independent check complete." },
      { kind: "assistant_text", text: "独立检查已完成。" },
    ]);

    const response = await runtime.kernel.sendMessage("subagent-mlx-none", {
      mode: "sms",
      text: "请委托一次独立检查。",
    });
    assert.equal(response.status, "completed");
    const trace = runtime.kernel.recentModelContextTraces(10).find((entry) =>
      entry.turnKind === "subagent" && entry.sessionId.startsWith("subagent:subagent-mlx-none:")
    );
    assert.ok(trace);
    assert.equal("reasoning_effort" in trace.payload, false);
    assert.deepEqual(trace.payload.chat_template_kwargs, {
      enable_thinking: false,
      preserve_thinking: true,
    });
  } finally {
    runtime.dispose();
  }
});

test("a secret conversation subagent inherits only its character-scoped secret Workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-secret-subagent-"));
  const runtime = createTestRuntime({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    seed: "subagent-secret-workspace",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密审查角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.kernel.uploadSessionWorkspaceFile(normal.id, {
      directory: "uploads",
      name: "scope.txt",
      bytes: Buffer.from("normal-only-sentinel\n", "utf8"),
    });
    runtime.kernel.uploadSessionWorkspaceFile(secret.id, {
      directory: "uploads",
      name: "scope.txt",
      bytes: Buffer.from("secret-only-sentinel\n", "utf8"),
    });
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: {
          role: "reviewer",
          task: "Read uploads/scope.txt and report the exact sentinel.",
        },
      },
      { kind: "tool_call", name: "read", arguments: { path: "uploads/scope.txt" } },
      { kind: "assistant_text", text: "The exact value is secret-only-sentinel." },
      { kind: "assistant_text", text: "独立审查确认值为 secret-only-sentinel。" },
    ]);

    const response = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "让审查员读取私密工作区。",
    });
    assert.equal(response.status, "completed");
    assert.match(response.reply, /secret-only-sentinel/u);
    const childAfterRead = JSON.stringify(runtime.model.requests[2].messages);
    assert.match(childAfterRead, /secret-only-sentinel/u);
    assert.doesNotMatch(childAfterRead, /normal-only-sentinel/u);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent delegation is disabled by default and never enters group actor tools", async () => {
  const runtime = createTestRuntime({ seed: "subagent-boundary" });
  try {
    const first = runtime.kernel.createCharacter({ name: "甲", soulMarkdown: "# 甲" });
    const second = runtime.kernel.createCharacter({ name: "乙", soulMarkdown: "# 乙" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "普通私聊回复。" }]);
    await runtime.kernel.sendMessage("subagent-disabled", {
      mode: "sms",
      characterId: first.id,
      text: "正常聊天",
    });
    assert.equal(runtime.model.requests[0].toolNames.includes("delegate_task"), false);
    assert.match(runtime.model.requests[0].systemPrompt, /Subagent delegation is disabled/);

    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
      { kind: "assistant_text", text: '{"speak":false,"reasonCode":"none"}' },
    ]);
    const group = runtime.kernel.createGroupChat({
      title: "边界测试群",
      mode: "sms",
      characterIds: [first.id, second.id],
      maxSpeakers: 2,
    });
    await runtime.kernel.sendGroupMessage(group.id, "大家先不用回复", "Asia/Shanghai");
    assert.ok(runtime.model.requests.slice(1).every((request) => request.toolNames.length === 0));
  } finally {
    runtime.dispose();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for subagent test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function providerToolMessageTexts(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const record = message as Record<string, unknown>;
    if (record.role !== "tool" && record.role !== "toolResult") return [];
    return [providerMessageContentText(record.content)];
  });
}

function providerMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") return [record.text];
    if (typeof record.content === "string") return [record.content];
    return [];
  }).join("\n");
}
