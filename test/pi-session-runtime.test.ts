import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanionKernel,
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  type MessageResponse,
} from "../src/domain/index.js";
import { SessionModeMismatchError } from "../src/pi/index.js";
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
