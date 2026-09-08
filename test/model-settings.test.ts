import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanionKernel,
  ModelApiConfigValidationError,
} from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("model API settings persist and drive OpenAI-compatible chat", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-state-"));
  let kernel: CompanionKernel | undefined;
  let reloadedKernel: CompanionKernel | undefined;
  let capturedAuthorization = "";
  let capturedBody: Record<string, unknown> | undefined;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const authorization = request.headers.authorization;
    capturedAuthorization = Array.isArray(authorization) ? authorization.join(",") : authorization ?? "";
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    writeChatCompletionStream(response, "<think>hidden reasoning</think>可读回复");
  });

  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    kernel = new CompanionKernel({ stateDir });
    const saved = kernel.patchModelApiConfig({
      enabled: true,
      baseUrl,
      model: "fake-model",
      visionInputEnabled: true,
      apiKey: "secret-key",
      temperature: 0.2,
      maxTokens: 64,
      reasoningEffort: "high",
    });
    assert.equal(JSON.stringify(saved).includes("secret-key"), false);
    kernel.dispose();
    kernel = undefined;

    reloadedKernel = new CompanionKernel({ stateDir });
    const reloaded = reloadedKernel.getModelApiConfig();
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.model, "fake-model");
    assert.equal(reloaded.visionInputEnabled, true);
    assert.equal(reloaded.apiKeySet, true);
    assert.equal(reloaded.reasoningEffort, "high");
    assert.equal(JSON.stringify(reloaded).includes("secret-key"), false);

    reloadedKernel.setAgentModuleEnabled("mcp:vision", true);
    reloadedKernel.patchVisionConfig({ mode: "direct" });
    const image = reloadedKernel.uploadWorkspaceFile({
      directory: "uploads",
      name: "pixel.png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const response = await reloadedKernel.sendMessage("pi-model", {
      mode: "sms",
      text: "hello",
      attachments: [{ path: image.path, contentType: image.contentType, size: image.size }],
    });
    assert.equal(response.reply, "可读回复");
    assert.equal(capturedAuthorization, "Bearer secret-key");
    assert.equal(capturedBody?.model, "fake-model");
    assert.equal(capturedBody?.stream, true);
    assert.equal(capturedBody?.max_tokens, 64);
    assert.equal(capturedBody?.reasoning_effort, "high");
    assert.match(JSON.stringify(capturedBody), /data:image\/png;base64/);
    assert.equal(JSON.stringify(capturedBody).includes("hidden reasoning"), false);
    reloadedKernel.dispose();
    reloadedKernel = undefined;
  } finally {
    kernel?.dispose();
    reloadedKernel?.dispose();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model API reasoning effort validates, exposes safe values, and can return to provider defaults", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    characterSkillReflector: false,
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const reasoningEffort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      const response = await fetch(`${baseUrl}/api/settings/model-api`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reasoningEffort }),
      });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { reasoningEffort?: string }).reasoningEffort, reasoningEffort);
    }

    const cleared = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: null }),
    });
    assert.equal(cleared.status, 200);
    assert.equal("reasoningEffort" in (await cleared.json() as object), false);

    const rejected = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "extreme" }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      code: "MODEL_API_CONFIG_INVALID",
      error: "reasoningEffort must be none, minimal, low, medium, high, xhigh, max, ultra, or null",
    });
    assert.equal(kernel.getModelApiConfig().reasoningEffort, undefined);
    assert.throws(
      () => kernel.patchModelApiConfig({ reasoningEffort: "extreme" as never }),
      ModelApiConfigValidationError,
    );

    for (const thinkingTokenBudgetField of [
      "thinking_token_budget",
      "thinking_budget",
      "thinking_budget_tokens",
    ] as const) {
      const response = await fetch(`${baseUrl}/api/settings/model-api`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingTokenBudgetField, thinkingBudgetTokens: 2_048 }),
      });
      assert.equal(response.status, 200);
      const config = await response.json() as {
        thinkingTokenBudgetField?: string;
        thinkingBudgetTokens?: number;
      };
      assert.equal(config.thinkingTokenBudgetField, thinkingTokenBudgetField);
      assert.equal(config.thinkingBudgetTokens, 2_048);
    }

    const clearedThinkingBudget = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thinkingTokenBudgetField: null, thinkingBudgetTokens: null }),
    });
    assert.equal(clearedThinkingBudget.status, 200);
    const clearedThinkingConfig = await clearedThinkingBudget.json() as object;
    assert.equal("thinkingTokenBudgetField" in clearedThinkingConfig, false);
    assert.equal("thinkingBudgetTokens" in clearedThinkingConfig, false);

    const rejectedThinkingField = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thinkingTokenBudgetField: "unknown_budget" }),
    });
    assert.equal(rejectedThinkingField.status, 400);
    assert.deepEqual(await rejectedThinkingField.json(), {
      code: "MODEL_API_CONFIG_INVALID",
      error: "thinkingTokenBudgetField must be thinking_token_budget, thinking_budget, thinking_budget_tokens, or null",
    });

    const rejectedThinkingBudget = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thinkingBudgetTokens: 0 }),
    });
    assert.equal(rejectedThinkingBudget.status, 400);
    assert.deepEqual(await rejectedThinkingBudget.json(), {
      code: "MODEL_API_CONFIG_INVALID",
      error: "thinkingBudgetTokens must be an integer from 1 to 1000000, or null",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    kernel.dispose();
  }
});

test("native thinking budget is opt-in and replaces the legacy reasoning_effort field", async () => {
  const capturedBodies: Array<Record<string, unknown>> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    writeChatCompletionStream(response, "预算回复");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    memoryExtractor: async () => ({ candidates: [] }),
    characterSkillReflector: false,
  });
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fake-model",
      maxTokens: 4_096,
      reasoningEffort: "high",
      thinkingTokenBudgetField: "thinking_token_budget",
      thinkingBudgetTokens: 2_048,
    });
    const response = await kernel.sendMessage("native-thinking-budget", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.reply, "预算回复");
    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0].thinking_token_budget, 2_048);
    assert.equal("reasoning_effort" in capturedBodies[0], false);
  } finally {
    kernel.dispose();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("model API accepts a full chat completions endpoint as base URL", async () => {
  let requestedPath = "";
  const modelServer = createServer(async (request, response) => {
    requestedPath = request.url ?? "";
    writeChatCompletionStream(response, "完整 endpoint 回复");
  });

  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;

    const kernel = new CompanionKernel({ stateDir: false });
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: endpoint,
      model: "fake-model",
    });

    const response = await kernel.sendMessage("full-endpoint", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.reply, "完整 endpoint 回复");
    assert.equal(requestedPath, "/v1/chat/completions");
  } finally {
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("MLX reasoning none disables template thinking without an unsupported top-level effort", async () => {
  const capturedBodies: Array<Record<string, unknown>> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    writeChatCompletionStream(response, "关闭思考后的可见回复");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    memoryExtractor: async () => ({ candidates: [] }),
    characterSkillReflector: false,
  });
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fake-MLX-model",
      reasoningEffort: "none",
    });
    const response = await kernel.sendMessage("mlx-reasoning-none", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.reply, "关闭思考后的可见回复");
    assert.equal(capturedBodies.length, 1, "reasoning none must not trigger the MLX missing-thinking retry");
    assert.equal("reasoning_effort" in capturedBodies[0], false);
    assert.deepEqual(capturedBodies[0].chat_template_kwargs, {
      enable_thinking: false,
      preserve_thinking: true,
    });
    assert.equal((await kernel.testModelConnection()).ok, true);
    assert.equal(capturedBodies.length, 2);
    assert.equal("reasoning_effort" in capturedBodies[1], false);
    assert.deepEqual(capturedBodies[1].chat_template_kwargs, {
      enable_thinking: false,
      preserve_thinking: true,
    });
  } finally {
    kernel.dispose();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

function writeChatCompletionStream(response: ServerResponse, content: string): void {
  const id = "chatcmpl-test";
  const created = Math.floor(Date.now() / 1000);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "fake-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "fake-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "fake-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}
