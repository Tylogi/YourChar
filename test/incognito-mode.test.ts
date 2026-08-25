import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  CompanionKernel,
  IncognitoConversationNotFoundError,
  IncognitoSessionManager,
  isIncognitoSessionId,
} from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { relationshipStateMcpModuleId } from "../src/modules/catalog.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/runtime.js";

const tmpfsRoot = "/dev/shm";
const snapshotPrefix = "yourchar-incognito-";

test("incognito inherits a stable transcript, supports meetings, and leaves parent state unchanged", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-state-"));
  const runtime = createTestRuntime({
    stateDir,
    seed: "incognito-inheritance",
    relationshipExtractor: async () => ({
      significant: true,
      eventType: "support",
      impact: "moderate",
      summary: "RELATIONSHIP_INHERITANCE_SENTINEL",
      confidence: 1,
    }),
  });
  try {
    const character = runtime.kernel.createCharacter({
      name: "真由理",
      soulMarkdown: "# 真由理\n\nSOUL_INHERITANCE_SENTINEL",
    });
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
    });
    runtime.kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      content: "MEMORY_INHERITANCE_SENTINEL 海边约定",
      characterId: character.id,
      confirmed: true,
    });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "这是持久基线回复" }]);
    await runtime.kernel.sendMessage(normal.id, {
      mode: "sms",
      characterId: character.id,
      text: "这是持久基线消息",
    });
    await runtime.kernel.memoryCoordinator.drain();
    await runtime.kernel.postTurnCoordinator.drain();
    await runtime.kernel.transitionConversationInteraction(normal.id, {
      action: "propose",
      location: "MEETING_INHERITANCE_SENTINEL",
    });
    await runtime.kernel.transitionConversationInteraction(normal.id, {
      action: "begin",
      location: "MEETING_INHERITANCE_SENTINEL",
      userConfirmed: true,
    });
    const baseline = await runtime.kernel.getConversationTranscript(normal.id);
    const parentHash = hashPersistentTree(stateDir);
    const rootsBefore = listSnapshotRoots();

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    assert.equal(isIncognitoSessionId(incognito.id), true);
    assert.equal(incognito.sourceSessionId, normal.id);
    assert.deepEqual(
      jsonValue(await runtime.kernel.getConversationTranscript(incognito.id)),
      jsonValue(baseline),
    );
    assert.equal(runtime.kernel.getConversationInteraction(incognito.id).state.presence, "co_present");
    assert.equal(
      runtime.kernel.getConversationInteraction(incognito.id).state.location,
      "MEETING_INHERITANCE_SENTINEL",
    );
    const createdRoots = listSnapshotRoots().filter((path) => !rootsBefore.includes(path));
    assert.equal(createdRoots.length, 1);
    assert.equal(lstatSync(createdRoots[0]).mode & 0o777, 0o700);

    runtime.model.enqueue([{ kind: "assistant_text", text: "这条回复只存在于无痕快照" }]);
    await runtime.kernel.sendMessage(incognito.id, { text: "还记得海边约定吗？" });
    const inheritedContext = JSON.stringify(runtime.model.requests.at(-1)?.providerPayload);
    assert.match(inheritedContext, /SOUL_INHERITANCE_SENTINEL/);
    assert.match(inheritedContext, /MEMORY_INHERITANCE_SENTINEL/);
    assert.match(inheritedContext, /RELATIONSHIP_INHERITANCE_SENTINEL/);
    assert.match(inheritedContext, /MEETING_INHERITANCE_SENTINEL/);
    const childTools = runtime.model.requests.at(-1)?.toolNames ?? [];
    for (const allowed of ["propose_meeting", "begin_meeting", "end_meeting", "list_workspace", "write", "edit"]) {
      assert.equal(childTools.includes(allowed), true, `${allowed} should remain available in incognito`);
    }
    for (const blocked of [
      "bash",
      "create_schedule_item",
      "get_user_profile",
      "get_current_character_soul",
      "search_memory",
      "get_relationship_state",
      "get_character_world_state",
      "tavily_search",
      "read_web_page",
      "delegate_task",
      "share_workspace_file",
    ]) {
      assert.equal(childTools.includes(blocked), false, `${blocked} must be unavailable in incognito`);
    }

    await runtime.kernel.transitionConversationInteraction(incognito.id, {
      action: "end",
      summary: "无痕中结束继承的见面",
      userConfirmed: true,
    });
    await runtime.kernel.transitionConversationInteraction(incognito.id, {
      action: "propose",
      location: "未来道具研究所",
    });
    const meeting = await runtime.kernel.transitionConversationInteraction(incognito.id, {
      action: "begin",
      location: "未来道具研究所",
      userConfirmed: true,
    });
    assert.equal(meeting.state.presence, "co_present");
    assert.equal(runtime.kernel.getConversationInteraction(normal.id).state.presence, "co_present");
    assert.equal(
      runtime.kernel.getConversationInteraction(normal.id).state.location,
      "MEETING_INHERITANCE_SENTINEL",
    );
    assert.equal((await runtime.kernel.getConversationTranscript(incognito.id)).length, baseline.length + 2);
    assert.deepEqual(jsonValue(await runtime.kernel.getConversationTranscript(normal.id)), jsonValue(baseline));
    assert.equal(hashPersistentTree(stateDir), parentHash);

    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(existsSync(createdRoots[0]), false);
    assert.equal(hashPersistentTree(stateDir), parentHash);
    await assert.rejects(
      runtime.kernel.getConversationTranscript(incognito.id),
      IncognitoConversationNotFoundError,
    );
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("closed and restarted synthetic IDs fail closed for messages, streams, scenes, and previews", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-stale-"));
  let runtime = createTestRuntime({ stateDir, seed: "incognito-stale" });
  let kernel: CompanionKernel | undefined;
  try {
    const character = runtime.kernel.createCharacter({ name: "关闭测试角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "持久回复" }]);
    await runtime.kernel.sendMessage(normal.id, {
      mode: "sms",
      characterId: character.id,
      text: "持久消息",
    });
    const baseline = await runtime.kernel.getConversationTranscript(normal.id);
    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    const activeServer = await listen(runtime.kernel);
    try {
      assert.equal((await fetch(`${activeServer.baseUrl}/api/v1/sessions/${incognito.id}/scene`)).status, 409);
      assert.equal((await fetch(
        `${activeServer.baseUrl}/api/v1/context-plan/preview?mode=sms&sessionId=${incognito.id}`,
      )).status, 409);
    } finally {
      await closeServer(activeServer.server);
    }

    await runtime.kernel.closeIncognitoConversation(incognito.id);
    const closedServer = await listen(runtime.kernel);
    try {
      await assertStaleHttpRoutes(closedServer.baseUrl, incognito.id, character.id);
    } finally {
      await closeServer(closedServer.server);
    }
    assert.deepEqual(jsonValue(await runtime.kernel.getConversationTranscript(normal.id)), jsonValue(baseline));
    runtime.dispose();

    kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      imGateway: false,
    });
    const restartedServer = await listen(kernel);
    try {
      await assertStaleHttpRoutes(restartedServer.baseUrl, incognito.id, character.id);
    } finally {
      await closeServer(restartedServer.server);
    }
    assert.deepEqual(jsonValue(await kernel.getConversationTranscript(normal.id)), jsonValue(baseline));
  } finally {
    try {
      runtime.dispose();
    } catch {
      // The runtime may already have been disposed before the restart check.
    }
    kernel?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("near-prefix persistent IDs remain valid and deleting all data destroys active snapshots", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-delete-all-"));
  const runtime = createTestRuntime({ stateDir, seed: "incognito-audit" });
  try {
    const character = runtime.kernel.createCharacter({ name: "删除测试角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    assert.match(normal.id, /^incognito-audit_/);
    assert.equal(isIncognitoSessionId(normal.id), false);
    runtime.model.enqueue([{ kind: "assistant_text", text: "普通前缀会话仍可用" }]);
    await runtime.kernel.sendMessage(normal.id, { text: "普通消息" });
    assert.equal((await runtime.kernel.getConversationTranscript(normal.id)).length, 2);

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    const activeRoot = listSnapshotRoots().find((path) =>
      readFileSync(join(path, ".yourchar-incognito-owner.json"), "utf8").includes(String(process.pid))
    );
    assert.ok(activeRoot);
    await runtime.kernel.deleteAllUserData();
    assert.equal(existsSync(activeRoot), false);
    assert.equal(runtime.kernel.listCharacters().length, 0);
    assert.equal(runtime.kernel.listConversationMetadata().length, 0);
    await assert.rejects(
      runtime.kernel.getConversationTranscript(incognito.id),
      IncognitoConversationNotFoundError,
    );
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an archived canonical source is inherited without restoring the parent conversation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-archived-source-"));
  const runtime = createTestRuntime({ stateDir, seed: "incognito-archived-source" });
  try {
    const character = runtime.kernel.createCharacter({ name: "归档继承角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "归档前的回复" }]);
    await runtime.kernel.sendMessage(normal.id, { text: "归档前的对话" });
    await runtime.kernel.transitionConversationInteraction(normal.id, {
      action: "propose",
      location: "ARCHIVED_MEETING_LOCATION_SENTINEL",
    });
    await runtime.kernel.transitionConversationInteraction(normal.id, {
      action: "begin",
      location: "ARCHIVED_MEETING_LOCATION_SENTINEL",
      userConfirmed: true,
    });
    const baseline = await runtime.kernel.getConversationTranscript(normal.id);
    const archived = runtime.kernel.archiveConversation(normal.id);
    assert.ok(archived.archivedAt);

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    assert.equal(incognito.sourceSessionId, normal.id);
    assert.equal(incognito.sourceArchived, true);
    assert.deepEqual(
      jsonValue(await runtime.kernel.getConversationTranscript(incognito.id)),
      jsonValue(baseline),
    );
    assert.equal(runtime.kernel.getConversationInteraction(incognito.id).state.presence, "co_present");
    assert.equal(
      runtime.kernel.getConversationInteraction(incognito.id).state.location,
      "ARCHIVED_MEETING_LOCATION_SENTINEL",
    );
    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(runtime.kernel.getConversationMetadata(normal.id)?.archivedAt, archived.archivedAt);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("snapshot physically excludes private Vault data and secret-only Skill packages", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-private-purge-"));
  const normalSkillDir = join(stateDir, "skills", "normal-only");
  const secretSkillDir = join(stateDir, "skills", "secret-only");
  mkdirSync(normalSkillDir, { recursive: true });
  mkdirSync(secretSkillDir, { recursive: true });
  writeFileSync(join(normalSkillDir, "SKILL.md"), skillMarkdown(
    "normal-only",
    "NORMAL_SKILL_CONTENT_SENTINEL",
  ));
  writeFileSync(join(secretSkillDir, "SKILL.md"), skillMarkdown(
    "secret-only",
    "SECRET_SKILL_CONTENT_SENTINEL",
  ));
  const runtime = createTestRuntime({ stateDir, seed: "incognito-private-purge" });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密清除角色" });
    runtime.kernel.setAgentSkillEnabledSpaces("skill:normal-only", ["normal"]);
    runtime.kernel.setAgentSkillEnabledSpaces("skill:secret-only", ["secret"]);
    await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    const secretMemory = runtime.kernel.memoryLifecycle.captureAuthorized({
      conversationSpace: "secret",
      secretOwnerCharacterId: character.id,
      realm: "reality",
      type: "user_fact",
      content: "SECRET_VAULT_CONTENT_SENTINEL",
      sourceSessionId: secret.id,
      sourceMessageId: "secret-snapshot-message",
      idempotencyKey: "secret-snapshot-memory",
    });
    runtime.kernel.database.connection.prepare(`
      INSERT INTO audit_actions(id, action_type, status, payload_json, created_at)
      VALUES (?, 'secret_test_action', 'completed', ?, ?)
    `).run(
      "secret-audit-snapshot-fixture",
      JSON.stringify({
        __rp_agent_action_scope_v1: {
          conversationSpace: "secret",
          secretOwnerCharacterId: character.id,
        },
        payload: { location: "SECRET_AUDIT_LOCATION_SENTINEL" },
      }),
      new Date().toISOString(),
    );
    runtime.kernel.database.connection.prepare(`
      INSERT OR REPLACE INTO memory_retrieval_stats(memory_id, hit_count, last_hit_at)
      VALUES (?, 1, ?)
    `).run(secretMemory.id, new Date().toISOString());
    const secretPadding = join(stateDir, "memory-vault", "secret", "large-private-padding.bin");
    writeFileSync(secretPadding, "SECRET_PADDING_SENTINEL");
    truncateSync(secretPadding, 257 * 1024 * 1024);

    const rootsBefore = listSnapshotRoots();
    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    const root = listSnapshotRoots().find((path) => !rootsBefore.includes(path));
    assert.ok(root);
    assert.equal(existsSync(join(root, "skills", "normal-only", "SKILL.md")), true);
    assert.equal(existsSync(join(root, "skills", "secret-only")), false);
    assert.deepEqual(listRegularFiles(join(root, "memory-vault", "secret")), []);
    assert.equal(snapshotContains(root, "NORMAL_SKILL_CONTENT_SENTINEL"), true);
    assert.equal(snapshotContains(root, "SECRET_SKILL_CONTENT_SENTINEL"), false);
    assert.equal(snapshotContains(root, "SECRET_VAULT_CONTENT_SENTINEL"), false);
    assert.equal(snapshotContains(root, "SECRET_AUDIT_LOCATION_SENTINEL"), false);
    assert.equal(snapshotContains(root, secretMemory.id), false);
    assert.equal(snapshotContains(root, "SECRET_PADDING_SENTINEL"), false);
    await runtime.kernel.closeIncognitoConversation(incognito.id);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("snapshot inherits ordinary workspace files but excludes workspace/repos from copy and budget", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-repos-exclusion-"));
  const runtime = createTestRuntime({ stateDir, seed: "incognito-repos-exclusion" });
  try {
    const character = runtime.kernel.createCharacter({ name: "仓库隔离角色" });
    await runtime.kernel.openCanonicalPrivateConversation(character.id);

    const workspaceDir = join(stateDir, "workspace");
    const repositoryDir = join(workspaceDir, "repos", "Review");
    mkdirSync(repositoryDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "ordinary-note.md"),
      "ORDINARY_WORKSPACE_INHERITANCE_SENTINEL",
    );
    writeFileSync(
      join(repositoryDir, "repository-note.md"),
      "EXCLUDED_REPOSITORY_CONTENT_SENTINEL",
    );
    const oversizedRepositoryPayload = join(repositoryDir, "oversized-sparse-payload.bin");
    writeFileSync(oversizedRepositoryPayload, "EXCLUDED_REPOSITORY_PAYLOAD_SENTINEL");
    truncateSync(oversizedRepositoryPayload, 257 * 1024 * 1024);

    const rootsBefore = listSnapshotRoots();
    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    const root = listSnapshotRoots().find((path) => !rootsBefore.includes(path));
    assert.ok(root);
    assert.equal(
      readFileSync(join(root, "workspace", "ordinary-note.md"), "utf8"),
      "ORDINARY_WORKSPACE_INHERITANCE_SENTINEL",
    );
    assert.equal(existsSync(join(root, "workspace", "repos")), false);
    assert.equal(snapshotContains(root, "EXCLUDED_REPOSITORY_CONTENT_SENTINEL"), false);
    assert.equal(snapshotContains(root, "EXCLUDED_REPOSITORY_PAYLOAD_SENTINEL"), false);

    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(existsSync(root), false);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startup cleans only a stale owned direct-child tmpfs snapshot", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-orphan-state-"));
  const orphan = join(tmpfsRoot, `${snapshotPrefix}${randomUUID()}`);
  mkdirSync(orphan, { mode: 0o700 });
  chmodSync(orphan, 0o700);
  writeFileSync(join(orphan, ".yourchar-incognito-owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    pid: 2_147_483_647,
    processIdentity: "dead-process",
    createdAt: "2026-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  let kernel: CompanionKernel | undefined;
  try {
    kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      imGateway: false,
    });
    assert.equal(existsSync(orphan), false);
  } finally {
    kernel?.dispose();
    rmSync(orphan, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dispose during opening removes the root and prevents child publication", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-opening-race-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const entered = deferred<void>();
  const release = deferred<void>();
  let createChildCalls = 0;
  const rootsBefore = listSnapshotRoots();
  const manager = new IncognitoSessionManager({
    sourceStateDir: stateDir,
    sourceDatabase: database.connection,
    listSourceMetadata: () => [],
    listNormalSkillPackages: () => [],
    withSnapshotLock: async (_sessionId, operation) => {
      entered.resolve();
      await release.promise;
      return operation();
    },
    createChild: () => {
      createChildCalls += 1;
      return fakeChildKernel("opening-race-child") as never;
    },
  });
  try {
    const opening = manager.open("opening-race-character");
    await entered.promise;
    const openingRoot = listSnapshotRoots().find((path) => !rootsBefore.includes(path));
    assert.ok(openingRoot);
    manager.dispose();
    assert.equal(existsSync(openingRoot), false);
    release.resolve();
    await assert.rejects(opening, /opening after incognito shutdown/);
    assert.equal(createChildCalls, 0);
    assert.deepEqual(manager.listMetadata(), []);
    assert.equal(existsSync(openingRoot), false);
  } finally {
    release.resolve();
    try {
      manager.dispose();
    } catch {
      // A failing assertion must not retain a tmpfs root.
    }
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("close cancels and drains stream, compaction, and interaction work before disposal", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-close-race-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const stream = deferred<unknown>();
  const compaction = deferred<unknown>();
  const interaction = deferred<unknown>();
  const cancelled = deferred<void>();
  let disposed = false;
  const child = {
    ...fakeChildKernel("close-race-child"),
    streamMessage: () => stream.promise,
    compactConversationContext: () => compaction.promise,
    transitionConversationInteraction: () => interaction.promise,
    cancelMessage: async () => {
      cancelled.resolve();
      return true;
    },
    dispose: () => {
      disposed = true;
    },
  };
  const manager = new IncognitoSessionManager({
    sourceStateDir: stateDir,
    sourceDatabase: database.connection,
    listSourceMetadata: () => [],
    listNormalSkillPackages: () => [],
    withSnapshotLock: (_sessionId, operation) => operation(),
    createChild: () => child as never,
  });
  try {
    const metadata = await manager.open("close-race-character");
    const streamTask = manager.streamMessage(metadata.id, { text: "stream" }, () => undefined);
    const compactTask = manager.compactContext(metadata.id);
    const interactionTask = manager.transitionInteraction(metadata.id, { action: "undo" });
    let closeSettled = false;
    const closeTask = manager.close(metadata.id).finally(() => {
      closeSettled = true;
    });
    await cancelled.promise;
    await Promise.resolve();
    assert.equal(closeSettled, false);
    assert.equal(disposed, false);
    assert.equal(manager.has(metadata.id), false, "closing IDs stop accepting new operations");
    await assert.rejects(manager.getTranscript(metadata.id), IncognitoConversationNotFoundError);

    stream.resolve(messageResponse());
    compaction.resolve({ compacted: false, reason: "test" });
    interaction.resolve(interactionView("close-race-child"));
    await Promise.all([streamTask, compactTask, interactionTask, closeTask]);
    assert.equal(disposed, true);
    assert.deepEqual(manager.listMetadata(), []);
  } finally {
    try {
      manager.dispose();
    } catch {
      // The assertions above retain the primary cleanup failure.
    }
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runtime quota rejects an oversized disposable overlay before child access", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-runtime-quota-"));
  const runtime = createTestRuntime({ stateDir, seed: "incognito-runtime-quota" });
  try {
    const character = runtime.kernel.createCharacter({ name: "配额测试角色" });
    await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const rootsBefore = listSnapshotRoots();
    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    const root = listSnapshotRoots().find((path) => !rootsBefore.includes(path));
    assert.ok(root);
    const overflow = join(root, "runtime-quota-overflow.bin");
    writeFileSync(overflow, "quota");
    truncateSync(overflow, 257 * 1024 * 1024);
    await assert.rejects(
      runtime.kernel.getConversationTranscript(incognito.id),
      /256 MiB runtime quota/,
    );
    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(existsSync(root), false);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("incognito child SQLite connections keep temporary state in memory", () => {
  const stateDir = mkdtempSync(join(tmpfsRoot, "yourchar-incognito-child-sqlite-"));
  let child: CompanionKernel | undefined;
  try {
    child = new CompanionKernel({
      stateDir,
      incognitoChild: true,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      imGateway: false,
    });
    const row = child.database.connection.prepare("PRAGMA temp_store").get() as {
      temp_store?: number;
    } | undefined;
    assert.equal(Number(row?.temp_store), 2);
  } finally {
    child?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("large snapshot VACUUM never opens an ambient SQLite temp file", async () => {
  const control = await observeVacuumFileDescriptors("control");
  assert.equal(
    control.some((path) => path.includes("/var/tmp/etilqs_")),
    true,
    "the control proves the fd observer catches SQLite's ambient VACUUM file",
  );
  const incognito = await observeVacuumFileDescriptors("incognito");
  assert.deepEqual(
    incognito.filter((path) => path.includes("etilqs_")),
    [],
    "snapshot cleanup must keep SQLite temporary state in memory",
  );
});

async function assertStaleHttpRoutes(baseUrl: string, sessionId: string, characterId: string): Promise<void> {
  for (const suffix of ["messages", "messages/stream"]) {
    const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "sms", characterId, text: "不得落回持久会话" }),
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "INCOGNITO_CONVERSATION_NOT_FOUND",
    );
  }
  for (const path of [
    `/api/v1/sessions/${sessionId}/scene`,
    `/api/v1/context-plan/preview?mode=sms&sessionId=${sessionId}`,
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      "INCOGNITO_CONVERSATION_NOT_FOUND",
    );
  }
}

async function listen(kernel: CompanionKernel): Promise<{ server: Server; baseUrl: string }> {
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listSnapshotRoots(): string[] {
  return readdirSync(tmpfsRoot)
    .filter((name) => name.startsWith(snapshotPrefix))
    .map((name) => join(tmpfsRoot, name))
    .sort();
}

function hashPersistentTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const stats = lstatSync(path);
    const name = relative(root, path) || ".";
    if (stats.isSymbolicLink()) {
      hash.update(`symlink:${name}\0`);
      return;
    }
    if (stats.isDirectory()) {
      hash.update(`directory:${name}:${stats.mode & 0o777}\0`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (!stats.isFile() || name.endsWith("-shm")) return;
    hash.update(`file:${name}:${stats.mode & 0o777}:${stats.size}\0`);
    hash.update(readFileSync(path));
  };
  visit(root);
  return hash.digest("hex");
}

function snapshotContains(root: string, sentinel: string): boolean {
  const expected = Buffer.from(sentinel);
  const visit = (path: string): boolean => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return false;
    if (stats.isDirectory()) return readdirSync(path).some((name) => visit(join(path, name)));
    return stats.isFile() && readFileSync(path).indexOf(expected) >= 0;
  };
  return visit(root);
}

function listRegularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (path: string): void => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (stats.isFile()) {
      files.push(relative(root, path));
    }
  };
  visit(root);
  return files.sort();
}

function skillMarkdown(name: string, sentinel: string): string {
  return `---\nname: ${name}\ndescription: Snapshot isolation fixture.\n---\n\n${sentinel}\n`;
}

async function observeVacuumFileDescriptors(
  mode: "control" | "incognito",
): Promise<string[]> {
  const worker = new Worker(
    new URL("./fixtures/incognito-vacuum-worker.js", import.meta.url),
    { workerData: { mode } },
  );
  const observed = new Set<string>();
  let observing = false;
  let acknowledged = false;
  const scan = (): void => {
    if (!observing) return;
    try {
      for (const fd of readdirSync(`/proc/${process.pid}/fd`)) {
        try {
          const path = readlinkSync(`/proc/${process.pid}/fd/${fd}`);
          if (path.includes("etilqs_")) observed.add(path);
        } catch {
          // File descriptors may close between listing and readlink.
        }
      }
    } catch {
      // The Linux /proc contract is asserted through the control observation below.
    }
  };
  const timer = setInterval(scan, 1);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message: unknown) => {
        const type = message && typeof message === "object" && "type" in message
          ? (message as { type?: unknown }).type
          : undefined;
        if (type === "observe" && !acknowledged) {
          acknowledged = true;
          observing = true;
          scan();
          worker.postMessage("start");
        } else if (type === "done") {
          scan();
          observing = false;
        }
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0 && acknowledged) resolve();
        else reject(new Error(`vacuum fixture exited with code ${code}`));
      });
    });
  } finally {
    clearInterval(timer);
    await worker.terminate();
  }
  return [...observed].sort();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeChildKernel(sessionId: string) {
  const now = "2026-08-20T00:00:00.000Z";
  const metadata = {
    id: sessionId,
    mode: "sms" as const,
    conversationSpace: "normal" as const,
    characterId: "fake-character",
    canonicalDirect: true,
    createdAt: now,
    updatedAt: now,
  };
  return {
    openCanonicalPrivateConversation: async (characterId: string) => ({ ...metadata, characterId }),
    listConversationMetadata: () => [metadata],
    getSession: async () => ({ id: sessionId, messages: [], createdAt: now, updatedAt: now }),
    getConversationTranscript: async () => [],
    sendMessage: async () => messageResponse(),
    streamMessage: async () => messageResponse(),
    cancelMessage: async () => false,
    getConversationContextBudget: async () => ({ sessionId }),
    compactConversationContext: async () => ({ compacted: false, reason: "test" }),
    getConversationInteraction: () => interactionView(sessionId),
    transitionConversationInteraction: async () => interactionView(sessionId),
    dispose: () => undefined,
  };
}

function messageResponse() {
  return {
    reply: "test",
    actions: [],
    events: [],
    status: "completed" as const,
    messageType: "assistant" as const,
    canRetry: false,
  };
}

function interactionView(sessionId: string) {
  const now = "2026-08-20T00:00:00.000Z";
  return {
    state: {
      sessionId,
      characterId: "fake-character",
      conversationSpace: "normal" as const,
      continuity: "canonical" as const,
      presence: "remote" as const,
      narrativeLens: "message" as const,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    events: [],
    canUndo: false,
    suggestedLocations: [],
    liveState: { presence: "remote" as const, updatedAt: now },
  };
}

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
