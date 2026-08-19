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
import { ScriptedModelController } from "../src/testing/runtime.js";

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
    first = createPersistentScriptedKernel(stateDir, model);
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
    first.dispose();
    first = undefined;

    second = createPersistentScriptedKernel(stateDir, model, false);
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

function createPersistentScriptedKernel(
  stateDir: string,
  model: ScriptedModelController,
  configure = true,
): CompanionKernel {
  const kernel = new CompanionKernel({
    stateDir,
    modelResolver: model.resolver,
    startScheduler: false,
    quietHours: false,
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
