import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("SMS and RP enforce distinct role, context, scene, and tool contracts", async () => {
  const runtime = createTestRuntime({ seed: "mode-contract" });
  try {
    const character = runtime.kernel.createCharacter({
      name: "牧濑红莉栖",
      soulMarkdown: [
        "# SOUL.md - 牧濑红莉栖",
        "",
        "## 核心身份",
        "",
        "理性、敏锐，不使用客服式套话。",
      ].join("\n"),
    });
    runtime.kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      content: "用户与角色约定遇到问题时直说",
      characterId: character.id,
      confirmed: true,
    });
    runtime.kernel.updateScene("sms-contract", {
      location: "未来道具研究所",
      summary: "角色正在检查实验数据。",
    }, character.id);
    runtime.kernel.updateScene("rp-contract", {
      location: "广播会馆楼顶",
      summary: "夜风吹过，实验进入关键阶段。",
    }, character.id);
    runtime.kernel.patchAgentPermissions({
      characterSoulWriteEnabled: true,
      realityMemoryWriteEnabled: true,
      characterMemoryWriteEnabled: true,
    });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "我记得，问题就直说。" },
      { kind: "assistant_text", text: "夜风掠过楼顶，她转身看向来人。\n\n“实验还没结束。”" },
      { kind: "assistant_text", text: "普通 API 对话仍可继续。" },
    ]);

    await runtime.kernel.sendMessage("sms-contract", {
      mode: "sms",
      characterId: character.id,
      text: "还记得我们的约定吗？",
    });
    const sms = runtime.model.requests[0];
    assert.match(sms.systemPrompt, /你就是所选角色本人/);
    assert.match(sms.systemPrompt, /第一人称即时消息口吻/);
    assert.match(sms.systemPrompt, /禁止旁白、第三人称自称、动作括号或星号动作/);
    assert.match(sms.systemPrompt, /Character: 牧濑红莉栖/);
    assert.match(sms.systemPrompt, /理性、敏锐/);
    assert.match(JSON.stringify(sms.messages), /用户与角色约定遇到问题时直说/);
    assert.doesNotMatch(sms.systemPrompt, /用户与角色约定遇到问题时直说/);
    assert.doesNotMatch(sms.systemPrompt, /Current scene:/);
    assert.doesNotMatch(sms.systemPrompt, /未来道具研究所/);
    assert.equal(sms.toolNames.includes("search_memory"), true);
    assert.equal(sms.toolNames.includes("propose_memory"), true);
    assert.equal(sms.toolNames.includes("update_scene"), false);
    assert.equal(sms.toolNames.includes("get_current_character_soul"), true);
    assert.equal(sms.toolNames.includes("update_current_character_soul"), true);
    assert.match(sms.systemPrompt, /Current-character SOUL\.md reading and writing are available/);
    assert.doesNotMatch(sms.systemPrompt, /unavailable in this SMS session/);

    await runtime.kernel.sendMessage("rp-contract", {
      mode: "rp",
      characterId: character.id,
      text: "继续楼顶的剧情，并遵守遇到问题时直说的约定。",
    });
    const rp = runtime.model.requests[1];
    assert.match(rp.systemPrompt, /第三人称剧情演绎/);
    assert.match(rp.systemPrompt, /以环境、动作、角色对白组织回复/);
    assert.match(rp.systemPrompt, /不必机械重复地点名称/);
    assert.match(rp.systemPrompt, /不得退化成纯私聊式的一两句即时消息/);
    assert.match(rp.systemPrompt, /Character: 牧濑红莉栖/);
    assert.match(JSON.stringify(rp.messages), /用户与角色约定遇到问题时直说/);
    assert.match(JSON.stringify(rp.messages), /Current scene/);
    assert.match(JSON.stringify(rp.messages), /广播会馆楼顶/);
    assert.doesNotMatch(rp.systemPrompt, /广播会馆楼顶/);
    assert.equal(rp.toolNames.includes("search_memory"), true);
    assert.equal(rp.toolNames.includes("propose_memory"), true);
    assert.equal(rp.toolNames.includes("update_scene"), true);
    assert.equal(rp.toolNames.includes("get_current_character_soul"), true);
    assert.match(rp.systemPrompt, /Current-character SOUL\.md reading and writing are available/);

    await runtime.kernel.sendMessage("unbound-contract", {
      mode: "sms",
      text: "直接 API 未绑定角色时仍保持兼容。",
    });
    const unbound = runtime.model.requests[2];
    assert.equal(unbound.toolNames.includes("search_memory"), true);
    assert.equal(unbound.toolNames.includes("propose_memory"), true);
    assert.equal(unbound.toolNames.includes("update_scene"), false);
    assert.equal(unbound.toolNames.includes("get_current_character_soul"), false);
    assert.match(unbound.systemPrompt, /SMS session has no character/);
    assert.doesNotMatch(unbound.systemPrompt, /reading and writing are available/);
    assert.doesNotMatch(unbound.systemPrompt, /Character SOUL\.md \(authoritative role definition\)/);
  } finally {
    runtime.dispose();
  }
});
