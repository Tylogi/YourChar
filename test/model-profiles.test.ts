import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel, CompanionStore } from "../src/domain/index.js";

test("legacy singleton model settings migrate to a default profile", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-model-profiles-"));
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "model-api.json"), JSON.stringify({
      enabled: true,
      provider: "openai_compatible",
      baseUrl: "https://models.invalid/v1",
      model: "legacy-model",
      reasoningEffort: "minimal",
      visionInputEnabled: false,
      apiKey: "legacy-secret",
      apiKeySet: true,
      apiKeyMasked: "wrong-mask",
    }));

    const store = new CompanionStore({ stateDir });
    const profiles = store.listModelApiProfiles();
    assert.equal(profiles.defaultProfileId, "default");
    assert.equal(profiles.profiles.length, 1);
    assert.equal(profiles.profiles[0].name, "默认模型");
    assert.equal(profiles.profiles[0].model, "legacy-model");
    assert.equal(profiles.profiles[0].reasoningEffort, "minimal");
    assert.equal(profiles.profiles[0].apiKeyMasked, "lega...cret");
    assert.equal(JSON.stringify(profiles).includes("legacy-secret"), false);
    const migrated = JSON.parse(readFileSync(join(stateDir, "model-api.json"), "utf8")) as { version?: number };
    assert.equal(migrated.version, 3);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("characters use their bound model profile and fall back after deletion", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-model-routing-"));
  const requestedModels: string[] = [];
  const requestedReasoningEfforts: Array<string | undefined> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model?: string;
      reasoning_effort?: string;
    };
    const model = body.model ?? "unknown";
    requestedModels.push(model);
    requestedReasoningEfforts.push(body.reasoning_effort);
    writeChatCompletionStream(response, model);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  let kernel: CompanionKernel | undefined;
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      characterSkillReflector: false,
    });
    kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "default-model" });
    const special = kernel.createModelApiProfile({
      name: "角色专属",
      enabled: true,
      baseUrl,
      model: "character-model",
      reasoningEffort: "max",
    });
    const inherited = kernel.createCharacter({ name: "默认角色" });
    const bound = kernel.createCharacter({ name: "专属角色", modelProfileId: special.id });

    assert.equal((await kernel.sendMessage("default-chat", {
      mode: "sms",
      characterId: inherited.id,
      text: "你好",
    })).reply, "default-model");
    assert.equal((await kernel.sendMessage("bound-chat", {
      mode: "sms",
      characterId: bound.id,
      text: "你好",
    })).reply, "character-model");

    kernel.deleteModelApiProfile(special.id);
    assert.equal(kernel.getCharacter(bound.id).modelProfileId, undefined);
    assert.equal((await kernel.sendMessage("fallback-chat", {
      mode: "sms",
      characterId: bound.id,
      text: "再次你好",
    })).reply, "default-model");
    assert.deepEqual(requestedModels, ["default-model", "character-model", "default-model"]);
    assert.deepEqual(requestedReasoningEfforts, [undefined, "max", undefined]);
  } finally {
    kernel?.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function writeChatCompletionStream(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-model-profile",
    object: "chat.completion.chunk",
    created: 1,
    model: content,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-model-profile",
    object: "chat.completion.chunk",
    created: 1,
    model: content,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
