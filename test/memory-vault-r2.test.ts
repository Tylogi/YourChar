import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import {
  MemoryVaultCasError,
  MemoryVaultError,
  MemoryVaultPaths,
  parseVaultMarkdown,
  serializeVaultMarkdown,
} from "../src/memory-vault/index.js";
import { UserProfileValidationError } from "../src/profile/service.js";
import { CharacterSoulValidationError } from "../src/rp/soul.js";
import type { RpMemory } from "../src/rp/types.js";
import { AppDatabase } from "../src/storage/database.js";
import { ScriptedModelController } from "../src/testing/runtime.js";

const now = "2026-07-16T08:00:00.000Z";

test("Vault layout, strict frontmatter, stable roundtrip, and 0600 writes", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-layout-"));
  const kernel = createKernel(stateDir, "layout");
  try {
    kernel.updateUserProfile("# 用户画像\n\n- 喜欢清晰的回复");
    const character = kernel.createCharacter({ name: "林澈", soulMarkdown: "# SOUL.md\n\n保持克制。" });
    kernel.updateScene("vault-layout-session", { location: "旧车站", summary: "等待末班车" }, character.id);
    const memory = kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "plot_event",
      content: "末班车将在午夜抵达",
      characterId: character.id,
      confirmed: true,
      sourceSessionId: "vault-layout-session",
      sourceMessageId: "message_1",
      tags: ["train", "night"],
    }).memory!;

    const root = join(stateDir, "memory-vault");
    for (const directory of [
      "reality",
      "reality/people",
      `roleplay/characters/${character.id}`,
      "roleplay/scenes",
      "legacy/quarantine",
      "archive",
    ]) assert.equal(statSync(join(root, directory)).mode & 0o777, 0o700);
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /Obsidian vault/);
    assert.equal(existsSync(join(root, "rp-agent.sqlite")), false);
    assert.equal(existsSync(join(root, "model-api.json")), false);
    assert.equal(existsSync(join(root, "pi-sessions")), false);

    const memoryPath = join(root, "roleplay", "characters", character.id, "memories", `${memory.id}.md`);
    const source = readFileSync(memoryPath, "utf8");
    const document = parseVaultMarkdown(source, `roleplay/characters/${character.id}/memories/${memory.id}.md`);
    assert.equal(serializeVaultMarkdown(document.metadata, document.body), source);
    assert.equal(document.metadata.schemaVersion, 4);
    assert.equal(document.metadata.realm, "roleplay");
    assert.equal(document.metadata.scope, "character");
    assert.equal(document.metadata.sourceSessionId, "vault-layout-session");
    assert.equal(document.metadata.sourceMessageId, "message_1");
    assert.equal(document.metadata.revision, 1);
    assert.equal(document.externalModified, false);
    assert.equal(statSync(memoryPath).mode & 0o777, 0o600);

    const scenePath = join(root, "roleplay", "scenes", "vault-layout-session.md");
    writeFileSync(scenePath, replaceBody(readFileSync(scenePath, "utf8"), "Obsidian 推进了场景"), { mode: 0o600 });
    assert.equal(kernel.getScene("vault-layout-session").summary, "Obsidian 推进了场景");
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("whole-document CAS rejects unsynchronized edits and safe reads establish a new audited baseline", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-cas-"));
  const kernel = createKernel(stateDir, "cas");
  try {
    kernel.updateUserProfile("# 用户画像\n\n- 初始内容");
    kernel.updateUserProfile("# 用户画像\n\n- 正常 API 更新");
    const path = join(stateDir, "memory-vault", "reality", "user-profile.md");

    const frontmatterEdited = readFileSync(path, "utf8").replace("tags: []", "tags:\n  - obsidian");
    assert.notEqual(frontmatterEdited, readFileSync(path, "utf8"));
    writeFileSync(path, frontmatterEdited, { mode: 0o600 });
    assert.throws(
      () => kernel.updateUserProfile("# 用户画像\n\n- 不得覆盖 frontmatter 外改"),
      MemoryVaultCasError,
    );
    assert.equal(kernel.getMemoryVaultStatus().inSync, false);
    kernel.syncMemoryVault();
    assert.doesNotThrow(() => kernel.updateUserProfile("# 用户画像\n\n- sync 后可更新"));

    const bodyEdited = replaceBody(readFileSync(path, "utf8"), "# 用户画像\n\n- Obsidian 正文外改");
    writeFileSync(path, bodyEdited, { mode: 0o600 });
    assert.match(kernel.getUserProfile().markdown, /Obsidian 正文外改/);
    assert.ok(kernel.store.allActions().some((action) =>
      action.actionType === "memory_vault_auto_sync" &&
      JSON.stringify(action.payload).includes("reality/user-profile.md")
    ));
    assert.doesNotThrow(() => kernel.updateUserProfile("# 用户画像\n\n- 安全读取同步后更新"));

    const character = kernel.createCharacter({ name: "CAS 角色" });
    const memory = kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      content: "钟楼指针停在十一点",
      characterId: character.id,
      confirmed: true,
    }).memory!;
    const pathForMemory = memoryPath(stateDir, character.id, memory.id);
    writeFileSync(
      pathForMemory,
      readFileSync(pathForMemory, "utf8").replace("tags: []", "tags:\n  - frontmatter-only"),
    );
    assert.throws(
      () => kernel.updateRpMemory(memory.id, { content: "不得覆盖外改" }),
      MemoryVaultCasError,
    );
    kernel.syncMemoryVault();
    assert.doesNotThrow(() => kernel.updateRpMemory(memory.id, { content: "同步后允许更新" }));
    rmSync(pathForMemory);
    assert.throws(() => kernel.updateRpMemory(memory.id, { content: "不得复活已删除文件" }), MemoryVaultCasError);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("external profile and SOUL edits remain subject to service size limits", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-limits-"));
  const kernel = createKernel(stateDir, "limits");
  try {
    kernel.updateUserProfile("profile");
    const profilePath = join(stateDir, "memory-vault", "reality", "user-profile.md");
    writeFileSync(profilePath, replaceBody(readFileSync(profilePath, "utf8"), "界".repeat(2_001)), { mode: 0o600 });
    assert.throws(() => kernel.getUserProfile(), UserProfileValidationError);
    assert.throws(() => kernel.syncMemoryVault(), UserProfileValidationError);
    writeFileSync(profilePath, replaceBody(readFileSync(profilePath, "utf8"), "valid profile"), { mode: 0o600 });
    kernel.syncMemoryVault();
    const character = kernel.createCharacter({ name: "边界角色", soulMarkdown: "short soul" });
    const soulPath = join(stateDir, "memory-vault", "roleplay", "characters", character.id, "SOUL.md");
    writeFileSync(soulPath, replaceBody(readFileSync(soulPath, "utf8"), "界".repeat(8_001)), { mode: 0o600 });
    assert.throws(() => kernel.getCharacter(character.id), CharacterSoulValidationError);
    assert.throws(() => kernel.syncMemoryVault(), CharacterSoulValidationError);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("invalid YAML, duplicate IDs, traversal, and symlinks are rejected", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-security-"));
  const kernel = createKernel(stateDir, "security");
  try {
    const root = join(stateDir, "memory-vault");
    const profilePath = join(root, "reality", "user-profile.md");
    const original = readFileSync(profilePath, "utf8");
    const duplicatePath = join(root, "archive", "duplicate.md");
    copyFileSync(profilePath, duplicatePath);
    assert.throws(
      () => kernel.listMemoryVaultDocuments(),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_DUPLICATE_ID",
    );
    rmSync(duplicatePath);

    writeFileSync(profilePath, original.replace("id: user-profile", "id: user-profile\nid: duplicate"));
    assert.throws(
      () => kernel.listMemoryVaultDocuments(),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_INVALID_DOCUMENT",
    );
    writeFileSync(profilePath, original);

    const link = join(root, "archive", "outside.md");
    symlinkSync("/etc/passwd", link);
    assert.throws(
      () => kernel.listMemoryVaultDocuments(),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_PATH_INVALID",
    );
    rmSync(link);
    assert.throws(
      () => new MemoryVaultPaths(stateDir).resolveRelative("../escape.md"),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_PATH_INVALID",
    );
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("SQLite rebuild rolls back after a mid-transaction projection failure", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-rebuild-"));
  const kernel = createKernel(stateDir, "rebuild");
  try {
    const character = kernel.createCharacter({ name: "投影角色" });
    for (const sessionId of ["rebuild_a", "rebuild_b"]) {
      kernel.updateScene(sessionId, { summary: `stable-${sessionId}` }, character.id);
    }
    const before = kernel.rpService.repository.listScenes();
    const sceneFiles = ["rebuild_a", "rebuild_b"].map(
      (sessionId) => join(stateDir, "memory-vault", "roleplay", "scenes", `${sessionId}.md`),
    );
    for (const path of sceneFiles) {
      const relative = `roleplay/scenes/${path.endsWith("rebuild_a.md") ? "rebuild_a" : "rebuild_b"}.md`;
      const document = parseVaultMarkdown(readFileSync(path, "utf8"), relative);
      writeFileSync(path, serializeVaultMarkdown({ ...document.metadata, idempotencyKey: "duplicate_tool_call" }, document.body));
    }
    assert.throws(
      () => kernel.rebuildMemoryVaultIndex(),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_REBUILD_FAILED",
    );
    assert.deepEqual(kernel.rpService.repository.listScenes(), before);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("two-document memory correction restores its checkpoint when rebuild fails", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-pair-"));
  const kernel = createKernel(stateDir, "pair");
  try {
    const character = kernel.createCharacter({ name: "修正角色" });
    const previous = kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "station.color",
      content: "车站大门是蓝色",
      characterId: character.id,
      confirmed: true,
    }).memory!;
    const previousPath = memoryPath(stateDir, character.id, previous.id);
    const before = readFileSync(previousPath, "utf8");

    const unknownId = "memory_unknown_projection";
    const unknownPath = memoryPath(stateDir, "missing_character", unknownId);
    mkdirSync(join(unknownPath, ".."), { recursive: true });
    writeFileSync(
      unknownPath,
      before
        .replace(`id: ${previous.id}`, `id: ${unknownId}`)
        .replace(`characterId: ${character.id}`, "characterId: missing_character"),
      { mode: 0o600 },
    );

    const replacement: RpMemory = {
      ...previous,
      id: "memory_pair_replacement",
      content: "车站大门是红色",
      normalizedContent: "车站大门是红色",
      createdAt: now,
      updatedAt: now,
    };
    assert.throws(
      () => kernel.memoryVault.writeMemoryPair(replacement, {
        ...previous,
        validity: "superseded",
        supersededById: replacement.id,
        updatedAt: now,
      }),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_REBUILD_FAILED",
    );
    assert.equal(readFileSync(previousPath, "utf8"), before);
    assert.equal(existsSync(memoryPath(stateDir, character.id, replacement.id)), false);
    assert.equal(kernel.rpService.repository.getMemory(previous.id)?.validity, "active");
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("profile deletion restores the Markdown checkpoint when another document blocks rebuild", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-delete-profile-"));
  const kernel = createKernel(stateDir, "delete-profile");
  try {
    kernel.updateUserProfile("# 用户画像\n\n- 不得因其他坏投影丢失");
    const character = kernel.createCharacter({ name: "画像回滚角色" });
    const memory = kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      content: "用于构造合法但不可投影的文档",
      characterId: character.id,
      confirmed: true,
    }).memory!;
    injectUnknownCharacterMemory(stateDir, character.id, memory.id, "memory_profile_delete_blocker");

    const profilePath = join(stateDir, "memory-vault", "reality", "user-profile.md");
    const before = readFileSync(profilePath, "utf8");
    assert.throws(
      () => kernel.memoryVault.deleteProfile(),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_REBUILD_FAILED",
    );
    assert.equal(readFileSync(profilePath, "utf8"), before);
    assert.match(kernel.memoryVault.getProfile()!.markdown, /不得因其他坏投影丢失/);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("scene deletion restores Markdown and SQLite when rebuild preflight fails", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-delete-scene-"));
  const kernel = createKernel(stateDir, "delete-scene");
  try {
    const character = kernel.createCharacter({ name: "场景回滚角色" });
    kernel.updateScene("scene_delete_rollback", {
      location: "钟楼",
      summary: "删除失败后仍应存在",
    }, character.id);
    const memory = kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "plot_event",
      content: "用于触发重建失败",
      characterId: character.id,
      confirmed: true,
    }).memory!;
    injectUnknownCharacterMemory(stateDir, character.id, memory.id, "memory_scene_delete_blocker");

    const scenePath = join(stateDir, "memory-vault", "roleplay", "scenes", "scene_delete_rollback.md");
    const beforeFile = readFileSync(scenePath, "utf8");
    const beforeProjection = kernel.rpService.repository.getScene("scene_delete_rollback");
    assert.throws(
      () => kernel.memoryVault.removeScene("scene_delete_rollback"),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_REBUILD_FAILED",
    );
    assert.equal(readFileSync(scenePath, "utf8"), beforeFile);
    assert.deepEqual(kernel.rpService.repository.getScene("scene_delete_rollback"), beforeProjection);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("multi-memory touch rolls back earlier revisions when a later CAS fails", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-touch-"));
  const kernel = createKernel(stateDir, "touch-rollback");
  try {
    const character = kernel.createCharacter({ name: "Touch 回滚角色" });
    const memories = ["第一条可触达记忆", "第二条发生外部修改"].map((content) => kernel.writeRpMemory({
      realm: "roleplay" as const,
      scope: "character" as const,
      type: "relationship_event" as const,
      content,
      characterId: character.id,
      confirmed: true,
    }).memory!);
    const paths = memories.map((memory) => memoryPath(stateDir, character.id, memory.id));
    const firstBefore = readFileSync(paths[0], "utf8");
    const secondExternal = readFileSync(paths[1], "utf8").replace(
      "tags: []",
      "tags:\n  - external-touch-conflict",
    );
    writeFileSync(paths[1], secondExternal, { mode: 0o600 });

    assert.throws(
      () => kernel.memoryVault.touchMemories(memories.map((memory) => memory.id)),
      MemoryVaultCasError,
    );
    assert.equal(readFileSync(paths[0], "utf8"), firstBefore);
    assert.equal(readFileSync(paths[1], "utf8"), secondExternal);
    assert.equal(kernel.rpService.repository.getMemory(memories[0].id)?.lastUsedAt, undefined);
    assert.equal(kernel.rpService.repository.getMemory(memories[1].id)?.lastUsedAt, undefined);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("legacy migration is idempotent, quarantined, and does not resurrect deleted Vault files", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-migration-"));
  seedLegacyMemory(stateDir);
  let kernel = createKernel(stateDir, "migration");
  try {
    const quarantinePath = join(stateDir, "memory-vault", "legacy", "quarantine", "legacy_global.md");
    assert.equal(existsSync(quarantinePath), true);
    const quarantined = parseVaultMarkdown(readFileSync(quarantinePath, "utf8"), "legacy/quarantine/legacy_global.md");
    assert.equal(quarantined.metadata.realm, "legacy");
    assert.equal(quarantined.metadata.scope, "quarantine");
    assert.deepEqual(quarantined.metadata.quarantineReasons, ["disallowed_profile_type", "missing_character"]);
    assert.equal(quarantined.metadata.validity, "active");
    assert.equal(quarantined.metadata.sourceSessionId, "legacy_session");

    const dryRun = kernel.dryRunMemoryVaultMigration();
    assert.equal(dryRun.items.every((item) => item.action === "unchanged"), true);
    const revision = quarantined.metadata.revision;
    const applied = kernel.applyMemoryVaultMigration();
    assert.equal(applied.status, "complete");
    assert.equal(
      parseVaultMarkdown(readFileSync(quarantinePath, "utf8"), "legacy/quarantine/legacy_global.md").metadata.revision,
      revision,
    );

    rmSync(quarantinePath);
    kernel.dispose();
    kernel = createKernel(stateDir, "migration-restart");
    assert.equal(kernel.rpService.listAllMemories().some((memory) => memory.id === "legacy_global"), false);
    assert.equal(existsSync(quarantinePath), false);
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backup/restore and delete-all include Vault without provider metadata leakage", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-vault-lifecycle-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  let kernel = createKernel(stateDir, "lifecycle");
  try {
    kernel.updateUserProfile("# 用户画像\n\nVAULT_PROFILE_BODY");
    const character = kernel.createCharacter({ name: "生命周期角色", soulMarkdown: "# SOUL\n\nVAULT_SOUL_BODY" });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      content: "VAULT_MEMORY_BODY",
      characterId: character.id,
      confirmed: true,
    });
    const vaultSnapshot = Object.fromEntries(kernel.listMemoryVaultDocuments().map((document) => [
      document.path,
      readFileSync(join(stateDir, "memory-vault", document.path), "utf8"),
    ]));
    const projectionSnapshot = readFileSync(join(stateDir, "memory-vault-state.json"), "utf8");
    const migrationSnapshot = readFileSync(join(stateDir, "memory-vault-migration.json"), "utf8");
    kernel.dispose();

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], { cwd: process.cwd() });
    assert.equal(existsSync(join(backupDir, "memory-vault", "README.md")), true);
    assert.equal(existsSync(join(backupDir, "memory-vault-state.json")), true);
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], { cwd: process.cwd() });
    for (const [relativePath, source] of Object.entries(vaultSnapshot)) {
      assert.equal(readFileSync(join(restoredDir, "memory-vault", relativePath), "utf8"), source);
    }
    assert.equal(readFileSync(join(restoredDir, "memory-vault-state.json"), "utf8"), projectionSnapshot);
    assert.equal(readFileSync(join(restoredDir, "memory-vault-migration.json"), "utf8"), migrationSnapshot);

    const model = new ScriptedModelController("vault-provider-leak");
    model.enqueue([{ kind: "assistant_text", text: "继续。" }]);
    kernel = new CompanionKernel({
      stateDir: restoredDir,
      clock: new VirtualClock(now),
      modelResolver: model.resolver,
      startScheduler: false,
      quietHours: false,
    });
    kernel.patchModelApiConfig({ enabled: true, baseUrl: "http://test.invalid/v1", model: "scripted" });
    await kernel.sendMessage("vault-provider-session", {
      mode: "sms",
      characterId: character.id,
      text: "继续",
    });
    const provider = `${model.requests[0].systemPrompt}\n${JSON.stringify(model.requests[0].messages)}`;
    assert.match(provider, /VAULT_PROFILE_BODY|VAULT_SOUL_BODY|VAULT_MEMORY_BODY/);
    assert.doesNotMatch(provider, new RegExp(restoredDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(provider, /schemaVersion:|contentHash:|quarantineReasons:|memory-vault-state/);

    kernel.deleteAllUserData();
    assert.equal(kernel.listMemoryVaultDocuments().length, 0);
    assert.equal(existsSync(join(restoredDir, "memory-vault", "reality")), true);
    assert.equal(existsSync(join(restoredDir, "memory-vault", "legacy", "quarantine")), true);
  } finally {
    kernel.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vault HTTP status, list, sync, rebuild, migration, CAS errors, and UI controls are usable", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-vault-api-"));
  const kernel = createKernel(stateDir, "api");
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const status = await jsonRequest(`${base}/api/v1/memory-vault/status`);
    assert.equal(status.response.status, 200);
    assert.equal((status.body as { vault: { rootPath: string } }).vault.rootPath, join(stateDir, "memory-vault"));

    const documents = await jsonRequest(`${base}/api/v1/memory-vault/documents`);
    assert.equal(documents.response.status, 200);
    assert.equal(JSON.stringify(documents.body).includes("# 用户画像"), false);
    for (const action of ["sync", "rebuild", "migration/dry-run", "migration/apply"]) {
      const result = await jsonRequest(`${base}/api/v1/memory-vault/${action}`, { method: "POST" });
      assert.equal(result.response.status, 200, action);
    }

    const profilePath = join(stateDir, "memory-vault", "reality", "user-profile.md");
    writeFileSync(profilePath, readFileSync(profilePath, "utf8").replace("tags: []", "tags:\n  - api-external"));
    const conflict = await jsonRequest(`${base}/api/v1/user-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "must conflict" }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal((conflict.body as { code: string }).code, "MEMORY_VAULT_CAS_CONFLICT");

    const html = await (await fetch(`${base}/ui`)).text();
    assert.match(html, /id="memoryVaultPath"/);
    assert.match(html, /id="syncMemoryVaultBtn"/);
    assert.match(html, /id="rebuildMemoryVaultBtn"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function createKernel(stateDir: string, seed: string): CompanionKernel {
  return new CompanionKernel({
    stateDir,
    clock: new VirtualClock(now),
    idGenerator: new SeededIdGenerator(seed),
    startScheduler: false,
    quietHours: false,
  });
}

function replaceBody(source: string, body: string): string {
  const end = source.indexOf("\n---\n", 4);
  assert.notEqual(end, -1);
  return `${source.slice(0, end + 5)}${body}`;
}

function memoryPath(stateDir: string, characterId: string, id: string): string {
  return join(stateDir, "memory-vault", "roleplay", "characters", characterId, "memories", `${id}.md`);
}

function injectUnknownCharacterMemory(
  stateDir: string,
  sourceCharacterId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
): string {
  const source = readFileSync(memoryPath(stateDir, sourceCharacterId, sourceMemoryId), "utf8");
  const targetPath = memoryPath(stateDir, "missing_character", targetMemoryId);
  mkdirSync(join(targetPath, ".."), { recursive: true });
  writeFileSync(
    targetPath,
    source
      .replace(`id: ${sourceMemoryId}`, `id: ${targetMemoryId}`)
      .replace(`characterId: ${sourceCharacterId}`, "characterId: missing_character"),
    { mode: 0o600 },
  );
  return targetPath;
}

function seedLegacyMemory(stateDir: string): void {
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  database.connection.prepare(`
    INSERT INTO rp_memories(
      id, type, memory_key, content, normalized_content, source_session_id,
      source_message_id, character_id, salience, confidence, validity,
      confirmed, tags_json, superseded_by_id, idempotency_key,
      created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    "legacy_global", "user_fact", "user.city", "用户来自旧城", "用户来自旧城",
    "legacy_session", "legacy_message", 0.8, 0.9, "active", 1, JSON.stringify(["legacy"]),
    "legacy_idempotency", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "2025-01-03T00:00:00.000Z",
  );
  database.connection.prepare("INSERT INTO rp_memories_fts(memory_id, content, tags) VALUES (?, ?, ?)")
    .run("legacy_global", "用户来自旧城", "legacy");
  database.close();

  const raw = new DatabaseSync(join(stateDir, "rp-agent.sqlite"), { readOnly: true });
  raw.close();
}

async function jsonRequest(url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, init);
  return { response, body: await response.json() };
}
