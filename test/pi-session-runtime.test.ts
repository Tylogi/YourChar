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
  type CompanionKernelOptions,
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

test("a failed proactive wake survives restart and the next user turn wins without a duplicate", async () => {
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
      async () => {
        throw new Error("wake composer intentionally unavailable");
      },
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
    await first.flushConversationWakeNotifications("compact-restart");
    const failedWakeMetadata = first.getConversationMetadata("compact-restart");
    assert.ok(failedWakeMetadata?.pendingWakeNotificationId);
    assert.ok(failedWakeMetadata?.wakeNotificationAttempts);
    assert.match(failedWakeMetadata?.wakeNotificationLastError ?? "", /intentionally unavailable/);
    first.dispose();
    first = undefined;

    second = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      { tiredTokens: 12_000, hardSleepTokens: 60_000 },
      async () => {
        throw new Error("wake composer intentionally unavailable");
      },
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
    assert.equal(
      restoredCompactionMetadata?.pendingWakeNotificationId,
      failedWakeMetadata?.pendingWakeNotificationId,
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
    assert.equal(second.getConversationMetadata("compact-restart")?.pendingWakeNotificationId, undefined);
    assert.equal(await second.flushConversationWakeNotifications("compact-restart"), 0);
    const transcript = await second.getSession("compact-restart");
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      0,
    );
    assert.equal(
      second.store.actions.filter((action) =>
        action.actionType === "conversation_wake_notification" && action.status === "completed"
      ).length,
      0,
    );
  } finally {
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a pending wake notification retries after restart and its transcript marker prevents redelivery", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-restart-dedupe-"));
  const model = new ScriptedModelController("wake-restart-dedupe");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  let third: CompanionKernel | undefined;
  try {
    first = createPersistentScriptedKernel(
      stateDir,
      model,
      true,
      { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      async () => {
        throw new Error("transient wake failure");
      },
    );
    const character = first.createCharacter({ name: "重启唤醒角色" });
    model.enqueue([
      { kind: "assistant_text", text: `先保留连续性。${"abcd".repeat(6_000)}` },
      { kind: "assistant_text", text: "晚安，我先休息一下。" },
    ]);
    await first.sendMessage("wake-restart-dedupe", {
      mode: "sms",
      characterId: character.id,
      text: "先聊一句",
    });
    await first.sendMessage("wake-restart-dedupe", {
      mode: "sms",
      characterId: character.id,
      text: "晚安咯",
    });
    await first.flushConversationWakeNotifications("wake-restart-dedupe");
    const pendingId = first.getConversationMetadata("wake-restart-dedupe")?.pendingWakeNotificationId;
    assert.ok(pendingId);
    first.dispose();
    first = undefined;

    let successfulComposerCalls = 0;
    second = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      async () => {
        successfulComposerCalls += 1;
        return "我睡醒了，回来继续陪你。";
      },
    );
    await second.flushConversationWakeNotifications("wake-restart-dedupe");
    assert.equal(await second.flushConversationWakeNotifications("wake-restart-dedupe"), 0);
    assert.equal(successfulComposerCalls, 1);
    const delivered = second.getConversationMetadata("wake-restart-dedupe");
    assert.equal(delivered?.sleepState, "awake");
    assert.equal(delivered?.lastWakeNotificationId, pendingId);
    assert.equal(delivered?.pendingWakeNotificationId, undefined);
    const deliveredTranscript = await second.getSession("wake-restart-dedupe");
    assert.equal(
      deliveredTranscript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake" &&
          JSON.stringify(message.details).includes(pendingId)
      ).length,
      1,
    );
    assert.equal(
      deliveredTranscript.messages.filter((message) => message.role === "assistant" &&
        message.content.some((block) => block.type === "text" && block.text === "我睡醒了，回来继续陪你。"))
        .length,
      1,
    );
    second.dispose();
    second = undefined;

    const indexPath = join(stateDir, "conversations.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      conversations: Array<Record<string, unknown>>;
    };
    const stale = index.conversations.find((entry) => entry.id === "wake-restart-dedupe");
    assert.ok(stale);
    stale.sleepState = "sleeping";
    stale.pendingWakeNotificationId = pendingId;
    stale.pendingWakeNotificationAt = new Date().toISOString();
    delete stale.lastWakeNotificationId;
    delete stale.wakeNotificationDeliveredAt;
    stale.unreadCount = Math.max(0, Number(stale.unreadCount ?? 1) - 1);
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");

    let duplicateComposerCalls = 0;
    third = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      async () => {
        duplicateComposerCalls += 1;
        return "不应重复投递";
      },
    );
    assert.equal(await third.flushConversationWakeNotifications("wake-restart-dedupe"), 1);
    assert.equal(duplicateComposerCalls, 0);
    assert.equal(third.getConversationMetadata("wake-restart-dedupe")?.sleepState, "awake");
    assert.equal(third.getConversationMetadata("wake-restart-dedupe")?.pendingWakeNotificationId, undefined);
    const reconciledTranscript = await third.getSession("wake-restart-dedupe");
    assert.equal(
      reconciledTranscript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
  } finally {
    first?.dispose();
    second?.dispose();
    third?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a pre-outbox sleeping conversation migrates to one durable wake after upgrade", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-legacy-sleeping-wake-"));
  const model = new ScriptedModelController("legacy-sleeping-wake");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  let third: CompanionKernel | undefined;
  try {
    first = createPersistentScriptedKernel(stateDir, model);
    const character = first.createCharacter({ name: "旧版睡眠角色" });
    model.enqueue([{ kind: "assistant_text", text: "这段对话会模拟升级前的睡眠记录。" }]);
    await first.sendMessage("legacy-sleeping-wake", {
      mode: "sms",
      characterId: character.id,
      text: "记住这段对话",
    });
    first.dispose();
    first = undefined;

    const checkpointAt = "2026-01-02T03:04:05.000Z";
    const indexPath = join(stateDir, "conversations.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      conversations: Array<Record<string, unknown>>;
    };
    const legacy = index.conversations.find((entry) => entry.id === "legacy-sleeping-wake");
    assert.ok(legacy);
    legacy.sleepState = "sleeping";
    legacy.sleepCheckpointAt = checkpointAt;
    legacy.lastCompactionAt = checkpointAt;
    legacy.lastCompactionReason = "conversation_sleep";
    legacy.lastCompactionStatus = "completed";
    delete legacy.pendingWakeNotificationId;
    delete legacy.pendingWakeNotificationAt;
    delete legacy.wakeNotificationGeneration;
    delete legacy.wakeNotificationAttempts;
    delete legacy.wakeNotificationLastError;
    delete legacy.lastWakeNotificationId;
    delete legacy.wakeNotificationDeliveredAt;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    let composerCalls = 0;
    second = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      undefined,
      async () => {
        composerCalls += 1;
        return "我醒啦，我们继续吧。";
      },
    );
    const migrated = second.getConversationMetadata("legacy-sleeping-wake");
    const migratedId = "legacy-sleeping-wake:conversation-wake:1";
    assert.equal(migrated?.sleepState, "sleeping");
    assert.equal(migrated?.pendingWakeNotificationId, migratedId);
    assert.equal(migrated?.pendingWakeNotificationAt, checkpointAt);
    assert.equal(migrated?.wakeNotificationGeneration, 1);
    const persistedPending = JSON.parse(readFileSync(indexPath, "utf8")) as {
      conversations: Array<Record<string, unknown>>;
    };
    assert.equal(
      persistedPending.conversations.find((entry) => entry.id === "legacy-sleeping-wake")
        ?.pendingWakeNotificationId,
      migratedId,
    );

    assert.equal(await second.flushConversationWakeNotifications("legacy-sleeping-wake"), 1);
    assert.equal(composerCalls, 1);
    const delivered = second.getConversationMetadata("legacy-sleeping-wake");
    assert.equal(delivered?.sleepState, "awake");
    assert.equal(delivered?.pendingWakeNotificationId, undefined);
    assert.equal(delivered?.lastWakeNotificationId, migratedId);
    const deliveredTranscript = await second.getSession("legacy-sleeping-wake");
    assert.equal(
      deliveredTranscript.messages.filter((message) =>
        message.role === "custom" &&
        message.customType === "rp-agent/conversation_wake" &&
        JSON.stringify(message.details).includes(migratedId)
      ).length,
      1,
    );
    second.dispose();
    second = undefined;

    let duplicateComposerCalls = 0;
    third = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      undefined,
      async () => {
        duplicateComposerCalls += 1;
        return "不应重复投递";
      },
    );
    assert.equal(await third.flushConversationWakeNotifications("legacy-sleeping-wake"), 0);
    assert.equal(duplicateComposerCalls, 0);
    assert.equal(third.getConversationMetadata("legacy-sleeping-wake")?.sleepState, "awake");
    const restoredTranscript = await third.getSession("legacy-sleeping-wake");
    assert.equal(
      restoredTranscript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
  } finally {
    first?.dispose();
    second?.dispose();
    third?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the built-in wake composer falls back to a safe in-character line when its model call fails", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-model-fallback-"));
  const model = new ScriptedModelController("wake-model-fallback");
  const kernel = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
  );
  try {
    const character = kernel.createCharacter({ name: "回退唤醒角色" });
    model.enqueue([
      { kind: "assistant_text", text: `先完成一轮对话。${"abcd".repeat(6_000)}` },
      { kind: "assistant_text", text: "晚安，我先休息一下。" },
    ]);
    await kernel.sendMessage("wake-model-fallback", {
      mode: "sms",
      characterId: character.id,
      text: "先聊一句",
    });
    await kernel.sendMessage("wake-model-fallback", {
      mode: "sms",
      characterId: character.id,
      text: "晚安咯",
    });
    await kernel.flushConversationWakeNotifications("wake-model-fallback");

    assert.equal(kernel.getConversationMetadata("wake-model-fallback")?.sleepState, "awake");
    const transcript = await kernel.getSession("wake-model-fallback");
    assert.ok(transcript.messages.some((message) =>
      message.role === "assistant" && message.content.some((block) =>
        block.type === "text" && block.text === "我睡醒了，现在又可以继续陪你啦。")
    ));
    const action = kernel.store.actions.find((entry) =>
      entry.actionType === "conversation_wake_notification" && entry.status === "completed"
    );
    assert.equal(action?.payload.fallbackUsed, true);
    assert.equal(typeof action?.payload.composeError, "string");
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("disposing during wake composition aborts delivery without writing a message, marker, action, or unread", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-dispose-race-"));
  const model = new ScriptedModelController("wake-dispose-race");
  const composerEntered = deferredValue<void>();
  const releaseComposer = deferredValue<string>();
  let composerSignal: AbortSignal | undefined;
  let kernel: CompanionKernel | undefined = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    async (_input, signal) => {
      composerSignal = signal;
      composerEntered.resolve();
      return releaseComposer.promise;
    },
  );
  try {
    const character = kernel.createCharacter({ name: "关闭竞态角色" });
    model.enqueue([
      { kind: "assistant_text", text: `先形成足够长的休息上下文。${"abcd".repeat(6_000)}` },
      { kind: "assistant_text", text: "晚安，我先休息一下。" },
    ]);
    await kernel.sendMessage("wake-dispose-race", {
      mode: "sms",
      characterId: character.id,
      text: "先聊一句",
    });
    await kernel.sendMessage("wake-dispose-race", {
      mode: "sms",
      characterId: character.id,
      text: "晚安咯",
    });
    const pendingBeforeDispose = kernel.getConversationMetadata("wake-dispose-race")
      ?.pendingWakeNotificationId;
    assert.ok(pendingBeforeDispose);

    const flush = kernel.flushConversationWakeNotifications("wake-dispose-race");
    await composerEntered.promise;
    const disposedKernel = kernel;
    kernel.dispose();
    kernel = undefined;
    assert.equal(composerSignal?.aborted, true);
    releaseComposer.resolve("这条关闭后的醒来消息绝不能落盘。");
    assert.equal(await flush, 0);
    await Promise.resolve();

    assert.equal(
      disposedKernel.store.actions.some((action) =>
        action.actionType === "conversation_wake_notification"
      ),
      false,
    );
    const persistedIndex = JSON.parse(
      readFileSync(join(stateDir, "conversations.json"), "utf8"),
    ) as { conversations: Array<Record<string, unknown>> };
    const persisted = persistedIndex.conversations.find((entry) => entry.id === "wake-dispose-race");
    assert.equal(persisted?.sleepState, "sleeping");
    assert.equal(persisted?.pendingWakeNotificationId, pendingBeforeDispose);
    assert.equal(persisted?.unreadCount, 2);
    const persistedPi = readdirSync(join(stateDir, "pi-sessions"))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(stateDir, "pi-sessions", name), "utf8"))
      .join("\n");
    assert.doesNotMatch(persistedPi, /rp-agent\/conversation_wake|这条关闭后的醒来消息绝不能落盘/);
  } finally {
    releaseComposer.resolve("释放测试生成器");
    kernel?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("disposing startup wake recovery closes a session handle that finishes loading late", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-startup-dispose-"));
  const model = new ScriptedModelController("wake-startup-dispose");
  let first: CompanionKernel | undefined;
  let second: CompanionKernel | undefined;
  const handleCreated = deferredValue<{ session: { dispose(): void } }>();
  const releaseHandle = deferredValue<void>();
  try {
    first = createPersistentScriptedKernel(
      stateDir,
      model,
      true,
      { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      async () => "启动恢复不应在关闭后投递。",
      [0],
    );
    const character = first.createCharacter({ name: "启动恢复竞态角色" });
    await checkpointConversationForWake(
      first,
      model,
      "wake-startup-dispose",
      character.id,
    );
    const pendingId = first.getConversationMetadata("wake-startup-dispose")
      ?.pendingWakeNotificationId;
    assert.ok(pendingId);
    first.dispose();
    first = undefined;

    second = createPersistentScriptedKernel(
      stateDir,
      model,
      false,
      { tiredTokens: 1, hardSleepTokens: 1_000_000 },
      async () => "启动恢复不应在关闭后投递。",
      [0],
    );
    const runtimeInternals = second.sessionRuntime as unknown as {
      createHandle: (metadata: unknown) => Promise<{ session: { dispose(): void } }>;
      handles: Map<string, unknown>;
      loading: Map<string, unknown>;
    };
    const createHandle = runtimeInternals.createHandle.bind(second.sessionRuntime);
    let lateHandleDisposeCalls = 0;
    runtimeInternals.createHandle = async (metadata) => {
      const handle = await createHandle(metadata);
      const dispose = handle.session.dispose.bind(handle.session);
      handle.session.dispose = () => {
        lateHandleDisposeCalls += 1;
        dispose();
      };
      handleCreated.resolve(handle);
      await releaseHandle.promise;
      return handle;
    };

    const flush = second.flushConversationWakeNotifications("wake-startup-dispose");
    await handleCreated.promise;
    const disposedKernel = second;
    second.dispose();
    second = undefined;
    releaseHandle.resolve();
    assert.equal(await flush, 0);
    assert.equal(runtimeInternals.handles.size, 0);
    assert.equal(runtimeInternals.loading.size, 0);
    assert.equal(lateHandleDisposeCalls, 1);
    const persisted = readConversationIndex(join(stateDir, "conversations.json"))
      .conversations.find((entry) => entry.id === "wake-startup-dispose") as
        | (Record<string, unknown> & { pendingWakeNotificationId?: string; sleepState?: string })
        | undefined;
    assert.equal(persisted?.pendingWakeNotificationId, pendingId);
    assert.equal(persisted?.sleepState, "sleeping");
    assert.equal(
      disposedKernel.store.actions.some((action) =>
        action.actionType === "conversation_wake_notification"
      ),
      false,
    );
  } finally {
    releaseHandle.resolve();
    first?.dispose();
    second?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a direct user turn aborts an in-flight wake composer that ignores its signal", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-user-preempts-"));
  const model = new ScriptedModelController("wake-user-preempts");
  const composerEntered = deferredValue<void>();
  const releaseComposer = deferredValue<string>();
  let composerSignal: AbortSignal | undefined;
  const kernel = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    async (_input, signal) => {
      composerSignal = signal;
      composerEntered.resolve();
      // Intentionally ignore the abort signal. The kernel must race this
      // promise with cancellation so the foreground queue is still released.
      return releaseComposer.promise;
    },
    [0],
  );
  try {
    const character = kernel.createCharacter({ name: "用户抢先唤醒角色" });
    await checkpointConversationForWake(
      kernel,
      model,
      "wake-user-preempts",
      character.id,
    );
    const wakeFlush = kernel.flushConversationWakeNotifications("wake-user-preempts");
    await composerEntered.promise;

    model.enqueue([{ kind: "assistant_text", text: "你先叫醒我了，我们直接继续吧。" }]);
    const foreground = await settlesWithin(
      kernel.sendMessage("wake-user-preempts", {
        mode: "sms",
        characterId: character.id,
        text: "醒了吗？",
      }),
      1_500,
      "foreground user turn remained blocked behind the aborted wake composer",
    );
    assert.equal(foreground.reply, "你先叫醒我了，我们直接继续吧。");
    assert.equal(await wakeFlush, 0);
    assert.equal(composerSignal?.aborted, true);
    assert.equal(kernel.getConversationMetadata("wake-user-preempts")?.sleepState, "awake");
    assert.equal(
      kernel.getConversationMetadata("wake-user-preempts")?.pendingWakeNotificationId,
      undefined,
    );
    const transcript = await kernel.getSession("wake-user-preempts");
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      0,
    );
    assert.doesNotMatch(JSON.stringify(transcript.messages), /忽略信号后的醒来消息/);
    assert.equal(
      kernel.store.actions.some((action) => action.actionType === "conversation_wake_notification"),
      false,
    );
  } finally {
    releaseComposer.resolve("忽略信号后的醒来消息绝不能投递。");
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a streaming user turn aborts an in-flight wake composer that ignores its signal", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-stream-preempts-"));
  const model = new ScriptedModelController("wake-stream-preempts");
  const composerEntered = deferredValue<void>();
  const releaseComposer = deferredValue<string>();
  let composerSignal: AbortSignal | undefined;
  const kernel = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    async (_input, signal) => {
      composerSignal = signal;
      composerEntered.resolve();
      return releaseComposer.promise;
    },
    [0],
  );
  try {
    const character = kernel.createCharacter({ name: "流式抢先唤醒角色" });
    await checkpointConversationForWake(
      kernel,
      model,
      "wake-stream-preempts",
      character.id,
    );
    const wakeFlush = kernel.flushConversationWakeNotifications("wake-stream-preempts");
    await composerEntered.promise;

    model.enqueue([{ kind: "assistant_text", text: "流式消息先到了，我们直接继续吧。" }]);
    const foreground = await settlesWithin(
      kernel.streamMessage("wake-stream-preempts", {
        mode: "sms",
        characterId: character.id,
        text: "醒了吗？",
      }, () => undefined),
      1_500,
      "streaming user turn remained blocked behind the aborted wake composer",
    );
    assert.equal(foreground.reply, "流式消息先到了，我们直接继续吧。");
    assert.equal(await wakeFlush, 0);
    assert.equal(composerSignal?.aborted, true);
    assert.equal(kernel.getConversationMetadata("wake-stream-preempts")?.sleepState, "awake");
    assert.equal(
      kernel.getConversationMetadata("wake-stream-preempts")?.pendingWakeNotificationId,
      undefined,
    );
    const transcript = await kernel.getSession("wake-stream-preempts");
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      0,
    );
    assert.equal(
      kernel.store.actions.some((action) => action.actionType === "conversation_wake_notification"),
      false,
    );
  } finally {
    releaseComposer.resolve("忽略信号后的流式醒来消息绝不能投递。");
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("internal-mechanics wake drafts retry and persist only the deterministic safe fallback", async (t) => {
  const cases = [
    {
      label: "thinking tags",
      draft: "<think>reasoning</think>我醒了",
      expectedError: /thinking tags/,
    },
    {
      label: "pending tool protocol",
      draft: "Call:",
      expectedError: /unsafe or incomplete analysis/,
    },
    {
      label: "English conversation summary",
      draft: "I summarized the conversation and woke up.",
      expectedError: /internal mechanics/,
    },
    {
      label: "Chinese conversation summary",
      draft: "会话整理好了，我醒了。",
      expectedError: /internal mechanics/,
    },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.label, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), `rp-agent-wake-output-guard-${index}-`));
      const model = new ScriptedModelController(`wake-output-guard-${index}`);
      let composerCalls = 0;
      const sessionId = `wake-output-guard-${index}`;
      const kernel = createPersistentScriptedKernel(
        stateDir,
        model,
        true,
        { tiredTokens: 1, hardSleepTokens: 1_000_000 },
        async () => {
          composerCalls += 1;
          return fixture.draft;
        },
        [0],
      );
      try {
        const character = kernel.createCharacter({ name: `醒来文案防护角色 ${index}` });
        await checkpointConversationForWake(kernel, model, sessionId, character.id);
        await kernel.flushConversationWakeNotifications(sessionId);
        await waitForCondition(
          () => kernel.getConversationMetadata(sessionId)?.sleepState === "awake",
          3_000,
          `${fixture.label} wake did not reach its safe fallback`,
        );

        assert.equal(composerCalls, 2);
        const transcript = await kernel.getSession(sessionId);
        const serialized = JSON.stringify(transcript.messages);
        assert.equal(serialized.includes(fixture.draft), false);
        assert.match(serialized, /我睡醒了，现在又可以继续陪你啦。/);
        const completed = kernel.store.actions.find((action) =>
          action.actionType === "conversation_wake_notification" && action.status === "completed"
        );
        assert.equal(completed?.payload.fallbackUsed, true);
        assert.match(String(completed?.payload.composeError ?? ""), fixture.expectedError);
        assert.equal(
          kernel.store.actions.filter((action) =>
            action.actionType === "conversation_wake_notification" && action.status === "failed"
          ).length,
          1,
        );
      } finally {
        kernel.dispose();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test("a transient transcript read failure automatically retries the pending wake in-process", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-transcript-retry-"));
  const model = new ScriptedModelController("wake-transcript-retry");
  let composerCalls = 0;
  const kernel = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    async () => {
      composerCalls += 1;
      return "瞬态读取恢复后，我醒来啦。";
    },
    [0],
  );
  const originalTranscript = kernel.sessionRuntime.getConversationTranscript.bind(kernel.sessionRuntime);
  try {
    const character = kernel.createCharacter({ name: "瞬态恢复角色" });
    await checkpointConversationForWake(
      kernel,
      model,
      "wake-transcript-retry",
      character.id,
    );
    let transcriptFailures = 1;
    kernel.sessionRuntime.getConversationTranscript = async (sessionId) => {
      if (transcriptFailures > 0) {
        transcriptFailures -= 1;
        throw new Error("transient transcript read failure");
      }
      return originalTranscript(sessionId);
    };

    await waitForCondition(
      () => kernel.getConversationMetadata("wake-transcript-retry")?.sleepState === "awake",
      3_000,
      "transient transcript failure stranded the pending wake",
    );
    assert.equal(transcriptFailures, 0);
    assert.equal(composerCalls, 1, "the failed read happens before composition");
    const transcript = await kernel.getSession("wake-transcript-retry");
    assert.match(JSON.stringify(transcript.messages), /瞬态读取恢复后，我醒来啦。/);
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
    assert.ok(kernel.store.actions.some((action) =>
      action.actionType === "conversation_wake_notification" && action.status === "failed" &&
      action.payload.phase === "delivery"
    ));
    assert.ok(kernel.store.actions.some((action) =>
      action.actionType === "conversation_wake_notification" && action.status === "completed"
    ));
  } finally {
    kernel.sessionRuntime.getConversationTranscript = originalTranscript;
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("retracting an inbox message that aborted active wake composition lets the watchdog deliver", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-wake-inbox-watchdog-"));
  const model = new ScriptedModelController("wake-inbox-watchdog");
  const composerEntered = deferredValue<void>();
  const releaseFirstComposer = deferredValue<string>();
  let composerCalls = 0;
  let firstComposerSignal: AbortSignal | undefined;
  const kernel = createPersistentScriptedKernel(
    stateDir,
    model,
    true,
    { tiredTokens: 1, hardSleepTokens: 1_000_000 },
    async (_input, signal) => {
      composerCalls += 1;
      if (composerCalls === 1) {
        firstComposerSignal = signal;
        composerEntered.resolve();
        // Exercise cancellation even when an injected composer ignores signal.
        return releaseFirstComposer.promise;
      }
      return "队列撤回后，我回来找你了。";
    },
    [0],
    false,
  );
  try {
    const character = kernel.createCharacter({ name: "Inbox 看门狗角色" });
    const conversation = await kernel.openCanonicalPrivateConversation(character.id);
    await checkpointConversationForWake(
      kernel,
      model,
      conversation.id,
      character.id,
    );
    const firstWake = kernel.flushConversationWakeNotifications(conversation.id);
    await composerEntered.promise;
    const queued = await kernel.enqueuePrivateMessage(
      conversation.id,
      {
        mode: "sms",
        characterId: character.id,
        text: "这条消息会立即撤回",
      },
      "wake-inbox-watchdog-message",
    );
    assert.equal(queued.status, "queued");
    assert.equal(
      await settlesWithin(
        firstWake,
        1_500,
        "inbox enqueue did not release the wake queue after aborting composition",
      ),
      0,
    );
    assert.equal(firstComposerSignal?.aborted, true);
    kernel.retractQueuedPrivateMessage(conversation.id, queued.id);
    assert.equal(kernel.privateInboxSnapshot(conversation.id).messages.length, 0);

    await waitForCondition(
      () => kernel.getConversationMetadata(conversation.id)?.sleepState === "awake",
      3_000,
      "retracted inbox message left the pending wake stranded",
    );
    assert.equal(composerCalls, 2);
    assert.equal(kernel.getConversationMetadata(conversation.id)?.pendingWakeNotificationId, undefined);
    const transcript = await kernel.getSession(conversation.id);
    assert.match(JSON.stringify(transcript.messages), /队列撤回后，我回来找你了。/);
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/conversation_wake"
      ).length,
      1,
    );
  } finally {
    releaseFirstComposer.resolve("被 inbox 中止的旧醒来文案绝不能投递。");
    kernel.dispose();
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
  conversationWakeComposer?: CompanionKernelOptions["conversationWakeComposer"],
  conversationWakeRetryDelaysMs?: readonly number[],
  startPrivateInboxCoordinator?: boolean,
): CompanionKernel {
  const kernel = new CompanionKernel({
    stateDir,
    modelResolver: model.resolver,
    startScheduler: false,
    quietHours: false,
    conversationLifecycleThresholds,
    conversationWakeComposer,
    conversationWakeRetryDelaysMs,
    startPrivateInboxCoordinator,
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

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function checkpointConversationForWake(
  kernel: CompanionKernel,
  model: ScriptedModelController,
  sessionId: string,
  characterId: string,
): Promise<void> {
  model.enqueue([
    { kind: "assistant_text", text: `先形成足够长的休息上下文。${"abcd".repeat(6_000)}` },
    { kind: "assistant_text", text: "晚安，我先休息一下。" },
  ]);
  await kernel.sendMessage(sessionId, {
    mode: "sms",
    characterId,
    text: "先聊一句",
  });
  await kernel.sendMessage(sessionId, {
    mode: "sms",
    characterId,
    text: "晚安咯",
  });
  assert.ok(kernel.getConversationMetadata(sessionId)?.pendingWakeNotificationId);
}

async function settlesWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
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
