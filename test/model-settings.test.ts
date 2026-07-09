import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";

test("model API settings persist and drive OpenAI-compatible chat", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-state-"));
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "<think>hidden reasoning</think>可读回复",
            },
          },
        ],
      }),
    );
  });

  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    const kernel = new CompanionKernel({ stateDir });
    const saved = kernel.patchModelApiConfig({
      enabled: true,
      baseUrl,
      model: "fake-model",
      apiKey: "secret-key",
      temperature: 0.2,
      maxTokens: 64,
    });
    assert.equal(JSON.stringify(saved).includes("secret-key"), false);

    const reloadedKernel = new CompanionKernel({ stateDir });
    const reloaded = reloadedKernel.getModelApiConfig();
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.model, "fake-model");
    assert.equal(reloaded.apiKeySet, true);
    assert.equal(JSON.stringify(reloaded).includes("secret-key"), false);

    const response = await reloadedKernel.sendMessage("external-model", {
      mode: "sms",
      text: "hello",
    });
    assert.equal(response.reply, "可读回复");
    assert.equal(capturedAuthorization, "Bearer secret-key");
    assert.equal(capturedBody?.model, "fake-model");
    assert.equal(capturedBody?.stream, false);
    assert.equal(capturedBody?.max_tokens, 64);
    assert.equal(JSON.stringify(capturedBody).includes("hidden reasoning"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
