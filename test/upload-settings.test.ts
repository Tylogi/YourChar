import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.js";
import { UploadSettingsService, UploadSettingsValidationError } from "../src/workspace/upload-settings.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceScopeRegistry } from "../src/workspace/scope.js";
import { TaskBenchUploadRegistry } from "../src/evaluation/task-bench-uploads.js";
import { DocumentConversionService } from "../src/document/index.js";

const MiB = 1024 * 1024;

test("upload limits default to 100 MiB, validate input, and persist across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-upload-settings-"));
  let database = new AppDatabase(join(root, "settings.sqlite"));
  try {
    const settings = new UploadSettingsService(database);
    assert.equal(settings.get().maxFileBytes, 100 * MiB);
    for (const invalid of [0, -1, 1.5, 1025, NaN, Infinity, "100", null]) {
      assert.throws(() => settings.set(invalid), UploadSettingsValidationError);
    }
    assert.equal(settings.get().maxFileMiB, 100);
    settings.set(150);
    database.close();
    database = new AppDatabase(join(root, "settings.sqlite"));
    assert.equal(new UploadSettingsService(database).get().maxFileBytes, 150 * MiB);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("uploads accept the exact limit and live settings apply to normal, secret, and task bench files", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-upload-boundaries-"));
  const database = new AppDatabase(":memory:");
  const settings = new UploadSettingsService(database);
  const files = new WorkspaceFileService(join(root, "workspace"), () => settings.get().maxFileBytes);
  const scopes = new WorkspaceScopeRegistry(files.rootDir, files);
  const secret = scopes.resolve({ conversationSpace: "secret", characterId: "character-a" });
  const bench = new TaskBenchUploadRegistry(undefined, () => settings.get().maxFileBytes);
  try {
    const large = Buffer.alloc(100 * MiB + 1);
    assert.equal(files.upload({ name: "boundary.bin", bytes: large.subarray(0, 100 * MiB) }).size, 100 * MiB);
    assert.throws(() => files.upload({ name: "over.bin", bytes: large }), /100 MiB/);
    settings.set(1);
    for (const service of [files, secret.files]) {
      assert.equal(service.upload({ name: "small.bin", bytes: large.subarray(0, MiB) }).size, MiB);
      assert.throws(() => service.upload({ name: "too-big.bin", bytes: large.subarray(0, MiB + 1) }), /1 MiB/);
    }
    assert.throws(() => bench.add({ name: "large.bin", bytes: large.subarray(0, MiB + 1) }), /1 MiB/);
    settings.set(25);
    assert.equal(bench.add({ name: "accepted.bin", bytes: large.subarray(0, 21 * MiB) }).size, 21 * MiB);
    assert.equal(secret.files.maximumUploadBytes, 25 * MiB);
  } finally { bench.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("document conversion accepts inputs above 20 MiB and enforces the current upload setting", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-document-limit-"));
  let limit = 100 * MiB;
  const files = new WorkspaceFileService(root, () => limit);
  let calls = 0;
  const documents = new DocumentConversionService({ runner: async () => {
    calls += 1;
    return { version: 1, engine: "markitdown", markdown: "Converted large document." };
  } });
  try {
    const file = files.upload({ name: "large.html", bytes: Buffer.alloc(21 * MiB, 32) });
    const result = await documents.read({ path: file.path }, { workspaceFiles: files, cacheNamespace: "normal" });
    assert.match(result.markdown, /Converted large document/);
    limit = MiB;
    await assert.rejects(documents.read({ path: file.path }, { workspaceFiles: files, cacheNamespace: "normal" }), /large|limit|MiB/i);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
