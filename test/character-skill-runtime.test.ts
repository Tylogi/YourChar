import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { CompanionKernel } from "../src/domain/index.js";
import { CharacterAgentSkillPackageService } from "../src/modules/character-skill-packages.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime, ScriptedModelController } from "../src/testing/index.js";

test("character Skill management is opt-in, character-bound, and activates workflows for the next turn", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-character-skill-runtime-"));
  const runtime = createTestRuntime({
    seed: "character-skill-runtime",
    stateDir,
    startPrivateInboxCoordinator: false,
  });
  try {
    const character = runtime.kernel.createCharacter({
      name: "小岚",
      soulMarkdown: "# SOUL.md - 小岚\n\n会认真整理可复用的方法。\n",
    });

    runtime.model.enqueue([{ kind: "assistant_text", text: "目前不能维护 Skill。" }]);
    await runtime.kernel.sendMessage("skill-permission-off", {
      mode: "sms",
      characterId: character.id,
      text: "把经验总结成 Skill",
    });
    assert.equal(
      runtime.model.requests[0].toolNames.includes("create_current_character_skill"),
      false,
    );

    runtime.kernel.patchAgentPermissions({ characterSkillManageEnabled: true });
    const draftMarkdown = [
      "# 复盘工作法",
      "",
      "1. 先核对目标和证据。",
      "2. 记录失败原因。",
      "3. 给出下次可验证的改进步骤。",
      "",
      "RUNTIME_DRAFT_SENTINEL",
    ].join("\n");
    runtime.model.enqueue([
      {
        kind: "tool_call",
        id: "draft-skill-call-1",
        name: "create_current_character_skill",
        arguments: {
          name: "复盘工作法",
          description: "把任务经验整理为可复用的复盘步骤。",
          tags: ["复盘", "质量"],
          markdown: draftMarkdown,
        },
      },
      { kind: "assistant_text", text: "我已经保存并启用，下轮会使用。" },
    ]);
    const response = await runtime.kernel.sendMessage("skill-permission-on", {
      mode: "sms",
      characterId: character.id,
      text: "请把刚才的经验总结成你自己的 Skill 并启用。",
    });

    assert.equal(
      runtime.model.requests[1].toolNames.includes("create_current_character_skill"),
      true,
    );
    const skills = runtime.kernel.listCharacterOwnedSkills(character.id, "normal");
    assert.equal(skills.length, 1);
    assert.equal(skills[0].status, "active");
    assert.ok(skills[0].activeVersion);
    const versions = runtime.kernel.listCharacterOwnedSkillVersions(
      character.id,
      skills[0].id,
      "normal",
    );
    assert.equal(versions.length, 1);
    assert.equal(versions[0].status, "active");
    assert.equal(versions[0].markdown, draftMarkdown);
    assert.equal(
      response.actions.some((action) =>
        action.actionType === "create_character_skill" && action.status === "completed"),
      true,
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "新会话继续。" }]);
    await runtime.kernel.sendMessage("skill-active-next-turn", {
      mode: "sms",
      characterId: character.id,
      text: "开始一个新任务。",
    });
    const freshRequest = runtime.model.requests.at(-1)!;
    assert.match(freshRequest.systemPrompt, /RUNTIME_DRAFT_SENTINEL/u);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("autonomous remote package content appears only on rebuilt next-turn handles and stays scope-bound", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-character-skill-remote-runtime-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const model = new ScriptedModelController("character-skill-remote-runtime");
  const descriptionSentinel = "REMOTE_PACKAGE_DESCRIPTION_SENTINEL";
  const bodySentinel = "REMOTE_PACKAGE_BODY_SENTINEL";
  const packageName = "remote-next-turn-skill";
  const packageService = new CharacterAgentSkillPackageService({
    database,
    stateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      response: new Response(Uint8Array.from(zipSync({
        "bundle/SKILL.md": strToU8([
          "---",
          `name: ${packageName}`,
          `description: ${descriptionSentinel}`,
          "---",
          "",
          "# Remote next-turn workflow",
          "",
          bodySentinel,
          "",
        ].join("\n")),
      })).buffer, { headers: { "content-type": "application/zip" } }),
    }),
  });
  const kernel = new CompanionKernel({
    stateDir,
    database,
    characterSkillPackages: packageService,
    modelResolver: model.resolver,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    imGateway: false,
  });
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: "http://test.invalid/v1",
      model: "scripted-model",
      temperature: 0,
    });
    const owner = kernel.createCharacter({ name: "远程 Skill 所有者" });
    const other = kernel.createCharacter({ name: "另一个角色" });
    kernel.patchAgentPermissions({
      workspaceAccess: "read_only",
      characterSkillManageEnabled: true,
    });

    // These handles predate installation. The install tool must request a
    // refresh for every same-owner/same-space handle, not only its caller.
    model.enqueue([
      { kind: "assistant_text", text: "owner RP ready" },
      { kind: "assistant_text", text: "other RP ready" },
      { kind: "assistant_text", text: "owner secret ready" },
    ]);
    await kernel.sendMessage("remote-owner-rp", {
      mode: "rp",
      characterId: owner.id,
      text: "prewarm owner RP",
    });
    await kernel.sendMessage("remote-other-rp", {
      mode: "rp",
      characterId: other.id,
      text: "prewarm other RP",
    });
    await kernel.sendMessage("remote-owner-secret", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: owner.id,
      text: "prewarm owner secret",
    });

    const ownerHash = createHash("sha256").update(owner.id).digest("hex");
    const installedPath = join(
      stateDir,
      "character-agent-skills",
      ownerHash,
      "normal",
      "skills",
      packageName,
      "SKILL.md",
    );
    const installTurnStart = model.requests.length;
    model.enqueue([
      {
        kind: "tool_call",
        name: "install_current_character_skill",
        arguments: { sourceUrl: "https://downloads.example.com/remote-next-turn-skill.zip" },
      },
      {
        kind: "tool_call",
        name: "search_available_agent_skills",
        arguments: { query: packageName },
      },
      { kind: "tool_call", name: "read", arguments: { path: installedPath } },
      { kind: "assistant_text", text: "installed for next turn" },
    ]);
    await kernel.sendMessage("remote-owner-sms", {
      mode: "sms",
      characterId: owner.id,
      text: "choose and install a remote Skill",
    });
    const installTurnPayload = JSON.stringify(model.requests.slice(installTurnStart));
    assert.doesNotMatch(installTurnPayload, new RegExp(descriptionSentinel));
    assert.doesNotMatch(installTurnPayload, new RegExp(bodySentinel));
    assert.match(installTurnPayload, /read is restricted to the workspace and enabled Skill directories/);
    assert.equal(packageService.list({
      characterId: owner.id,
      conversationSpace: "normal",
    })[0].enabled, true);

    const assertLoadedAndReadable = async (
      sessionId: string,
      request: { mode: "sms" | "rp"; characterId: string; text: string },
    ) => {
      const start = model.requests.length;
      model.enqueue([
        { kind: "tool_call", name: "read", arguments: { path: installedPath } },
        { kind: "assistant_text", text: "loaded and read" },
      ]);
      await kernel.sendMessage(sessionId, request);
      const requests = model.requests.slice(start);
      assert.match(requests[0].systemPrompt, new RegExp(descriptionSentinel));
      assert.match(JSON.stringify(requests), new RegExp(bodySentinel));
    };
    await assertLoadedAndReadable("remote-owner-sms", {
      mode: "sms",
      characterId: owner.id,
      text: "use it on the next turn",
    });
    await assertLoadedAndReadable("remote-owner-rp", {
      mode: "rp",
      characterId: owner.id,
      text: "use it in the pre-existing RP session",
    });

    const assertScopeCannotSeePackage = async (
      sessionId: string,
      request: {
        mode: "sms" | "rp";
        characterId: string;
        conversationSpace?: "normal" | "secret";
        text: string;
      },
    ) => {
      const start = model.requests.length;
      model.enqueue([
        {
          kind: "tool_call",
          name: "search_available_agent_skills",
          arguments: { query: packageName },
        },
        { kind: "tool_call", name: "read", arguments: { path: installedPath } },
        { kind: "assistant_text", text: "not visible here" },
      ]);
      await kernel.sendMessage(sessionId, request);
      const payload = JSON.stringify(model.requests.slice(start));
      assert.doesNotMatch(payload, new RegExp(descriptionSentinel));
      assert.doesNotMatch(payload, new RegExp(bodySentinel));
      assert.match(payload, /read is restricted to the workspace and enabled Skill directories/);
    };
    await assertScopeCannotSeePackage("remote-other-rp", {
      mode: "rp",
      characterId: other.id,
      text: "look for the owner's package",
    });
    await assertScopeCannotSeePackage("remote-owner-secret", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: owner.id,
      text: "look for the normal-space package",
    });
  } finally {
    kernel.dispose();
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
