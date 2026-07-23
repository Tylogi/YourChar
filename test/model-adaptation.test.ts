import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";
import type { FeatureTestResult } from "../src/evaluation/feature-tests.js";
import {
  judgeFeatureTestQuality,
  scoreFeatureTestResult,
  summarizeModelAdaptation,
} from "../src/evaluation/model-adaptation.js";
import { createHttpServer } from "../src/http/router.js";

test("functional completeness excludes preflight rules and keeps blocked coverage explicit", () => {
  const completed = featureResult({
    rules: [
      { id: "model-configured", label: "model", passed: true, evidence: "ok", scope: "preflight" },
      { id: "completed", label: "completed", passed: true, evidence: "ok", scope: "functional" },
      { id: "tool", label: "tool", passed: false, evidence: "missing", scope: "functional" },
      { id: "state", label: "state", passed: true, evidence: "ok", scope: "functional" },
    ],
  });
  const blocked = featureResult({
    status: "blocked",
    passed: false,
    rules: [{ id: "module", label: "module disabled", passed: false, evidence: "disabled", scope: "preflight" }],
  });

  assert.deepEqual(scoreFeatureTestResult(completed), {
    score: 66.7,
    passedRules: 2,
    totalRules: 3,
    blocked: false,
    blockers: [],
  });
  assert.deepEqual(scoreFeatureTestResult(blocked), {
    score: null,
    passedRules: 0,
    totalRules: 0,
    blocked: true,
    blockers: ["module disabled"],
  });
});

test("adaptation summary applies the documented 70/30 weighting", () => {
  const first = featureResult();
  const second = featureResult({ caseId: "second", passed: false });
  const summary = summarizeModelAdaptation([
    {
      result: first,
      functional: { score: 100, passedRules: 3, totalRules: 3, blocked: false, blockers: [] },
      quality: qualityJudgment(80),
    },
    {
      result: second,
      functional: { score: 50, passedRules: 1, totalRules: 2, blocked: false, blockers: [] },
      quality: qualityJudgment(60),
    },
  ]);

  assert.equal(summary.functionalScore, 75);
  assert.equal(summary.qualityScore, 70);
  assert.equal(summary.overallScore, 73.5);
  assert.equal(summary.executionCoverage, 1);
  assert.equal(summary.compatibility, "usable");
});

test("quality judge retries malformed output once and returns normalized dimensions", async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before writing the SSE response.
    }
    requests += 1;
    writeModelResponse(response, "judge-model", requests === 1 ? "not-json" : judgeJson());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  try {
    const judge = kernel.createModelApiProfile({
      name: "独立 Judge",
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "judge-model",
    });
    const character = kernel.createCharacter({ name: "测试角色", soulMarkdown: "你用第一人称自然交流。" });
    const judgment = await judgeFeatureTestQuality(kernel, featureResult(), judge.id, character.id);

    assert.equal(requests, 2);
    assert.equal(judgment.status, "scored");
    assert.equal(judgment.score, 80);
    assert.equal(judgment.dimensions.length, 5);
    assert.equal(judgment.modelRequests, 2);
  } finally {
    kernel.dispose();
    await closeServer(server);
  }
});

test("feature-test API routes the full sandbox through the selected model and judges separately", async () => {
  const requestedModels: string[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
    const model = body.model ?? "";
    requestedModels.push(model);
    writeModelResponse(
      response,
      model,
      model === "judge-model" ? judgeJson() : "我会先陪你缓一缓，再一起看看实验记录里最可疑的变量。",
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
    kernel.patchModelApiConfig({ enabled: false });
    const target = kernel.createModelApiProfile({
      name: "被测模型",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "target-model",
    });
    const judge = kernel.createModelApiProfile({
      name: "Judge 模型",
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "judge-model",
    });
    const character = kernel.createCharacter({ name: "被测角色", soulMarkdown: "你是角色本人，用第一人称自然回复。" });
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/feature-tests/sms-character-voice/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterId: character.id,
        modelProfileId: target.id,
        judgeModelProfileId: judge.id,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      result: FeatureTestResult;
      functional: { score: number | null };
      quality: { status: string; score: number | null };
    };

    assert.equal(body.result.model.profileId, target.id);
    assert.equal(body.functional.score, 100);
    assert.equal(body.quality.status, "scored");
    assert.equal(body.quality.score, 80);
    assert.equal(requestedModels.includes("judge-model"), true);
    assert.equal(requestedModels.filter((model) => model !== "judge-model").every((model) => model === "target-model"), true);
  } finally {
    await closeServer(appServer);
    kernel.dispose();
    await closeServer(modelServer);
  }
});

function featureResult(patch: Partial<FeatureTestResult> = {}): FeatureTestResult {
  return {
    caseId: "sms-character-voice",
    category: "conversation",
    name: "角色私聊口吻",
    input: "今天实验连续失败了，你会怎么跟我说？",
    passed: true,
    status: "completed",
    reply: "我会陪你一起看看。",
    durationMs: 10,
    modelRequests: 1,
    actions: [],
    rules: [
      { id: "model-configured", label: "model", passed: true, evidence: "ok", scope: "preflight" },
      { id: "completed", label: "completed", passed: true, evidence: "ok", scope: "functional" },
    ],
    model: { profileId: "target", profileName: "Target", model: "target-model" },
    qualitySample: "我会陪你一起看看。",
    qualitySampleLabel: "模型回复",
    ranAt: "2026-07-22T00:00:00.000Z",
    ...patch,
  };
}

function qualityJudgment(score: number) {
  return {
    status: "scored" as const,
    score,
    dimensions: [],
    summary: "ok",
    flags: [],
    confidence: 0.8,
    judge: { profileId: "judge", profileName: "Judge", model: "judge-model" },
    modelRequests: 1,
    durationMs: 10,
    inputTokens: 100,
    outputTokens: 50,
  };
}

function judgeJson(): string {
  return JSON.stringify({
    dimensions: {
      instruction_following: { score: 5, reason: "直接回应" },
      role_fidelity: { score: 4, reason: "角色口吻稳定" },
      coherence: { score: 4, reason: "表达连贯" },
      naturalness: { score: 4, reason: "语言自然" },
      contextual_fit: { score: 3, reason: "情境基本契合" },
    },
    summary: "整体自然且可用。",
    flags: [],
    confidence: 0.85,
  });
}

function writeModelResponse(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-adaptation",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-adaptation",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
