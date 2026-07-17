import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";

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
