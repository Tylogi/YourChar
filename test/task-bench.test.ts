import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";
import {
  parseTaskBenchRequest,
  runTaskBench,
  TaskBenchValidationError,
  type TaskBenchReport,
} from "../src/evaluation/task-bench.js";
import {
  createLspNavigationCapabilityPackage,
  type LspProviderScope,
} from "../src/lsp/index.js";
import {
  TASK_BENCH_UPLOAD_TTL_MS,
  TaskBenchUploadError,
  TaskBenchUploadRegistry,
} from "../src/evaluation/task-bench-uploads.js";
import { createHttpServer } from "../src/http/router.js";

test("task bench request validation requires a character only in character mode", () => {
  assert.throws(
    () => parseTaskBenchRequest({
      targetMode: "character",
      modelProfileId: "model",
      task: "完成任务",
    }),
    TaskBenchValidationError,
  );
  const parsed = parseTaskBenchRequest({
    targetMode: "model",
    modelProfileId: "model",
    task: "完成任务",
  });
  assert.equal(parsed.repetitions, 3);
  assert.equal(parsed.timeoutSeconds, 30 * 60);
  assert.equal(parsed.judgeTimeoutSeconds, 10 * 60);
  assert.equal(parsed.judgeWeight, 0.6);
  assert.deepEqual(parsed.assertions.requiredFiles, []);
  assert.deepEqual(parsed.uploadIds, []);
});

test("temporary task bench uploads expire and release their in-memory bytes", () => {
  let now = Date.parse("2026-09-02T00:00:00.000Z");
  const uploads = new TaskBenchUploadRegistry(() => now);
  try {
    const upload = uploads.add({
      name: "evidence.txt",
      contentType: "text/plain; charset=utf-8",
      bytes: Buffer.from("temporary evidence", "utf8"),
    });
    assert.equal(upload.contentType, "text/plain");
    assert.equal(uploads.snapshot([upload.id])[0]?.bytes.toString("utf8"), "temporary evidence");
    now += TASK_BENCH_UPLOAD_TTL_MS;
    assert.throws(
      () => uploads.snapshot([upload.id]),
      (error: unknown) => error instanceof TaskBenchUploadError && error.code === "TASK_BENCH_UPLOAD_NOT_FOUND",
    );
  } finally {
    uploads.dispose();
  }
});

test("task bench API runs fresh zero-memory character sandboxes and uses an independent LLM Judge", async () => {
  const requests: Array<{ model: string; body: Record<string, unknown> }> = [];
  let judgeRequests = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    requests.push({ model, body });
    if (model === "judge-model") judgeRequests += 1;
    writeModelResponse(
      response,
      model,
      model === "judge-model"
        ? judgeRequests === 1 ? "not-json" : taskJudgeJson(true)
        : "最终结论：测试通过。依据是给定任务要求。",
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");

  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const appServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    kernel.updateUserProfile("# User Profile\n\nSOURCE_PROFILE_SECRET_MARKER");
    const target = kernel.createModelApiProfile({
      name: "被测模型配置",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "target-model",
    });
    const judge = kernel.createModelApiProfile({
      name: "独立 Judge 配置",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "judge-model",
    });
    const character = kernel.createCharacter({
      name: "测试角色",
      soulMarkdown: "# SOUL\n\nROLE_SOUL_MARKER；严谨完成任务。",
    });
    kernel.createCharacterOwnedSkill(character.id, {
      name: "测试专属技能",
      markdown: "# 测试专属技能\n\nROLE_SKILL_MARKER：输出前核对结论、任务要求、证据来源和最终交付内容，发现遗漏时先补全再回答。",
      activate: true,
    });
    kernel.createControlPlaneMemory({
      realm: "reality",
      type: "user_fact",
      key: "task.bench.secret",
      content: "SOURCE_MEMORY_SECRET_MARKER",
      sourceSessionId: "source-session",
      sourceMessageId: "source-message",
      salience: 1,
      confidence: 1,
      tags: ["test"],
      idempotencyKey: "task-bench-source-secret",
    });

    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "隔离任务评测",
        targetMode: "character",
        characterId: character.id,
        modelProfileId: target.id,
        judgeModelProfileId: judge.id,
        task: "请给出最终结论。",
        rubric: "结论必须明确，并说明依据。",
        referenceAnswer: "JUDGE_ONLY_REFERENCE_MARKER",
        repetitions: 2,
        passThreshold: 70,
        judgeWeight: 0.6,
        assertions: {
          requiredPhrases: ["最终结论"],
          forbiddenPhrases: ["SOURCE_MEMORY_SECRET_MARKER"],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { report: TaskBenchReport; markdown: string };

    assert.equal(body.report.runs.length, 2);
    assert.equal(body.report.summary.passedRuns, 2);
    assert.equal(body.report.summary.judgeCoverage, 1);
    assert.equal(body.report.isolation.memory, "empty_and_disabled");
    assert.equal(body.report.isolation.sandboxDestroyed, true);
    assert.equal(body.report.runs.every((run) => run.checks.find((check) => check.id === "memory-isolation")?.passed), true);
    assert.equal(body.report.runs.every((run) => run.judge?.status === "scored"), true);
    assert.equal(body.report.runs.every((run) => run.judge?.dimensions.some((entry) => entry.id === "role_fidelity")), true);
    assert.match(body.markdown, /零记忆/u);
    assert.equal(kernel.listMemories({ limit: 100 }).some((memory) => memory.content === "SOURCE_MEMORY_SECRET_MARKER"), true);

    const targetPayloads = requests.filter((entry) => entry.model === "target-model");
    assert.equal(targetPayloads.length, 2);
    for (const request of targetPayloads) {
      const payload = JSON.stringify(request.body);
      assert.match(payload, /ROLE_SOUL_MARKER/u);
      assert.match(payload, /ROLE_SKILL_MARKER/u);
      assert.doesNotMatch(payload, /SOURCE_MEMORY_SECRET_MARKER/u);
      assert.doesNotMatch(payload, /SOURCE_PROFILE_SECRET_MARKER/u);
      assert.doesNotMatch(payload, /JUDGE_ONLY_REFERENCE_MARKER/u);
    }
    const judgePayloads = requests.filter((entry) => entry.model === "judge-model");
    assert.equal(judgePayloads.length, 3);
    assert.equal(judgePayloads.every((entry) => !JSON.stringify(entry.body).includes("target-model")), true);
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

test("task bench model mode excludes the selected character identity", async () => {
  const targetPayloads: Record<string, unknown>[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    targetPayloads.push(body);
    writeModelResponse(response, String(body.model ?? ""), "MODEL_BASELINE_RESULT");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const appServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    const target = kernel.createModelApiProfile({
      name: "模型基线",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "baseline-model",
    });
    kernel.createCharacter({ name: "不应注入的角色", soulMarkdown: "CHARACTER_MUST_NOT_APPEAR" });
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const uploadResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/task-bench/uploads?name=${encodeURIComponent("direct-evidence.txt")}`,
      {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("DIRECT_UPLOAD_EVIDENCE", "utf8"),
      },
    );
    assert.equal(uploadResponse.status, 201);
    const uploadBody = await uploadResponse.json() as { upload: { id: string; name: string; size: number } };
    assert.equal(uploadBody.upload.name, "direct-evidence.txt");
    assert.equal(kernel.listWorkspaceFiles(".").entries.some((entry) => entry.name === "direct-evidence.txt"), false);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetMode: "model",
        modelProfileId: target.id,
        task: "MODEL_MODE_TASK",
        repetitions: 1,
        uploadIds: [uploadBody.upload.id],
        assertions: { requiredPhrases: ["MODEL_BASELINE_RESULT"] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { report: TaskBenchReport };
    assert.equal(body.report.targetMode, "model");
    assert.equal(body.report.character, undefined);
    assert.equal(body.report.summary.passedRuns, 1);
    assert.deepEqual(body.report.fixtures, [{
      source: "temporary_upload",
      name: "direct-evidence.txt",
      size: Buffer.byteLength("DIRECT_UPLOAD_EVIDENCE"),
    }]);
    assert.equal(targetPayloads.length, 1);
    assert.doesNotMatch(JSON.stringify(targetPayloads[0]), /CHARACTER_MUST_NOT_APPEAR/u);
    assert.match(JSON.stringify(targetPayloads[0]), /direct-evidence\.txt/u);
    assert.equal(kernel.listWorkspaceFiles(".").entries.some((entry) => entry.name === "direct-evidence.txt"), false);

    const historyResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/task-bench/reports?limit=10`,
    );
    assert.equal(historyResponse.status, 200);
    const historyBody = await historyResponse.json() as {
      reports: Array<{ id: string; summary: { overallScoreMean: number | null } }>;
    };
    assert.equal(historyBody.reports[0]?.id, body.report.id);
    assert.equal(historyBody.reports[0]?.summary.overallScoreMean, 100);

    const storedResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/task-bench/reports/${encodeURIComponent(body.report.id)}`,
    );
    assert.equal(storedResponse.status, 200);
    const storedBody = await storedResponse.json() as { report: TaskBenchReport; markdown: string };
    assert.deepEqual(storedBody.report, body.report);
    assert.match(storedBody.markdown, /MODEL_MODE_TASK/u);

    const removeResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/task-bench/uploads/${encodeURIComponent(uploadBody.upload.id)}`,
      { method: "DELETE" },
    );
    assert.equal(removeResponse.status, 200);
    const staleResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetMode: "model",
        modelProfileId: target.id,
        task: "MODEL_MODE_TASK",
        repetitions: 1,
        uploadIds: [uploadBody.upload.id],
      }),
    });
    assert.equal(staleResponse.status, 404);
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

test("task bench recreates only explicitly approved deployment capabilities in its fresh Workspace", async () => {
  const targetPayloads: Record<string, unknown>[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    targetPayloads.push(body);
    writeModelResponse(response, String(body.model ?? ""), "LSP_BENCH_READY");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const scopes: LspProviderScope[] = [];
  let closes = 0;
  const lspPackage = createLspNavigationCapabilityPackage({
    version: "1",
    contentDigest: "e".repeat(64),
    source: "task bench fixture",
    trusted: true,
    providers: [{
      id: "bench-typescript",
      extensions: [".ts"],
      mount(scope) {
        scopes.push(scope);
        return {
          id: "bench-typescript",
          extensions: [".ts"],
          query: async () => ({ kind: "empty" }),
          close: () => { closes += 1; },
        };
      },
    }],
  });
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    agentCapabilityPackages: [lspPackage],
    agentRuntimeProfiles: [{
      id: "default",
      name: "LSP benchmark",
      description: "Activate the benchmark-safe LSP package.",
      packageIds: [lspPackage.id],
    }],
  });
  try {
    const target = kernel.createModelApiProfile({
      name: "LSP benchmark model",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "lsp-bench-model",
    });
    kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    kernel.setAgentModuleEnabled("mcp:lsp-navigation", true);
    const { report } = await runTaskBench(kernel, {
      targetMode: "model",
      modelProfileId: target.id,
      task: "确认代码导航评测环境。",
      repetitions: 1,
      assertions: { requiredPhrases: ["LSP_BENCH_READY"] },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(report.summary.passedRuns, 1);
    assert.equal(report.capabilities.enabledModules.includes("mcp:lsp-navigation"), true);
    assert.equal(targetPayloads.length, 1);
    assert.match(JSON.stringify(targetPayloads[0]), /"name":"lsp"/u);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0]?.readOnly, true);
    assert.equal(scopes[0]?.workspaceUri, "file:///workspace");
    assert.notEqual(scopes[0]?.workspaceDir, kernel.getAgentPermissions().workspaceDir);
    assert.equal(closes, 1);
  } finally {
    kernel.dispose();
    await closeServer(modelServer);
  }
});

test("task bench exposes configured MinerU without leaking its credential", async () => {
  const targetPayloads: Record<string, unknown>[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    targetPayloads.push(body);
    writeModelResponse(response, String(body.model ?? ""), "MINERU_AVAILABLE");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const appServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    const target = kernel.createModelApiProfile({
      name: "MinerU 测试模型",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "mineru-target-model",
    });
    kernel.patchMineruConfig({
      baseUrl: "https://mineru.example.test",
      apiKey: "MINERU_TASK_BENCH_SECRET",
    });
    kernel.setAgentModuleEnabled("mcp:mineru", true);
    kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetMode: "model",
        modelProfileId: target.id,
        task: "确认 MinerU 工具是否可用。",
        repetitions: 1,
        assertions: { requiredPhrases: ["MINERU_AVAILABLE"] },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { report: TaskBenchReport };
    assert.equal(body.report.capabilities.enabledModules.includes("mcp:mineru"), true);
    assert.equal(targetPayloads.length, 1);
    const payload = JSON.stringify(targetPayloads[0]);
    assert.match(payload, /parse_document_with_mineru/u);
    assert.doesNotMatch(payload, /MINERU_TASK_BENCH_SECRET/u);
    assert.doesNotMatch(JSON.stringify(body.report), /MINERU_TASK_BENCH_SECRET/u);
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

test("task bench reports its own deadline as timed_out instead of user cancellation", { timeout: 15_000 }, async () => {
  const modelServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the provider request before keeping its SSE response open.
    }
    writeHangingModelResponse(response, "slow-local-model");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const appServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    const target = kernel.createModelApiProfile({
      name: "慢速本地模型",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "slow-local-model",
    });
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetMode: "model",
        modelProfileId: target.id,
        task: "执行一个慢速任务",
        repetitions: 1,
        timeoutSeconds: 1,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { report: TaskBenchReport };
    assert.equal(body.report.timeouts.taskSeconds, 1);
    assert.equal(body.report.runs[0]?.status, "timed_out");
    assert.equal(body.report.summary.timedOutRuns, 1);
    assert.match(body.report.runs[0]?.reply ?? "", /达到 1秒时间上限/u);
    assert.doesNotMatch(body.report.runs[0]?.reply ?? "", /生成已取消/u);
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

test("task bench gives a slow local Judge its own configurable deadline", { timeout: 15_000 }, async () => {
  let judgeRequests = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const model = String(body.model ?? "");
    if (model === "slow-judge") {
      judgeRequests += 1;
      writeHangingModelResponse(response, model);
      return;
    }
    writeModelResponse(response, model, "TARGET_COMPLETED");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const appServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    const target = kernel.createModelApiProfile({
      name: "快速目标模型",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "fast-target",
    });
    const judge = kernel.createModelApiProfile({
      name: "慢速本地 Judge",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "slow-judge",
    });
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/task-bench/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetMode: "model",
        modelProfileId: target.id,
        judgeModelProfileId: judge.id,
        task: "返回目标结果",
        repetitions: 1,
        timeoutSeconds: 5,
        judgeTimeoutSeconds: 1,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { report: TaskBenchReport };
    assert.equal(body.report.runs[0]?.status, "completed");
    assert.equal(body.report.runs[0]?.judge?.status, "timed_out");
    assert.match(body.report.runs[0]?.judge?.error ?? "", /Judge 达到 1秒时间上限/u);
    assert.equal(judgeRequests, 1, "an expired Judge deadline must not be retried");
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

function taskJudgeJson(includeRole: boolean): string {
  return JSON.stringify({
    dimensions: {
      correctness: { score: 5, reason: "结论正确" },
      instruction_following: { score: 4, reason: "遵循要求" },
      completeness: { score: 4, reason: "覆盖主要内容" },
      evidence_quality: { score: 4, reason: "依据可核查" },
      communication_quality: { score: 4, reason: "表达清楚" },
      ...(includeRole ? { role_fidelity: { score: 5, reason: "符合角色设定" } } : {}),
    },
    summary: "结果正确且可用。",
    flags: [],
    confidence: 0.9,
  });
}

function writeModelResponse(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-task-bench",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-task-bench",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeHangingModelResponse(response: ServerResponse, model: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-task-bench-slow",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "处理中" }, finish_reason: null }],
  })}\n\n`);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
