import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  CompanionKernel,
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  type MessageResponse,
} from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { PiSessionIntegrityError, SessionModeMismatchError } from "../src/pi/index.js";
import { createTestRuntime, ScriptedModelController } from "../src/testing/runtime.js";

test("Pi AgentSession transcript persists and resumes after kernel restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-pi-session-"));
  try {
    const first = new CompanionKernel({ stateDir });
    await first.sendMessage("persistent-session", { mode: "sms", text: "第一条消息" });
    first.dispose();

    assert.equal(existsSync(join(stateDir, "conversations.json")), true);
    assert.equal(readdirSync(join(stateDir, "pi-sessions")).some((name) => name.endsWith(".jsonl")), true);

    const second = new CompanionKernel({ stateDir });
    const restored = await second.getSession("persistent-session");
    assert.deepEqual(
      restored.messages.map((message) => message.role),
      ["user", "custom"],
    );
    const systemEvent = restored.messages[1];
    assert.equal(systemEvent?.role === "custom" ? systemEvent.customType : undefined, "rp-agent/system_event");

    await second.sendMessage("persistent-session", { mode: "sms", text: "第二条消息" });
    const continued = await second.getSession("persistent-session");
    assert.equal(continued.messages.length, 4);
    second.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a state-directory rename rebases the Pi session file without losing transcript messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-pi-session-rebase-"));
  const legacyStateDir = join(root, ".rp-agent");
  const currentStateDir = join(root, ".yourchar");
  const model = new ScriptedModelController("pi-session-rebase");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    first = createPersistentScriptedKernel(legacyStateDir, model);
    model.enqueue([{ kind: "assistant_text", text: "改名后这段聊天仍然存在。" }]);
    await first.sendMessage("rebased-session", { mode: "sms", text: "请记住这段聊天" });
    const transcriptBefore = await first.getConversationTranscript("rebased-session");
    const messageCountBefore = (await first.getSession("rebased-session")).messages.length;
    const archived = first.archiveConversation("rebased-session");
    assert.ok(archived.archivedAt);
    const originalMetadata = first.listConversationMetadata().find((entry) =>
      entry.id === "rebased-session"
    );
    assert.ok(originalMetadata?.piSessionFile);
    assert.ok(originalMetadata.piSessionId);
    const fileName = basename(originalMetadata.piSessionFile);
    first.dispose();
    first = undefined;

    renameSync(legacyStateDir, currentStateDir);
    const expectedSessionFile = join(currentStateDir, "pi-sessions", fileName);
    second = createPersistentScriptedKernel(currentStateDir, model, false);

    const persisted = readConversationIndex(join(currentStateDir, "conversations.json"));
    assert.equal(
      persisted.conversations.find((entry) => entry.id === "rebased-session")?.piSessionFile,
      expectedSessionFile,
    );
    const transcriptAfter = await second.getConversationTranscript("rebased-session");
    const messageCountAfter = (await second.getSession("rebased-session")).messages.length;
    const includeArchivedRecords = await second.listSessions();
    server = createHttpServer({ kernel: second });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const listedResponse = await fetch(`${baseUrl}/api/v1/sessions?includeArchived=1`);
    assert.equal(listedResponse.status, 200);
    const listedBody = await listedResponse.json() as {
      sessions: Array<{ id: string; messageCount: number; archivedAt?: string }>;
    };
    const listedArchived = listedBody.sessions.find((entry) => entry.id === "rebased-session");
    const transcriptResponse = await fetch(`${baseUrl}/api/v1/sessions/rebased-session/messages`);
    assert.equal(transcriptResponse.status, 200);
    const transcriptBody = await transcriptResponse.json() as unknown[];
    assert.deepEqual(
      JSON.parse(JSON.stringify(transcriptAfter)),
      JSON.parse(JSON.stringify(transcriptBefore)),
    );
    assert.equal(messageCountAfter, messageCountBefore);
    assert.equal(
      includeArchivedRecords.find((record) => record.id === "rebased-session")?.messages.length,
      messageCountBefore,
    );
    assert.equal(listedArchived?.messageCount, transcriptBefore.length);
    assert.equal(listedArchived?.archivedAt, archived.archivedAt);
    assert.equal(transcriptBody.length, transcriptBefore.length);
    assert.equal(
      second.listConversationMetadata().find((entry) => entry.id === "rebased-session")?.archivedAt,
      archived.archivedAt,
    );
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    first?.dispose();
    second?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty persisted Pi session materializes its header and survives restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-empty-pi-session-"));
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  try {
    first = new CompanionKernel({ stateDir });
    await first.sessionRuntime.getOrCreate("empty-persisted-session", "sms");
    const sessionFile = first.listConversationMetadata().find((entry) =>
      entry.id === "empty-persisted-session"
    )?.piSessionFile;
    assert.ok(sessionFile && existsSync(sessionFile));
    assert.equal(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).type, "session");
    first.dispose();
    first = undefined;

    second = new CompanionKernel({ stateDir });
    assert.deepEqual((await second.getSession("empty-persisted-session")).messages, []);
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unrecoverable Pi session bindings remain unchanged and fail closed", async (context) => {
  const cases: Array<{
    name: string;
    mutate: (fixture: RenamedPiSessionFixture) => void;
  }> = [
    {
      name: "missing current candidate",
      mutate: (fixture) => {
        mkdirSync(dirname(fixture.legacySessionFile), { recursive: true });
        renameSync(fixture.currentSessionFile, fixture.legacySessionFile);
      },
    },
    {
      name: "header id mismatch",
      mutate: (fixture) => {
        const lines = readFileSync(fixture.currentSessionFile, "utf8").split("\n");
        const header = JSON.parse(lines[0]) as Record<string, unknown>;
        lines[0] = JSON.stringify({ ...header, id: `${fixture.piSessionId}-wrong` });
        writeFileSync(fixture.currentSessionFile, lines.join("\n"), "utf8");
      },
    },
    {
      name: "session file symlink",
      mutate: (fixture) => {
        const outsideFile = join(fixture.root, `outside-${basename(fixture.currentSessionFile)}`);
        renameSync(fixture.currentSessionFile, outsideFile);
        symlinkSync(outsideFile, fixture.currentSessionFile);
      },
    },
    {
      name: "session directory symlink",
      mutate: (fixture) => {
        const sessionDir = dirname(fixture.currentSessionFile);
        const outsideDir = join(fixture.root, "outside-pi-sessions");
        renameSync(sessionDir, outsideDir);
        symlinkSync(outsideDir, sessionDir, "dir");
      },
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const fixture = await createRenamedPiSessionFixture(scenario.name.replace(/\s+/g, "-"));
      let kernel: CompanionKernel | undefined;
      try {
        scenario.mutate(fixture);
        const indexBefore = readFileSync(fixture.indexPath, "utf8");
        const filesBefore = readdirSync(dirname(fixture.currentSessionFile)).sort();
        kernel = new CompanionKernel({ stateDir: fixture.currentStateDir });
        assert.equal(readFileSync(fixture.indexPath, "utf8"), indexBefore);

        await assert.rejects(kernel.getSession(fixture.conversationId), PiSessionIntegrityError);
        await assert.rejects(
          kernel.sendMessage(fixture.conversationId, { mode: "sms", text: "不得另建空会话" }),
          PiSessionIntegrityError,
        );
        assert.equal(readFileSync(fixture.indexPath, "utf8"), indexBefore);
        assert.deepEqual(readdirSync(dirname(fixture.currentSessionFile)).sort(), filesBefore);
      } finally {
        kernel?.dispose();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("a persisted conversation has one fixed mode", async () => {
  const kernel = new CompanionKernel({ stateDir: false });
  try {
    await kernel.sendMessage("fixed-mode", { mode: "sms", text: "hello" });
    await assert.rejects(
      kernel.sendMessage("fixed-mode", { mode: "rp", text: "切换叙事" }),
      SessionModeMismatchError,
    );
  } finally {
    kernel.dispose();
  }
});

test("the turn after the index-14 kernel restart resumes in order", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-turn15-restart-"));
  const model = new ScriptedModelController("turn15-restart");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  try {
    first = createPersistentScriptedKernel(stateDir, model);
    const character = first.createCharacter({ name: "苏言" });
    for (let index = 0; index < 15; index += 1) {
      model.enqueue([{
        kind: "assistant_text",
        text: `舰长，我认为第 ${index + 1} 轮已经按顺序完成。`,
      }]);
      const response: MessageResponse = await first.sendMessage("restart-after-15", {
        mode: "sms",
        characterId: character.id,
        text: `第 ${index + 1} 轮用户消息`,
      });
      assert.equal(response.status, "completed");
    }
    first.dispose();
    first = undefined;

    second = createPersistentScriptedKernel(stateDir, model, false);
    model.enqueue([{
      kind: "assistant_text",
      text: "舰长，我认为重启后的第 16 轮仍保持顺序。",
    }]);
    const resumed = await second.sendMessage("restart-after-15", {
      mode: "sms",
      characterId: character.id,
      text: "第 16 轮用户消息",
    });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.reply, "舰长，我认为重启后的第 16 轮仍保持顺序。");
    const request = JSON.stringify(model.requests.at(-1)?.messages);
    assert.ok(request.indexOf("第 15 轮已经按顺序完成") < request.indexOf("第 16 轮用户消息"));
    const restored = await second.getSession("restart-after-15");
    assert.equal(restored.messages.at(-1)?.role, "assistant");
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a rest checkpoint survives kernel restart and wakes on the next turn", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-compaction-restart-"));
  const model = new ScriptedModelController("compaction-restart");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  try {
    first = createPersistentScriptedKernel(
      stateDir,
      model,
      true,
      { tiredTokens: 12_000, hardSleepTokens: 60_000 },
    );
    const character = first.createCharacter({ name: "苏言" });
    first.writeRpMemory({
      realm: RP_MEMORY_REALM,
      scope: RP_MEMORY_SCOPE,
      type: "relationship_event",
      content: "压缩重启后仍需记住玻璃温室的约定",
      characterId: character.id,
      confirmed: true,
    });
    for (let index = 0; index < 12; index += 1) {
      model.enqueue([{
        kind: "assistant_text",
        text: `舰长，我认为第 ${index + 1} 轮数据有效。${"记录".repeat(900)}`,
      }]);
      const response: MessageResponse = await first.sendMessage("compact-restart", {
        mode: "sms",
        characterId: character.id,
        text: `第 ${index + 1} 轮长上下文。${"条件".repeat(900)}`,
      });
      assert.equal(response.status, "completed");
    }
    model.enqueue([{
      kind: "assistant_text",
      text: "晚安，舰长。我休息一下，醒来再继续。",
    }]);
    const resting = await first.sendMessage("compact-restart", {
      mode: "sms",
      characterId: character.id,
      text: "晚安咯",
    });
    assert.equal(resting.status, "completed");
    const firstHandle = await first.sessionRuntime.getOrCreate(
      "compact-restart",
      "sms",
      character.id,
    );
    assert.ok(firstHandle.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.ok(firstHandle.session.messages.some((message) => message.role === "compactionSummary"));
    assert.ok(firstHandle.session.messages.some((message) =>
      message.role === "custom" && message.customType === "rp-agent/turn_context" && message.display === false
    ));
    assert.equal(first.listConversationMetadata().find((entry) =>
      entry.id === "compact-restart"
    )?.sleepState, "sleeping");
    const compactionMetadata = first.listConversationMetadata().find((entry) =>
      entry.id === "compact-restart"
    );
    assert.equal(compactionMetadata?.lastCompactionStatus, "completed");
    assert.equal(compactionMetadata?.lastCompactionReason, "conversation_sleep");
    assert.ok(compactionMetadata?.lastCompactionAt);
    assert.ok((compactionMetadata?.lastCompactionEstimatedTokensBefore ?? 0) > 0);
    assert.ok((compactionMetadata?.lastCompactionEstimatedTokensAfter ?? Infinity) <
      (compactionMetadata?.lastCompactionEstimatedTokensBefore ?? 0));
    first.dispose();
    first = undefined;

    second = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      { tiredTokens: 12_000, hardSleepTokens: 60_000 },
    );
    const restoredCompactionMetadata = second.listConversationMetadata().find((entry) =>
      entry.id === "compact-restart"
    );
    assert.equal(restoredCompactionMetadata?.lastCompactionStatus, "completed");
    assert.equal(restoredCompactionMetadata?.lastCompactionReason, "conversation_sleep");
    assert.equal(restoredCompactionMetadata?.lastCompactionAt, compactionMetadata?.lastCompactionAt);
    assert.equal(
      restoredCompactionMetadata?.lastCompactionEstimatedTokensBefore,
      compactionMetadata?.lastCompactionEstimatedTokensBefore,
    );
    assert.equal(
      restoredCompactionMetadata?.lastCompactionEstimatedTokensAfter,
      compactionMetadata?.lastCompactionEstimatedTokensAfter,
    );
    const beforeNextTurn = await second.getSession("compact-restart");
    assert.ok(beforeNextTurn.messages.some((message) => message.role === "compactionSummary"));
    assert.ok(beforeNextTurn.messages.some((message) =>
      message.role === "custom" && message.customType === "rp-agent/turn_context" && message.display === false
    ));
    model.enqueue([{
      kind: "assistant_text",
      text: "舰长，我认为压缩并重启后的下一轮已完成。",
    }]);
    const resumed = await second.sendMessage("compact-restart", {
      mode: "sms",
      characterId: character.id,
      text: "压缩并重启后的下一轮",
    });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.reply, "舰长，我认为压缩并重启后的下一轮已完成。");
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /较早对话已压缩/);
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /压缩重启后仍需记住玻璃温室的约定/);
    assert.doesNotMatch(model.requests.at(-1)?.systemPrompt ?? "", /玻璃温室|Current time/);
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /state=\\?"waking/);
    assert.equal(second.listConversationMetadata().find((entry) =>
      entry.id === "compact-restart"
    )?.sleepState, "awake");
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a side-effect deferred checkpoint survives restart and runs at the next safe boundary", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-pending-compaction-restart-"));
  const workspaceDir = join(stateDir, "workspace");
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  try {
    first = createTestRuntime({
      stateDir,
      workspaceDir,
      seed: "pending-compaction-restart-first",
      conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    });
    first.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    first.model.enqueue([
      { kind: "assistant_text", text: `第一轮交流完成。${"abcd".repeat(6_000)}` },
      { kind: "tool_call", name: "write", arguments: { path: "second.txt", content: "second" } },
      {
        kind: "assistant_text",
        text: "第二项操作也完成了，我有些困了，等安全的时候休息一下。",
      },
    ]);
    await first.kernel.sendMessage("pending-restart", { mode: "sms", text: "先聊一句" });
    await first.kernel.sendMessage("pending-restart", { mode: "sms", text: "你先休息吧" });
    const pendingBeforeRestart = first.kernel.listConversationMetadata().find((entry) =>
      entry.id === "pending-restart"
    );
    assert.ok(pendingBeforeRestart?.pendingCompactionAt);
    assert.ok(pendingBeforeRestart?.pendingCompactionReason);
    assert.ok(pendingBeforeRestart?.sleepSuggestedAt);
    first.dispose();
    first = undefined;

    second = createTestRuntime({
      stateDir,
      workspaceDir,
      seed: "pending-compaction-restart-second",
      conversationLifecycleThresholds: { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    });
    const restoredPending = second.kernel.listConversationMetadata().find((entry) =>
      entry.id === "pending-restart"
    );
    assert.equal(restoredPending?.pendingCompactionAt, pendingBeforeRestart?.pendingCompactionAt);
    assert.equal(restoredPending?.pendingCompactionReason, pendingBeforeRestart?.pendingCompactionReason);
    assert.equal(restoredPending?.sleepSuggestedAt, pendingBeforeRestart?.sleepSuggestedAt);

    second.model.enqueue([
      { kind: "assistant_text", text: "工具操作链已经结束。" },
      { kind: "assistant_text", text: "重启后执行的安全整理摘要。" },
    ]);
    const safeTurn = await second.kernel.sendMessage("pending-restart", {
      mode: "sms",
      text: "现在可以继续了",
    });
    assert.equal(safeTurn.status, "completed");
    const handle = await second.kernel.sessionRuntime.getOrCreate("pending-restart", "sms");
    assert.ok(handle.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    const after = second.kernel.listConversationMetadata().find((entry) => entry.id === "pending-restart");
    assert.equal(after?.pendingCompactionAt, undefined);
    assert.equal(after?.pendingCompactionReason, undefined);
    assert.equal(after?.lastCompactionStatus, "completed");
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a legacy 32k tired marker self-heals after restart when the canonical budget is healthy", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-legacy-tired-restart-"));
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  try {
    first = createTestRuntime({ stateDir, seed: "legacy-tired-restart-first" });
    first.kernel.patchModelApiConfig({ contextWindowTokens: 131_072, maxTokens: 4_096 });
    first.model.enqueue([{
      kind: "assistant_text",
      text: "这是一段实际预算很健康的历史。",
      usage: { input: 8_000, output: 64 },
    }]);
    await first.kernel.sendMessage("legacy-tired", { mode: "sms", text: "保留这段短对话" });
    first.dispose();
    first = undefined;

    const indexPath = join(stateDir, "conversations.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      conversations: Array<Record<string, unknown>>;
    };
    const legacy = index.conversations.find((entry) => entry.id === "legacy-tired");
    assert.ok(legacy);
    legacy.sleepState = "tired";
    legacy.tiredAt = "2026-01-01T00:01:00.000Z";
    legacy.sleepSuggestedAt = "2026-01-01T00:01:01.000Z";
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    second = createTestRuntime({ stateDir, seed: "legacy-tired-restart-second" });
    second.kernel.patchModelApiConfig({ contextWindowTokens: 131_072, maxTokens: 4_096 });
    assert.equal(
      second.kernel.listConversationMetadata().find((entry) => entry.id === "legacy-tired")?.sleepState,
      "tired",
    );
    second.model.enqueue([{
      kind: "assistant_text",
      text: "实际余量充足，我们正常继续。",
      usage: { input: 9_000, output: 64 },
    }]);
    await second.kernel.sendMessage("legacy-tired", { mode: "sms", text: "继续" });

    const healed = second.kernel.listConversationMetadata().find((entry) => entry.id === "legacy-tired");
    assert.equal(healed?.sleepState, "awake");
    assert.equal(healed?.tiredAt, undefined);
    assert.equal(healed?.sleepSuggestedAt, undefined);
    const request = second.model.requests.find((entry) => JSON.stringify(entry.messages).includes("继续"));
    assert.doesNotMatch(JSON.stringify(request?.messages), /conversation_lifecycle[^]*state=\\?"tired/);
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function createPersistentScriptedKernel(
  stateDir: string,
  model: ScriptedModelController,
  configure = true,
  conversationLifecycleThresholds?: { tiredTokens: number; hardSleepTokens: number },
): CompanionKernel {
  const kernel = new CompanionKernel({
    stateDir,
    modelResolver: model.resolver,
    startScheduler: false,
    quietHours: false,
    conversationLifecycleThresholds,
  });
  if (configure) {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: "http://test.invalid/v1",
      model: "scripted-model",
      temperature: 0,
    });
  }
  return kernel;
}

type ConversationIndexFixture = {
  version: number;
  conversations: Array<{
    id: string;
    piSessionId?: string;
    piSessionFile?: string;
  }>;
};

type RenamedPiSessionFixture = {
  root: string;
  currentStateDir: string;
  indexPath: string;
  conversationId: string;
  piSessionId: string;
  legacySessionFile: string;
  currentSessionFile: string;
};

function readConversationIndex(path: string): ConversationIndexFixture {
  return JSON.parse(readFileSync(path, "utf8")) as ConversationIndexFixture;
}

async function createRenamedPiSessionFixture(seed: string): Promise<RenamedPiSessionFixture> {
  const root = mkdtempSync(join(tmpdir(), `yourchar-invalid-pi-${seed}-`));
  const legacyStateDir = join(root, ".rp-agent");
  const currentStateDir = join(root, ".yourchar");
  const conversationId = `invalid-pi-${seed}`;
  const model = new ScriptedModelController(`invalid-pi-${seed}`);
  const kernel = createPersistentScriptedKernel(legacyStateDir, model);
  try {
    model.enqueue([{ kind: "assistant_text", text: "这段记录只用于完整性测试。" }]);
    await kernel.sendMessage(conversationId, { mode: "sms", text: "原始聊天记录" });
    const metadata = kernel.listConversationMetadata().find((entry) => entry.id === conversationId);
    assert.ok(metadata?.piSessionFile);
    assert.ok(metadata.piSessionId);
    const legacySessionFile = metadata.piSessionFile;
    const fileName = basename(legacySessionFile);
    kernel.dispose();
    renameSync(legacyStateDir, currentStateDir);
    return {
      root,
      currentStateDir,
      indexPath: join(currentStateDir, "conversations.json"),
      conversationId,
      piSessionId: metadata.piSessionId,
      legacySessionFile,
      currentSessionFile: join(currentStateDir, "pi-sessions", fileName),
    };
  } catch (error) {
    kernel.dispose();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
