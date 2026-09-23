import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime } from "../src/testing/runtime.js";
import { formatVisionAnalysis, maximumVisionAnalysisCharacters, VisionService } from "../src/vision/service.js";
import { WorkspaceFileError, WorkspaceFileService } from "../src/workspace/file-service.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("automatic vision follows the character's profile, including its capability context", async (t) => {
  for (const characterVision of [true, false]) {
    await t.test(characterVision ? "vision character with text-only default" : "text-only character with vision default", async () => {
      const root = mkdtempSync(join(tmpdir(), "yourchar-character-vision-"));
      const workspaceDir = join(root, "workspace");
      let independentCalls = 0;
      const service = new VisionService({
        workspaceFiles: new WorkspaceFileService(workspaceDir),
        fetch: async () => {
          independentCalls += 1;
          return Response.json({ choices: [{ message: { content: '{"summary":"Visible pixel"}' } }] });
        },
      });
      service.patchConfig({ mode: "auto", baseUrl: "https://vision.example.test/v1", model: "independent-vision" });
      const runtime = createTestRuntime({ workspaceDir, visionService: service });
      try {
        runtime.kernel.setAgentModuleEnabled("mcp:vision", true);
        runtime.kernel.patchModelApiConfig({ visionInputEnabled: !characterVision });
        const profile = runtime.kernel.createModelApiProfile({
          name: "角色模型", enabled: true, baseUrl: "http://test.invalid/v1",
          model: "character-model", visionInputEnabled: characterVision,
        });
        const character = runtime.kernel.createCharacter({ name: "测试角色", modelProfileId: profile.id });
        const image = runtime.kernel.uploadWorkspaceFile({ directory: "uploads", name: "pixel.png", bytes: tinyPng });
        runtime.model.enqueue([{ kind: "assistant_text", text: "图片里有一个像素。" }]);
        const response = await runtime.kernel.sendMessage("character-vision", {
          mode: "sms", characterId: character.id, text: "描述这张图片。",
          attachments: [{ path: image.path, contentType: image.contentType }],
        });
        assert.equal(response.status, "completed");
        assert.equal(independentCalls, characterVision ? 0 : 1);
        assert.equal(response.actions.some(action => action.actionType === "vision_direct_input"), characterVision);
        const request = runtime.model.requests[0];
        assert.equal(JSON.stringify(request.messages).includes('"type":"image"'), characterVision);
        if (characterVision) {
          assert.match(request.systemPrompt, /sent directly to the vision-capable primary model/);
          assert.doesNotMatch(request.systemPrompt, /Vision MCP is enabled in auto mode/);
        } else {
          assert.match(request.systemPrompt, /Vision MCP is enabled in auto mode/);
          assert.doesNotMatch(request.systemPrompt, /sent directly to the vision-capable primary model/);
          assert.match(JSON.stringify(request.messages), /Visible pixel/);
        }
      } finally {
        runtime.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("vision preserves dense summaries, long OCR lines, and lists beyond thirty entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-vision-budget-"));
  const workspaceFiles = new WorkspaceFileService(join(root, "workspace"));
  const image = workspaceFiles.upload({ directory: "uploads", name: "dense.png", bytes: tinyPng });
  const full = {
    summary: "Summary detail. ".repeat(200) + "SUMMARY_END",
    observations: Array.from({ length: 45 }, (_, index) => `Observation ${index}`),
    ocr: Array.from({ length: 40 }, (_, index) => `${index}: ${"Visible text ".repeat(150)} OCR_END_${index}`),
    uncertainties: [],
  };
  const budgets: number[] = [];
  const service = new VisionService({
    workspaceFiles, stateDir: root,
    fetch: async (_url, init) => {
      budgets.push(JSON.parse(String(init?.body)).max_tokens);
      return Response.json({ choices: [{ message: { content: JSON.stringify(full) }, finish_reason: "stop" }] });
    },
  });
  try {
    service.patchConfig({ baseUrl: "https://vision.example.test/v1", model: "vision-model" });
    const input = { path: image.path, question: "Transcribe everything." };
    const result = await service.analyzePath(input);
    assert.deepEqual({ summary: result.summary, observations: result.observations, ocr: result.ocr, uncertainties: result.uncertainties }, full);
    assert.equal(result.truncated, undefined);
    assert.equal((await service.analyzePath(input)).cached, true);
    assert.deepEqual(budgets, [8192]);

    service.patchConfig({ maxOutputTokens: 16384 });
    assert.equal((await service.analyzePath(input)).cached, false, "a larger budget must not reuse the shorter-budget cache");
    assert.deepEqual(budgets, [8192, 16384]);
    assert.equal(new VisionService({ workspaceFiles, stateDir: root }).getConfig().maxOutputTokens, 16384);
    for (const budget of [0, 1023, 32769, 1500.5, NaN]) {
      assert.throws(() => service.patchConfig({ maxOutputTokens: budget }), /maxOutputTokens must be an integer/);
      assert.equal(service.getConfig().maxOutputTokens, 16384);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete vision outputs are identified and never cached as complete analyses", async (t) => {
  for (const providerLimited of [true, false]) {
    await t.test(providerLimited ? "provider output limit" : "application result limit", async () => {
      const root = mkdtempSync(join(tmpdir(), "yourchar-vision-incomplete-"));
      const workspaceFiles = new WorkspaceFileService(join(root, "workspace"));
      const image = workspaceFiles.upload({ directory: "uploads", name: "dense.png", bytes: tinyPng });
      let calls = 0;
      const service = new VisionService({
        workspaceFiles, stateDir: root,
        fetch: async () => {
          calls += 1;
          return Response.json({ choices: [{
            message: { content: providerLimited
              ? '{"summary":"An unfinished description ' + "text ".repeat(600)
              : JSON.stringify({ summary: "x".repeat(maximumVisionAnalysisCharacters + 1) }) },
            finish_reason: providerLimited ? "length" : "stop",
          }] });
        },
      });
      try {
        service.patchConfig({ baseUrl: "https://vision.example.test/v1", model: "vision-model" });
        const input = { path: image.path, question: "Describe everything." };
        const result = await service.analyzePath(input);
        assert.equal(result.truncated, true);
        assert.ok(result.summary.length > 2000);
        assert.ok(result.summary.length <= maximumVisionAnalysisCharacters);
        assert.match(formatVisionAnalysis(result), /analysis is incomplete/);
        assert.equal((await service.analyzePath(input)).cached, false);
        assert.equal(calls, 2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("a dense vision tool result reaches the character model without the generic 32k cut", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-vision-tool-context-"));
  const workspaceDir = join(root, "workspace");
  const fullOcr = "Visible words. ".repeat(3000) + "FULL_OCR_TAIL";
  const service = new VisionService({
    workspaceFiles: new WorkspaceFileService(workspaceDir),
    fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "A dense page", ocr: [fullOcr],
    }) }, finish_reason: "stop" }] }),
  });
  service.patchConfig({ baseUrl: "https://vision.example.test/v1", model: "vision-model", maxOutputTokens: 16384 });
  const runtime = createTestRuntime({ workspaceDir, visionService: service });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:vision", true);
    const image = runtime.kernel.uploadWorkspaceFile({ directory: "uploads", name: "dense.png", bytes: tinyPng });
    runtime.model.enqueue([
      { kind: "tool_call", name: "analyze_image", arguments: { path: image.path, question: "Transcribe the full page." } },
      { kind: "assistant_text", text: "已经读完图片里的文字。" },
    ]);
    const response = await runtime.kernel.sendMessage("dense-vision-tool", { mode: "sms", text: "读取之前的图片。" });
    assert.equal(response.status, "completed");
    const providerResult = runtime.model.requests[1].messages.find((message) =>
      typeof message === "object" && message !== null && "role" in message && message.role === "toolResult");
    const serialized = JSON.stringify(providerResult);
    assert.ok(serialized.includes(fullOcr));
    assert.doesNotMatch(serialized, /Tool result compacted for active model context/);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vision service restricts image paths, validates signatures, masks credentials, and caches analyses", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-vision-service-"));
  const workspaceFiles = new WorkspaceFileService(join(root, "workspace"));
  const secretWorkspaceFiles = new WorkspaceFileService(join(root, "workspace-secret", "character"));
  const image = workspaceFiles.upload({ directory: "uploads", name: "pixel.png", bytes: tinyPng });
  const secretImage = secretWorkspaceFiles.upload({ directory: "uploads", name: "pixel.png", bytes: tinyPng });
  const invalid = workspaceFiles.upload({ directory: "uploads", name: "fake.png", bytes: Buffer.from("not an image") });
  writeFileSync(join(workspaceFiles.rootDir, "outside.png"), tinyPng);
  const requests: Array<{ url: string; authorization: string }> = [];
  const service = new VisionService({
    workspaceFiles,
    stateDir: root,
    fetch: async (url, init) => {
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "vision-b" }, { id: "vision-a" }] });
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          summary: "A single bright pixel.",
          observations: ["Square image"],
          ocr: [],
          uncertainties: ["Color may vary by decoder"],
        }) } }],
      });
    },
  });

  try {
    const discoveryConfig = service.patchConfig({
      baseUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "vision-secret-key",
    });
    assert.equal(discoveryConfig.model, "");
    assert.deepEqual(await service.discoverModels(), ["vision-a", "vision-b"]);
    await assert.rejects(
      service.testConnection(),
      (error: unknown) => error instanceof Error && error.message === "Vision model is required",
    );

    const config = service.patchConfig({
      mode: "mcp",
      model: "vision-a",
      detail: "high",
      maxImages: 3,
    });
    assert.equal(config.apiKeyMasked, "visi...-key");
    assert.equal(JSON.stringify(config).includes("vision-secret-key"), false);
    assert.match(readFileSync(join(root, "vision.json"), "utf8"), /vision-secret-key/);

    const first = await service.analyzePath(
      { path: image.path, question: "What is visible?" },
      undefined,
      { workspaceFiles, cacheNamespace: "workspace:normal" },
    );
    const second = await service.analyzePath(
      { path: image.path, question: "What is visible?" },
      undefined,
      { workspaceFiles, cacheNamespace: "workspace:normal" },
    );
    const secretFirst = await service.analyzePath(
      { path: secretImage.path, question: "What is visible?" },
      undefined,
      { workspaceFiles: secretWorkspaceFiles, cacheNamespace: "workspace:secret:character" },
    );
    const secretSecond = await service.analyzePath(
      { path: secretImage.path, question: "What is visible?" },
      undefined,
      { workspaceFiles: secretWorkspaceFiles, cacheNamespace: "workspace:secret:character" },
    );
    assert.equal(first.summary, "A single bright pixel.");
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(secretFirst.cached, false);
    assert.equal(secretSecond.cached, true);
    assert.equal(requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 2);
    assert.ok(requests.every((entry) => entry.authorization === "Bearer vision-secret-key"));

    await assert.rejects(
      service.analyzePath({ path: "outside.png", question: "read it" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_PATH_INVALID",
    );
    await assert.rejects(
      service.analyzePath({ path: invalid.path, question: "read it" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_PREVIEW_UNSUPPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic Vision MCP pre-analysis is streamed and injected into the current turn context", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-vision-runtime-"));
  const workspaceDir = join(root, "workspace");
  const workspaceFiles = new WorkspaceFileService(workspaceDir);
  const visionService = new VisionService({
    workspaceFiles,
    stateDir: root,
    fetch: async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        summary: "A red status indicator on a white background.",
        observations: ["One red element"],
        ocr: ["READY"],
        uncertainties: [],
      }) } }],
    }),
  });
  visionService.patchConfig({
    mode: "auto",
    baseUrl: "https://vision.example.test/v1",
    model: "vision-test",
    apiKey: "vision-test-key",
  });
  const runtime = createTestRuntime({ seed: "vision-runtime", workspaceDir, visionService });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:vision", true);
    const character = runtime.kernel.createCharacter({ name: "测试角色", soulMarkdown: "# SOUL\n\n稳定、直接。" });
    const image = runtime.kernel.uploadWorkspaceFile({ directory: "uploads", name: "status.png", bytes: tinyPng });
    runtime.model.enqueue([{ kind: "assistant_text", text: "我看到一个红色状态指示，旁边有 READY。" }]);
    const events: string[] = [];
    const response = await runtime.kernel.streamMessage("vision-session", {
      mode: "sms",
      characterId: character.id,
      text: "这张图里有什么？",
      attachments: [{ path: image.path, name: image.name, contentType: image.contentType, size: image.size }],
    }, (event) => events.push(event.type));

    assert.equal(response.status, "completed");
    assert.ok(response.actions.some((action) =>
      action.actionType === "vision_auto_analyze" && action.status === "completed"));
    assert.ok(events.includes("tool_execution_start"));
    assert.ok(events.includes("tool_execution_end"));
    assert.ok(runtime.model.requests[0].toolNames.includes("analyze_image"));
    const providerContext = JSON.stringify(runtime.model.requests[0].messages);
    assert.match(providerContext, /red status indicator/);
    assert.match(providerContext, /untrusted_image_analysis/);
    assert.equal(providerContext.includes("vision-test-key"), false);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct vision resends a recent text-only image reference after capability is enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-vision-recovery-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({ seed: "vision-recovery", workspaceDir });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:vision", true);
    const character = runtime.kernel.createCharacter({ name: "测试角色", soulMarkdown: "# SOUL\n\n稳定、直接。" });
    const image = runtime.kernel.uploadWorkspaceFile({ directory: "uploads", name: "status.png", bytes: tinyPng });
    const attachmentText = [
      "这张图里有什么？",
      "",
      "[附件已上传到 Workspace]",
      `- status.png | workspace: ${image.path} | image/png | 1 KiB`,
    ].join("\n");
    runtime.model.enqueue([
      { kind: "assistant_text", text: "我暂时没有收到图片数据。" },
      { kind: "assistant_text", text: "我现在看到图片了。" },
      { kind: "assistant_text", text: "我仍然看得到。" },
    ]);

    const beforeEnable = await runtime.kernel.sendMessage("vision-recovery-session", {
      mode: "sms",
      characterId: character.id,
      text: attachmentText,
      attachments: [{ path: image.path, name: image.name, contentType: image.contentType, size: image.size }],
    });
    assert.equal(beforeEnable.actions.some((action) => action.actionType === "vision_direct_input"), false);
    assert.equal(JSON.stringify(runtime.model.requests[0].messages).includes('"type":"image"'), false);

    runtime.kernel.patchModelApiConfig({ visionInputEnabled: true });
    const recovered = await runtime.kernel.sendMessage("vision-recovery-session", {
      mode: "sms",
      characterId: character.id,
      text: "现在还是看不到吗？",
    });
    const recoveryAction = recovered.actions.find((action) => action.actionType === "vision_direct_input");
    assert.equal(recoveryAction?.payload.attachmentSource, "recent_turn_recovery");
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /"type":"image"/);
    assert.match(runtime.model.requests[1].systemPrompt, /sent directly to the vision-capable primary model/);
    assert.doesNotMatch(runtime.model.requests[1].systemPrompt, /Base URL or model is missing/);

    const followup = await runtime.kernel.sendMessage("vision-recovery-session", {
      mode: "sms",
      characterId: character.id,
      text: "你还看得到吗？",
    });
    assert.equal(followup.actions.some((action) => action.actionType === "vision_direct_input"), false);
    assert.equal((JSON.stringify(runtime.model.requests[2].messages).match(/"type":"image"/g) ?? []).length, 1);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
