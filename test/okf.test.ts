import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { OkfBundleError } from "../src/okf/service.js";

test("OKF adapter exports conformant selected memory and stages imports only as pending", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const character = kernel.createCharacter({ name: "林澈", soulMarkdown: "# SOUL\n\n保持克制。" });
  kernel.updateUserProfile("# 用户画像\n\n喜欢清晰的计划。");
  kernel.updateScene("okf-scene", { location: "河岸", summary: "沿河散步。" }, character.id);
  const reality = kernel.createControlPlaneMemory({
    realm: "reality",
    type: "preference",
    content: "用户更喜欢上午处理需要专注的任务。",
    sourceSessionId: "okf_test",
    sourceMessageId: "okf_reality_source",
    tags: ["planning"],
    idempotencyKey: "okf-test:reality",
  });
  const roleplay = kernel.createControlPlaneMemory({
    realm: "roleplay",
    characterId: character.id,
    type: "relationship_event",
    content: "林澈答应下次带用户去看旧车站。",
    sourceSessionId: "okf_test",
    sourceMessageId: "okf_roleplay_source",
    tags: ["promise"],
    idempotencyKey: "okf-test:roleplay",
  });
  kernel.memoryLifecycle.propose({
    realm: "reality",
    type: "goal",
    content: "这条待审核记忆不能被导出。",
    sourceSessionId: "okf_test",
    sourceMessageId: "okf_pending_source",
    idempotencyKey: "okf-test:pending",
  });

  try {
    const exported = kernel.exportOkfBundle();
    assert.equal(exported.conceptCount, 2);
    assert.match(exported.filename, /^rp-agent-memory-okf-\d{8}T\d{6}Z\.zip$/u);
    const files = unzipSync(exported.bytes);
    assert.deepEqual(Object.keys(files).sort(), [
      "index.md",
      `reality/memories/${reality.id}.md`,
      `roleplay/characters/${character.id}/memories/${roleplay.id}.md`,
    ]);
    const index = decode(files["index.md"]);
    assert.match(index, /okf_version: "0\.1"/u);
    assert.match(index, new RegExp(reality.id, "u"));
    const realityConcept = decode(files[`reality/memories/${reality.id}.md`]);
    assert.match(realityConcept, /^---\ntype: preference$/mu);
    assert.match(realityConcept, /rp_agent:/u);
    assert.match(realityConcept, /confirmed: true/u);

    const preview = kernel.previewOkfImport(exported.bytes, { realm: "auto" });
    assert.equal(preview.conforms, true);
    assert.equal(preview.conceptCount, 2);
    assert.equal(preview.readyCount, 2);
    assert.equal(preview.documents.find((entry) => entry.path.includes(roleplay.id))?.mappedCharacterId, character.id);

    const staged = kernel.stageOkfImport(exported.bytes, { realm: "auto" });
    assert.equal(staged.staged.length, 2);
    assert.ok(staged.staged.every((memory) => memory.validity === "pending" && !memory.confirmed));
    const retried = kernel.stageOkfImport(exported.bytes, { realm: "auto" });
    assert.deepEqual(retried.staged.map((memory) => memory.id), staged.staged.map((memory) => memory.id));

    const sensitive = kernel.exportOkfBundle({ includeProfile: true, includeSouls: true, includeScenes: true });
    assert.equal(sensitive.conceptCount, 5);
    const sensitiveFiles = Object.keys(unzipSync(sensitive.bytes));
    assert.ok(sensitiveFiles.includes("reality/user-profile.md"));
    assert.ok(sensitiveFiles.includes(`roleplay/characters/${character.id}/SOUL.md`));
    assert.ok(sensitiveFiles.includes("roleplay/scenes/okf-scene.md"));
  } finally {
    kernel.dispose();
  }
});

test("OKF validation rejects malformed archives and leaves unknown concepts unsupported", () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  try {
    const unknown = zipSync({
      "index.md": strToU8("# References\n\n* [Runbook](runbook.md) - Test\n"),
      "runbook.md": strToU8("---\ntype: Playbook\ntitle: Runbook\n---\n# Steps\n\nDo the safe thing.\n"),
    });
    const preview = kernel.previewOkfImport(unknown, { realm: "auto" });
    assert.equal(preview.conforms, true);
    assert.equal(preview.readyCount, 0);
    assert.equal(preview.unsupportedCount, 1);
    assert.match(preview.documents.find((entry) => entry.path === "runbook.md")?.reason ?? "", /not a reality memory type/u);
    assert.throws(
      () => kernel.stageOkfImport(unknown, { realm: "auto" }),
      (error: unknown) => error instanceof OkfBundleError && error.code === "OKF_NO_IMPORTABLE_CONCEPTS",
    );

    const missingType = zipSync({ "fact.md": strToU8("---\ntitle: Missing type\n---\nBody\n") });
    const invalid = kernel.previewOkfImport(missingType, { realm: "auto" });
    assert.equal(invalid.conforms, false);
    assert.equal(invalid.documents[0].status, "invalid");
    assert.throws(
      () => kernel.stageOkfImport(missingType, { realm: "auto" }),
      (error: unknown) => error instanceof OkfBundleError && error.code === "OKF_NOT_CONFORMANT",
    );

    const wrapped = zipSync({
      "my-bundle/index.md": strToU8("---\nokf_version: \"0.1\"\n---\n# Facts\n\n* [Fact](fact.md) - Wrapped\n"),
      "my-bundle/fact.md": strToU8("---\ntype: user-fact\ntitle: Wrapped fact\n---\nA wrapped bundle still imports.\n"),
    });
    const wrappedPreview = kernel.previewOkfImport(wrapped, { realm: "auto" });
    assert.equal(wrappedPreview.conforms, true);
    assert.equal(wrappedPreview.documents.some((entry) => entry.path === "fact.md" && entry.status === "ready"), true);

    const brokenIndex = zipSync({
      "index.md": strToU8("---\nokf_version: \"0.1\"\n# Missing delimiter\n"),
      "fact.md": strToU8("---\ntype: user_fact\n---\nFact\n"),
    });
    const brokenIndexPreview = kernel.previewOkfImport(brokenIndex, { realm: "auto" });
    assert.equal(brokenIndexPreview.conforms, false);
    assert.equal(brokenIndexPreview.documents.find((entry) => entry.path === "index.md")?.status, "invalid");

    const traversal = zipSync({ "../escape.md": strToU8("---\ntype: user_fact\n---\nNope\n") });
    assert.throws(
      () => kernel.previewOkfImport(traversal, { realm: "auto" }),
      (error: unknown) => error instanceof OkfBundleError && error.code === "OKF_ARCHIVE_PATH_INVALID",
    );
  } finally {
    kernel.dispose();
  }
});

test("OKF HTTP routes download, preview, and idempotently stage a ZIP", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  kernel.createControlPlaneMemory({
    realm: "reality",
    type: "user_fact",
    content: "用户在上海时使用 Asia/Shanghai 时区。",
    sourceSessionId: "okf_http",
    sourceMessageId: "okf_http_source",
    idempotencyKey: "okf-http:active",
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    const exported = await fetch(`${baseUrl}/api/v1/memory-vault/okf/export`);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/zip");
    assert.equal(exported.headers.get("x-okf-version"), "0.1");
    assert.match(exported.headers.get("content-disposition") ?? "", /rp-agent-memory-okf-.*\.zip/u);
    const bytes = new Uint8Array(await exported.arrayBuffer());

    const previewResponse = await fetch(`${baseUrl}/api/v1/memory-vault/okf/import/preview?realm=auto`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bytes,
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { preview: { conforms: boolean; readyCount: number } };
    assert.deepEqual(preview.preview, { ...preview.preview, conforms: true, readyCount: 1 });

    const stageResponse = await fetch(`${baseUrl}/api/v1/memory-vault/okf/import/stage?realm=auto`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: bytes,
    });
    assert.equal(stageResponse.status, 201);
    const staged = (await stageResponse.json()) as { staged: Array<{ validity: string; confirmed: boolean }> };
    assert.deepEqual(staged.staged.map((memory) => [memory.validity, memory.confirmed]), [["pending", false]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

function decode(value: Uint8Array | undefined): string {
  assert.ok(value);
  return new TextDecoder().decode(value);
}

function addressOf(server: ReturnType<typeof createHttpServer>): string {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
