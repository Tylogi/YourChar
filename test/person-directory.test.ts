import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestRuntime } from "../src/testing/index.js";

test("confirmed person memories project into editable Vault profiles with character visibility", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-person-directory-"));
  const runtime = createTestRuntime({ stateDir, seed: "person-directory" });
  try {
    const visibleCharacter = runtime.kernel.createCharacter({ name: "可见角色" });
    const hiddenCharacter = runtime.kernel.createCharacter({ name: "隐藏角色" });
    const first = runtime.kernel.createControlPlaneMemory({
      realm: "reality",
      type: "person",
      key: "person:lin_xia",
      content: "林夏是我的大学同学。",
      sourceSessionId: "person_session",
      sourceMessageId: "person_message_1",
      salience: 0.8,
      confidence: 0.96,
      tags: ["person-name:林夏", "person-relationship:大学同学"],
      idempotencyKey: "person-directory:first",
    });

    const created = runtime.kernel.listPersonProfiles();
    assert.equal(created.length, 1);
    assert.equal(created[0].displayName, "林夏");
    assert.equal(created[0].relationship, "大学同学");
    assert.deepEqual(created[0].sourceMemoryIds, [first.id]);
    assert.match(created[0].markdown, /林夏是我的大学同学/);
    assert.match(created[0].markdown, /置信度：0\.96/);
    const profilePath = join(stateDir, "memory-vault", "reality", "people", `${created[0].id}.md`);
    assert.equal(existsSync(profilePath), true);
    assert.match(readFileSync(profilePath, "utf8"), /kind: person_profile/);

    const edited = runtime.kernel.updatePersonProfile(created[0].id, {
      aliases: ["小夏"],
      visibility: "selected_characters",
      visibleToCharacterIds: [visibleCharacter.id],
      markdown: "# 林夏\n\n用户手写备注：喜欢摄影。\n",
    });
    assert.deepEqual(edited.aliases, ["小夏"]);
    assert.equal(edited.visibility, "selected_characters");

    const visiblePlan = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "person-visible-preview",
      characterId: visibleCharacter.id,
      query: "林夏喜欢什么？",
      allowBootstrap: false,
    });
    assert.equal(visiblePlan.retrieval[0].candidates.some((entry) => entry.memoryId === first.id), true);
    assert.match(visiblePlan.retrieval[0].candidates.find((entry) => entry.memoryId === first.id)!.content, /喜欢摄影/);
    assert.equal(visiblePlan.selectedMemoryIds.includes(first.id), true);

    const hiddenPlan = runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "person-hidden-preview",
      characterId: hiddenCharacter.id,
      query: "林夏喜欢什么？",
      allowBootstrap: false,
    });
    assert.equal(hiddenPlan.retrieval[0].candidates.some((entry) => entry.memoryId === first.id), false);

    const replacement = runtime.kernel.createControlPlaneMemory({
      realm: "reality",
      type: "person",
      key: "person:lin_xia",
      content: "林夏是我的大学同学，现在从事摄影工作。",
      sourceSessionId: "person_session",
      sourceMessageId: "person_message_2",
      salience: 0.82,
      confidence: 0.98,
      tags: ["person-name:林夏", "person-relationship:大学同学"],
      idempotencyKey: "person-directory:replacement",
    });
    const refreshed = runtime.kernel.listPersonProfiles()[0];
    assert.match(refreshed.markdown, /用户手写备注：喜欢摄影/);
    assert.match(refreshed.markdown, /现在从事摄影工作/);
    assert.doesNotMatch(refreshed.markdown, /- 林夏是我的大学同学。\n/);
    assert.deepEqual(refreshed.sourceMemoryIds.sort(), [first.id, replacement.id].sort());
    assert.equal(refreshed.visibility, "selected_characters");

    runtime.kernel.archiveMemory(replacement.id, "person no longer retained as active context");
    const inactive = runtime.kernel.listPersonProfiles()[0];
    assert.match(inactive.markdown, /用户手写备注：喜欢摄影/);
    assert.doesNotMatch(inactive.markdown, /林夏是我的大学同学/);
    assert.doesNotMatch(inactive.markdown, /现在从事摄影工作/);
    assert.equal(inactive.confidence, 0);
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("later structured evidence upgrades an automatically derived person name", () => {
  const runtime = createTestRuntime({ seed: "person-directory-name-upgrade" });
  try {
    runtime.kernel.createControlPlaneMemory({
      realm: "reality",
      type: "person",
      key: "person:zhou_ning",
      content: "我的室友是周宁。",
      sourceSessionId: "person_name_upgrade",
      sourceMessageId: "person_name_legacy",
      confidence: 0.9,
      idempotencyKey: "person-name-upgrade:legacy",
    });
    const initial = runtime.kernel.listPersonProfiles()[0];
    assert.equal(initial.displayName, "zhou ning");
    runtime.kernel.updatePersonProfile(initial.id, {
      markdown: `${initial.markdown}\n用户手写备注：一起做过项目。\n`,
    });

    runtime.kernel.createControlPlaneMemory({
      realm: "reality",
      type: "person",
      key: "person:zhou_ning",
      content: "周宁是我的室友。",
      sourceSessionId: "person_name_upgrade",
      sourceMessageId: "person_name_structured",
      confidence: 0.98,
      tags: ["person-name:周宁", "person-relationship:室友"],
      idempotencyKey: "person-name-upgrade:structured",
    });
    const upgraded = runtime.kernel.listPersonProfiles()[0];
    assert.equal(upgraded.displayName, "周宁");
    assert.equal(upgraded.relationship, "室友");
    assert.match(upgraded.markdown, /^# 周宁/u);
    assert.match(upgraded.markdown, /用户手写备注：一起做过项目/);
  } finally {
    runtime.dispose();
  }
});

test("daily person extraction keeps exact evidence and structures directory metadata", async () => {
  const runtime = createTestRuntime({
    seed: "person-directory-extraction",
    memoryExtractor: async () => ({
      candidates: [{
        type: "person",
        key: "person:lin_xia",
        content: "林夏是用户的大学同学",
        confidence: 0.97,
        evidence: { user: "林夏是我的大学同学" },
        person: { name: "林夏", aliases: ["小夏"], relationship: "大学同学" },
      }],
    }),
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.model.enqueue([{ kind: "assistant_text", text: "原来如此。" }]);
    await runtime.kernel.sendMessage("person-extraction-session", {
      mode: "sms",
      text: "林夏是我的大学同学，大家也叫她小夏。",
    });
    await runtime.kernel.memoryCoordinator.drain();

    const memory = runtime.kernel.listMemories({ realm: "reality", validity: "active" })[0];
    assert.equal(memory.content, "林夏是我的大学同学");
    assert.equal(memory.tags.includes("person-name:林夏"), true);
    assert.equal(memory.tags.includes("person-alias:小夏"), true);
    assert.equal(memory.tags.includes("person-relationship:大学同学"), true);
    const profile = runtime.kernel.listPersonProfiles()[0];
    assert.equal(profile.displayName, "林夏");
    assert.deepEqual(profile.aliases, ["小夏"]);
    assert.equal(profile.relationship, "大学同学");
  } finally {
    runtime.dispose();
  }
});
