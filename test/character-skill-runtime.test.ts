import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("character Skill management is opt-in, character-bound, and creates only inactive drafts", async () => {
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
      runtime.model.requests[0].toolNames.includes("create_current_character_skill_draft"),
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
        name: "create_current_character_skill_draft",
        arguments: {
          name: "复盘工作法",
          description: "把任务经验整理为可复用的复盘步骤。",
          tags: ["复盘", "质量"],
          markdown: draftMarkdown,
        },
      },
      { kind: "assistant_text", text: "我已经保存成待审核草稿，没有自行启用。" },
    ]);
    const response = await runtime.kernel.sendMessage("skill-permission-on", {
      mode: "sms",
      characterId: character.id,
      text: "请把刚才的经验总结成你自己的 Skill，先给我审核。",
    });

    assert.equal(
      runtime.model.requests[1].toolNames.includes("create_current_character_skill_draft"),
      true,
    );
    const skills = runtime.kernel.listCharacterOwnedSkills(character.id, "normal");
    assert.equal(skills.length, 1);
    assert.equal(skills[0].status, "draft");
    assert.equal(skills[0].activeVersion, undefined);
    const versions = runtime.kernel.listCharacterOwnedSkillVersions(
      character.id,
      skills[0].id,
      "normal",
    );
    assert.equal(versions.length, 1);
    assert.equal(versions[0].status, "draft");
    assert.equal(versions[0].markdown, draftMarkdown);
    assert.equal(
      response.actions.some((action) =>
        action.actionType === "create_character_skill_draft" && action.status === "completed"),
      true,
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "新会话继续。" }]);
    await runtime.kernel.sendMessage("skill-draft-not-active", {
      mode: "sms",
      characterId: character.id,
      text: "开始一个新任务。",
    });
    const freshRequest = runtime.model.requests.at(-1)!;
    assert.doesNotMatch(JSON.stringify(freshRequest.messages), /RUNTIME_DRAFT_SENTINEL/u);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
