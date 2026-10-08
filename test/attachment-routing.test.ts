import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { DocumentConversionService } from "../src/document/index.js";
import { createTestRuntime } from "../src/testing/index.js";
import { VisionService } from "../src/vision/service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const officeBytes = Buffer.from(zipSync({ "ppt/presentation.xml": strToU8("<presentation/>") }));
const attachmentText = (paths: string[]) => "请查看附件。\n\n[附件已上传到 Workspace]\n" +
  paths.map(path => `- 文件 | workspace: ${path} | application/octet-stream`).join("\n");

for (const mode of ["direct", "mcp"] as const) {
  test(`${mode} vision leaves documents for read_document and selects only images from mixed uploads`, async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "yourchar-attachment-routing-"));
    let visionCalls = 0;
    const documentPaths: string[] = [];
    const visionService = new VisionService({
      workspaceFiles: new WorkspaceFileService(workspaceDir),
      fetch: async () => {
        visionCalls += 1;
        return Response.json({ choices: [{ message: { content: '{"summary":"Visible pixel"}' } }] });
      },
    });
    visionService.patchConfig({ mode, maxImages: 1, baseUrl: "https://vision.example.test/v1", model: "vision" });
    const runtime = createTestRuntime({
      workspaceDir, visionService,
      documentService: new DocumentConversionService({ runner: async ({ absolutePath }) => {
        documentPaths.push(absolutePath);
        return { version: 1, engine: "markitdown", markdown: "课件正文：变量与数据类型。" };
      } }),
    });
    try {
      const kernel = runtime.kernel;
      kernel.setAgentModuleEnabled("mcp:vision", true);
      kernel.patchModelApiConfig({ visionInputEnabled: true });
      const character = kernel.createCharacter({ name: "附件分类测试" });
      const documents = [
        { name: "lecture.pptx", bytes: officeBytes },
        { name: "notes.pdf", bytes: Buffer.from("%PDF-1.4\nfixture") },
        { name: "notes.docx", bytes: officeBytes },
        { name: "table.xlsx", bytes: officeBytes },
        { name: "notes.txt", bytes: Buffer.from("ordinary text") },
      ].map(file => kernel.uploadWorkspaceFile(file));
      runtime.model.enqueue([
        { kind: "tool_call", name: "read_document", arguments: { path: documents[0].path } },
        { kind: "assistant_text", text: "我读到了课件正文。" },
        { kind: "assistant_text", text: "这份附件是文档。" },
        { kind: "assistant_text", text: "收到了文档和图片。" },
      ]);
      const response = await kernel.sendMessage("documents", {
        mode: "sms", characterId: character.id,
        text: attachmentText(documents.map(file => file.path)),
        attachments: documents,
      });
      assert.equal(response.status, "completed");
      assert.equal(visionCalls, 0);
      assert.equal(response.actions.some(action => action.actionType.startsWith("vision_")), false);
      assert.equal(response.actions.find(action => action.actionType === "read_document")?.status, "completed");
      assert.equal(documentPaths.length, 1);
      assert.match(JSON.stringify(runtime.model.requests.at(-1)?.messages), /课件正文/);
      assert.doesNotMatch(JSON.stringify(runtime.model.requests), /"type":"image"|Uploaded image attachments are present/);

      // Legacy transcript markers must not recover a document as an image.
      const followup = await kernel.sendMessage("documents", {
        mode: "sms", characterId: character.id, text: "现在还是看不到吗？",
      });
      assert.equal(followup.status, "completed");
      assert.equal(followup.actions.some(action => action.actionType.startsWith("vision_")), false);
      assert.equal(visionCalls, 0);

      const image = kernel.uploadWorkspaceFile({ name: "pixel.bin", bytes: tinyPng });
      const mixed = await kernel.sendMessage("mixed-attachments", {
        mode: "sms", characterId: character.id,
        text: attachmentText([documents[0].path, image.path]),
        // Client MIME labels are not authoritative in either direction.
        attachments: [{ ...documents[0], contentType: "image/png" }, { ...image, contentType: "application/octet-stream" }],
      });
      assert.equal(mixed.status, "completed");
      const actions = mixed.actions.filter(action => action.actionType.startsWith("vision_"));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].status, "completed");
      assert.deepEqual(mode === "direct" ? actions[0].payload.paths : [actions[0].payload.path], [image.path]);
      assert.equal(visionCalls, mode === "mcp" ? 1 : 0);
      assert.equal((JSON.stringify(runtime.model.requests.at(-1)?.messages).match(/"type":"image"/g) ?? []).length,
        mode === "direct" ? 1 : 0);
    } finally {
      runtime.dispose();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
}

test("legacy text-only file attachments bypass direct image validation", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "yourchar-legacy-document-"));
  const runtime = createTestRuntime({ workspaceDir });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:vision", true);
    runtime.kernel.patchVisionConfig({ mode: "direct" });
    runtime.kernel.patchModelApiConfig({ visionInputEnabled: true });
    const file = runtime.kernel.uploadWorkspaceFile({ name: "lecture.pptx", bytes: officeBytes });
    runtime.model.enqueue([{ kind: "assistant_text", text: "收到了课件。" }]);
    const response = await runtime.kernel.sendMessage("legacy-document", {
      mode: "sms", text: attachmentText([file.path]),
    });
    assert.equal(response.status, "completed");
    assert.equal(response.actions.some(action => action.actionType.startsWith("vision_")), false);
    assert.doesNotMatch(JSON.stringify(runtime.model.requests[0].messages), /"type":"image"/);
  } finally {
    runtime.dispose();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
