import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";

const SPECIALIST_MARKDOWN = [
  "# 公开资料核验",
  "",
  "## 方法",
  "",
  "- 先拆分需要核验的事实主张和时间边界。",
  "- 优先比较一手来源，并明确区分事实、推断与未知信息。",
  "- 交付前复核引用是否真正支持结论。",
].join("\n");

test("character-owned Skills isolate bodies by owner and space while exposing bounded public metadata", () => {
  const runtime = createTestRuntime({ seed: "owned-skills-isolation" });
  try {
    const owner = runtime.kernel.createCharacter({ name: "核验员" });
    const peer = runtime.kernel.createCharacter({ name: "协作者" });
    runtime.kernel.updateCharacterCollaborationProfile(owner.id, {
      introduction: "公开资料核验员",
      traits: ["严谨"],
      maxConcurrentTasks: 2,
    });
    const normal = runtime.kernel.createCharacterOwnedSkill(owner.id, {
      name: "来源核验",
      description: "核对公开资料、发布日期和原始出处。",
      tags: ["research", "verification"],
      markdown: SPECIALIST_MARKDOWN,
      autoImprove: true,
      activate: true,
    });
    const secret = runtime.kernel.createCharacterOwnedSkill(owner.id, {
      name: "SECRET_SKILL_NAME_SENTINEL",
      description: "SECRET_SKILL_DESCRIPTION_SENTINEL",
      tags: ["secret-skill-tag-sentinel"],
      markdown: "# SECRET_SKILL_BODY_SENTINEL\n\n- 这段私密工作方法只能在所属角色的私密空间中使用，不能进入公开目录。",
      activate: true,
    }, "secret");

    assert.ok(runtime.kernel.listCharacterOwnedSkills(owner.id, "normal")
      .some((entry) => entry.id === normal.id));
    assert.deepEqual(
      runtime.kernel.listCharacterOwnedSkills(peer.id, "normal")
        .filter((entry) => entry.id === normal.id),
      [],
    );
    assert.ok(runtime.kernel.listCharacterOwnedSkills(owner.id, "secret")
      .some((entry) => entry.id === secret.id));

    const publicSummary = runtime.kernel.characterCapabilities.getPublicSummary(owner.id);
    const publicJson = JSON.stringify(publicSummary);
    assert.ok(publicSummary.skills.some((entry) => entry.id === normal.id));
    assert.doesNotMatch(publicJson, /SECRET_SKILL/);
    assert.doesNotMatch(publicJson, /先拆分需要核验/);
  } finally {
    runtime.dispose();
  }
});

test("direct character turns receive only that character's active Skills from the current space", async () => {
  const runtime = createTestRuntime({ seed: "owned-skills-direct-context" });
  try {
    const owner = runtime.kernel.createCharacter({ name: "方法专家" });
    runtime.kernel.createCharacterOwnedSkill(owner.id, {
      name: "普通核验方法",
      description: "普通空间的公开资料核验流程。",
      markdown: "# NORMAL_OWNED_SKILL_BODY\n\n- 只属于当前角色的普通空间方法。",
      activate: true,
    });
    runtime.kernel.createCharacterOwnedSkill(owner.id, {
      name: "私密核验方法",
      description: "私密空间的独立核验流程。",
      markdown: "# SECRET_OWNED_SKILL_BODY\n\n- 只属于当前角色的私密空间方法。",
      activate: true,
    }, "secret");
    runtime.model.enqueue([
      { kind: "assistant_text", text: "普通空间完成。" },
      { kind: "assistant_text", text: "私密空间完成。" },
    ]);

    await runtime.kernel.sendMessage("owned-skill-direct-normal", {
      mode: "sms",
      conversationSpace: "normal",
      characterId: owner.id,
      text: "按你的专属方法处理。",
    });
    const normalPayload = JSON.stringify(runtime.model.requests.at(-1)?.providerPayload);
    assert.match(normalPayload, /NORMAL_OWNED_SKILL_BODY/);
    assert.doesNotMatch(normalPayload, /SECRET_OWNED_SKILL_BODY/);

    await runtime.kernel.sendMessage("owned-skill-direct-secret", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: owner.id,
      text: "按你的私密专属方法处理。",
    });
    const secretPayload = JSON.stringify(runtime.model.requests.at(-1)?.providerPayload);
    assert.match(secretPayload, /SECRET_OWNED_SKILL_BODY/);
    assert.doesNotMatch(secretPayload, /NORMAL_OWNED_SKILL_BODY/);
  } finally {
    runtime.dispose();
  }
});

test("Skill-aware routing selects the owner and injects only explicitly selected packages", () => {
  const runtime = createTestRuntime({ seed: "owned-skills-routing" });
  try {
    const { characters } = setupWorld(runtime, ["委托者", "核验专家", "普通同伴"]);
    const [source, specialist, peer] = characters;
    for (const character of [specialist, peer]) {
      runtime.kernel.updateCharacterCollaborationProfile(character.id, {
        introduction: character.id === specialist.id ? "核验专家" : "普通协作者",
        maxConcurrentTasks: 2,
      });
    }
    const selected = runtime.kernel.createCharacterOwnedSkill(specialist.id, {
      name: "来源核验",
      description: "适合核查公开资料。",
      markdown: SPECIALIST_MARKDOWN,
      activate: true,
    });
    runtime.kernel.createCharacterOwnedSkill(specialist.id, {
      name: "无关写作 Skill",
      description: "不应注入本次任务。",
      markdown: "# UNSELECTED_SKILL_BODY_SENTINEL\n\n- 只处理创意写作任务，不参与公开来源核验，也不应出现在本次目标上下文中。",
      activate: true,
    });

    const route = runtime.kernel.previewCharacterTaskRoute({
      sourceCharacterId: source.id,
      task: "核对一条公开资料",
      requiredSkillIds: [selected.id],
    });
    assert.equal(route.selected?.characterId, specialist.id);
    assert.deepEqual(route.selectedSkillIds, [selected.id]);
    assert.deepEqual(route.selected?.matchedSkillIds, [selected.id]);
    const taskSkill = runtime.kernel.characterCapabilities.getTaskSkill(
      specialist.id,
      "normal",
      route.selectedSkillIds,
    );
    assert.deepEqual(taskSkill?.packages.map((entry) => entry.id), [selected.id]);
    assert.match(taskSkill?.packages[0]?.markdown ?? "", /先拆分需要核验/);
    assert.doesNotMatch(JSON.stringify(taskSkill), /UNSELECTED_SKILL_BODY_SENTINEL/);
  } finally {
    runtime.dispose();
  }
});

test("Skill execution creates evaluations and reviewable proposals without silently replacing the active version", async () => {
  const runtime = createTestRuntime({
    seed: "owned-skills-reflection",
    characterSkillReflector: async () => ({
      shouldUpdate: true,
      markdown: SPECIALIST_MARKDOWN + "\n- 新增：遇到来源冲突时记录冲突原因并保留双方日期。",
      changeSummary: "增加来源冲突处理步骤",
    }),
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "复盘专家" });
    runtime.kernel.updateCharacterCollaborationProfile(character.id, {
      introduction: "资料核验员",
      maxConcurrentTasks: 1,
    });
    const skill = runtime.kernel.createCharacterOwnedSkill(character.id, {
      name: "来源核验",
      description: "核验公开来源。",
      markdown: SPECIALIST_MARKDOWN,
      autoImprove: true,
      activate: true,
    });
    const originalVersionId = skill.activeVersion?.id;

    runtime.kernel.characterCapabilities.recordTaskEvidence({
      characterId: character.id,
      skillPackageIds: [skill.id],
      sourceTaskId: "owned-skill-task-1",
      outcome: "completed",
      summary: "完成来源核验并发现两个日期冲突。",
      functionalScore: 88,
      judgeScore: 92,
    });
    await runtime.kernel.characterCapabilities.waitForIdle();

    const beforeReview = runtime.kernel.getCharacterOwnedSkillReview(character.id, skill.id);
    assert.equal(beforeReview.evaluations.length, 1);
    assert.equal(beforeReview.evaluations[0].score, 90);
    assert.equal(beforeReview.proposals.filter((entry) => entry.status === "pending").length, 1);
    assert.equal(
      runtime.kernel.listCharacterOwnedSkills(character.id)
        .find((entry) => entry.id === skill.id)?.activeVersion?.id,
      originalVersionId,
      "reflection must not silently replace an active Skill",
    );

    const proposal = beforeReview.proposals.find((entry) => entry.status === "pending")!;
    const approved = runtime.kernel.reviewCharacterOwnedSkillProposal(
      character.id,
      skill.id,
      proposal.id,
      "approve",
    );
    assert.ok("version" in approved);
    assert.equal(approved.version, 2);
    assert.match(approved.markdown, /来源冲突/);
    assert.equal(
      runtime.kernel.getCharacterOwnedSkillReview(character.id, skill.id)
        .proposals.find((entry) => entry.id === proposal.id)?.status,
      "approved",
    );
  } finally {
    runtime.dispose();
  }
});

test("character-owned Skill HTTP mutations require the local control plane and round-trip through the scoped API", async () => {
  const runtime = createTestRuntime({ seed: "owned-skills-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  try {
    const character = runtime.kernel.createCharacter({ name: "HTTP Skill 角色" });
    runtime.kernel.updateCharacterCollaborationProfile(character.id, {
      introduction: "资料核验员",
      maxConcurrentTasks: 1,
    });
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const endpoint = `${origin}/api/v1/characters/${encodeURIComponent(character.id)}/owned-skills`;
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "拒绝", markdown: SPECIALIST_MARKDOWN }),
    });
    assert.equal(rejected.status, 403);

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = {
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    const createdResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "来源核验",
        description: "核对公开资料来源。",
        markdown: SPECIALIST_MARKDOWN,
        activate: true,
      }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = JSON.parse(createdText) as { skill: { id: string } };
    const listed = await fetch(endpoint);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { skills: Array<{ id: string; activeVersion?: { markdown: string } }> };
    assert.match(
      listedBody.skills.find((entry) => entry.id === created.skill.id)?.activeVersion?.markdown ?? "",
      /先拆分需要核验/,
    );
  } finally {
    await close(server);
    runtime.dispose();
  }
});

function setupWorld(runtime: TestRuntime, names: string[]) {
  const characters = names.map((name) => runtime.kernel.createCharacter({ name }));
  const world = runtime.kernel.createWorld({ name: "专属 Skill 测试世界", timezone: "Asia/Shanghai" });
  const place = runtime.kernel.createWorldPlace({
    worldId: world.id,
    name: "共同办公室",
    capabilityIds: ["work", "study", "communicate", "rest"],
  });
  for (const character of characters) {
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
  }
  return { characters, world, place };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
