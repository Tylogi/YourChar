import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime } from "../src/testing/runtime.js";
import { VisionService } from "../src/vision/service.js";
import { WorkspaceFileError, WorkspaceFileService } from "../src/workspace/file-service.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
    const config = service.patchConfig({
      mode: "mcp",
      baseUrl: "https://vision.example.test/v1/chat/completions",
      model: "vision-a",
      apiKey: "vision-secret-key",
      detail: "high",
      maxImages: 3,
    });
    assert.equal(config.apiKeyMasked, "visi...-key");
    assert.equal(JSON.stringify(config).includes("vision-secret-key"), false);
    assert.match(readFileSync(join(root, "vision.json"), "utf8"), /vision-secret-key/);
    assert.deepEqual(await service.discoverModels(), ["vision-a", "vision-b"]);

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
