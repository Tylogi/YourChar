import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { AgentModuleCatalog } from "../src/modules/index.js";
import { createSkillReadTool } from "../src/pi/skill-read-tool.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/index.js";

test("module toggles rebuild Pi capabilities and profile context without losing conversation", async () => {
  const runtime = createTestRuntime({ seed: "module-toggle" });
  try {
    const modules = runtime.kernel.listAgentModules();
    assert.deepEqual(modules.map((entry) => [entry.type, entry.name, entry.enabled]), [
      ["mcp", "Interaction State MCP", true],
      ["mcp", "Memory Coordinator MCP", true],
      ["mcp", "Relationship State MCP", false],
      ["mcp", "Schedule MCP", true],
      ["mcp", "Subagent Delegation MCP", false],
      ["mcp", "Tavily Search MCP", false],
      ["mcp", "User Profile MCP", true],
      ["mcp", "Vision MCP", false],
      ["mcp", "Web Reader MCP", false],
      ["mcp", "World State MCP", true],
      ["skill", "daily-planning", false],
      ["skill", "roleplay-continuity", false],
    ]);
    assert.deepEqual(
      modules.filter((entry) => entry.type === "mcp").map((entry) => [entry.name, entry.estimatedTokens]),
      [["Interaction State MCP", 650], ["Memory Coordinator MCP", 430], ["Relationship State MCP", 230], ["Schedule MCP", 960], ["Subagent Delegation MCP", 390], ["Tavily Search MCP", 350], ["User Profile MCP", 270], ["Vision MCP", 420], ["Web Reader MCP", 260], ["World State MCP", 860]],
    );
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:interaction-state").content, /begin_meeting/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:interaction-state").content, /semantic evidence/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:schedule").content, /calendar=character/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:schedule").content, /never reminders or system notifications/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:subagent").content, /delegate_task/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:subagent").content, /At most three tasks/);
    assert.match(runtime.kernel.getAgentModuleDetail("mcp:relationship-state").content, /get_relationship_state/);
    assert.ok(modules.filter((entry) => entry.type === "skill").every((entry) =>
      entry.estimatedTokens > 0 && (entry.fullContentEstimatedTokens ?? 0) > 0
    ));
    const planning = modules.find((entry) => entry.name === "daily-planning");
    assert.ok(planning);
    runtime.kernel.setAgentModuleEnabled(planning.id, true);
    runtime.kernel.updateUserProfile("# 用户画像\n\n- 称呼：Vector\n- 沟通：直接、简洁");

    runtime.model.enqueue([
      { kind: "tool_call", name: "read", arguments: { path: planning.source } },
      { kind: "assistant_text", text: "第一轮" },
      { kind: "assistant_text", text: "第二轮" },
    ]);
    await runtime.kernel.sendMessage("module-session", { mode: "sms", text: "安排今天" });
    assert.match(runtime.model.requests[0].systemPrompt, /<name>daily-planning<\/name>/);
    assert.match(runtime.model.requests[0].systemPrompt, /称呼：Vector/);
    assert.ok(runtime.model.requests[0].toolNames.includes("read"));
    assert.ok(runtime.model.requests[0].toolNames.includes("create_schedule_item"));
    assert.ok(runtime.model.requests[0].toolNames.includes("update_user_profile"));
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /# Daily Planning/);

    runtime.kernel.setAgentModuleEnabled("mcp:schedule", false);
    runtime.kernel.setAgentModuleEnabled("mcp:user-profile", false);
    await runtime.kernel.sendMessage("module-session", { mode: "sms", text: "继续" });
    assert.equal(runtime.model.requests[2].toolNames.includes("create_schedule_item"), false);
    assert.equal(runtime.model.requests[2].toolNames.includes("update_user_profile"), false);
    assert.equal(runtime.model.requests[2].toolNames.includes("get_user_profile"), false);
    assert.doesNotMatch(runtime.model.requests[2].systemPrompt, /称呼：Vector/);
    assert.match(runtime.model.requests[2].systemPrompt, /User Profile MCP is disabled/);
    assert.equal(runtime.model.requests[2].messages.filter(isUserPrompt).length, 2);
  } finally {
    runtime.dispose();
  }
});

test("generic Agent Skills can be enabled for normal, secret, both, or neither", async () => {
  const runtime = createTestRuntime({ seed: "agent-skill-conversation-spaces" });
  try {
    const character = runtime.kernel.createCharacter({ name: "Skill 空间角色" });
    const planning = runtime.kernel.listAgentModules()
      .find((entry) => entry.name === "daily-planning");
    assert.ok(planning);

    const secretOnly = runtime.kernel.setAgentSkillEnabledSpaces(planning.id, ["secret"]);
    assert.equal(secretOnly.enabled, true);
    assert.deepEqual(secretOnly.enabledSpaces, ["secret"]);
    assert.equal(runtime.kernel.moduleCatalog.enabledSkills("normal").length, 0);
    assert.deepEqual(
      runtime.kernel.moduleCatalog.enabledSkills("secret").map((entry) => entry.name),
      ["daily-planning"],
    );
    assert.equal(runtime.kernel.getAgentModuleDetail(planning.id, "normal").content, "");
    assert.match(
      runtime.kernel.getAgentModuleDetail(planning.id, "secret").content,
      /Daily Planning/,
    );
    assert.equal(
      runtime.kernel.getCharacterFunctionProfile(character.id, "normal").modules
        .find((entry) => entry.id === planning.id)?.enabled,
      false,
    );
    assert.equal(
      runtime.kernel.getCharacterFunctionProfile(character.id, "secret").modules
        .find((entry) => entry.id === planning.id)?.enabled,
      true,
    );

    runtime.model.enqueue([
      { kind: "assistant_text", text: "普通空间" },
      { kind: "assistant_text", text: "私密空间" },
    ]);
    await runtime.kernel.sendMessage("normal-skill-space", {
      mode: "sms",
      conversationSpace: "normal",
      characterId: character.id,
      text: "普通空间检查 Skill",
    });
    await runtime.kernel.sendMessage("secret-skill-space", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "私密空间检查 Skill",
    });
    assert.doesNotMatch(runtime.model.requests[0].systemPrompt, /<name>daily-planning<\/name>/);
    assert.match(runtime.model.requests[1].systemPrompt, /<name>daily-planning<\/name>/);

    const server = createHttpServer({ kernel: runtime.kernel });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const detailPath = `/api/v1/agent-modules/${encodeURIComponent(planning.id)}`;
      const normalDetail = await (await fetch(`${baseUrl}${detailPath}`)).json() as {
        detail: { content: string };
      };
      assert.equal(normalDetail.detail.content, "");
      assert.equal((await fetch(
        `${baseUrl}${detailPath}?conversationSpace=secret`,
      )).status, 400);
      const secretDetail = await (await fetch(
        `${baseUrl}${detailPath}?conversationSpace=secret&characterId=${encodeURIComponent(character.id)}`,
      )).json() as { detail: { content: string } };
      assert.match(secretDetail.detail.content, /Daily Planning/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }

    const both = runtime.kernel.setAgentSkillEnabledSpaces(planning.id, ["normal", "secret"]);
    assert.deepEqual(both.enabledSpaces, ["normal", "secret"]);
    assert.equal(runtime.kernel.moduleCatalog.enabledSkills("normal")[0]?.name, "daily-planning");
    assert.equal(runtime.kernel.moduleCatalog.enabledSkills("secret")[0]?.name, "daily-planning");

    const disabled = runtime.kernel.setAgentSkillEnabledSpaces(planning.id, []);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.enabledSpaces, []);
    assert.equal(runtime.kernel.moduleCatalog.enabledSkills("normal").length, 0);
    assert.equal(runtime.kernel.moduleCatalog.enabledSkills("secret").length, 0);
  } finally {
    runtime.dispose();
  }
});

test("generic Skill discovery and reads stay inside enabled standalone packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-isolated-skills-"));
  const skillsDir = join(root, "skills");
  const outsideDir = join(root, "outside");
  const isolatedDir = join(skillsDir, "isolated");
  const secretOnlyDir = join(skillsDir, "secret-only");
  const linkedFileDir = join(skillsDir, "linked-file");
  const outsidePackageDir = join(outsideDir, "linked-package");
  const database = new AppDatabase(":memory:");
  const clock = new VirtualClock("2026-08-11T08:00:00.000Z");
  try {
    for (const directory of [
      skillsDir,
      outsideDir,
      isolatedDir,
      secretOnlyDir,
      linkedFileDir,
      outsidePackageDir,
    ]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(skillsDir, "foo.md"), skillMarkdown(
      "foo",
      "Legacy root-level Skill that must no longer be discoverable.",
    ));
    writeFileSync(join(isolatedDir, "SKILL.md"), skillMarkdown(
      "isolated",
      "A standard standalone Skill package used for read-boundary tests.",
    ));
    writeFileSync(join(isolatedDir, "reference.txt"), "isolated-resource-sentinel\n", "utf8");
    writeFileSync(join(secretOnlyDir, "SKILL.md"), skillMarkdown(
      "secret-only",
      "A neighboring Skill that is deliberately not enabled in normal space.",
    ));
    writeFileSync(join(outsideDir, "outside-secret.txt"), "outside-secret-sentinel\n", "utf8");
    writeFileSync(join(outsidePackageDir, "SKILL.md"), skillMarkdown(
      "linked-package",
      "A package reached only through a symbolic link.",
    ));
    writeFileSync(join(outsideDir, "linked-skill.md"), skillMarkdown(
      "linked-file",
      "A SKILL.md file reached only through a symbolic link.",
    ));
    symlinkSync(outsidePackageDir, join(skillsDir, "linked-package"), "dir");
    symlinkSync(join(outsideDir, "linked-skill.md"), join(linkedFileDir, "SKILL.md"), "file");
    symlinkSync(
      join(outsideDir, "outside-secret.txt"),
      join(isolatedDir, "outside-link.txt"),
      "file",
    );

    // A stale pre-isolation setting must not resurrect a root-level Markdown Skill.
    database.connection.prepare(`
      INSERT INTO agent_skill_space_settings(
        module_id, normal_enabled, secret_enabled, updated_at
      ) VALUES (?, 1, 0, ?)
    `).run("skill:foo", clock.now().toISOString());
    const catalog = new AgentModuleCatalog(database, clock, {
      cwd: root,
      stateDir: join(root, "state"),
    });
    const discoveredSkillNames = catalog.listModules()
      .filter((entry) => entry.type === "skill")
      .map((entry) => entry.name);
    assert.deepEqual(discoveredSkillNames, ["isolated", "secret-only"]);
    assert.equal(catalog.enabledSkills("normal").length, 0);
    assert.equal(catalog.listModules().some((entry) => entry.id === "skill:foo"), false);
    assert.equal(catalog.listModules().some((entry) => entry.id === "skill:linked-package"), false);
    assert.equal(catalog.listModules().some((entry) => entry.id === "skill:linked-file"), false);
    assert.equal(
      createSkillReadTool(catalog.enabledSkills("normal"), root, undefined, "off"),
      undefined,
    );

    const outerPackageDir = join(skillsDir, "outer-package");
    const nestedStateDir = join(outerPackageDir, "state");
    const nestedSkillDir = join(nestedStateDir, "skills", "nested-private");
    mkdirSync(nestedSkillDir, { recursive: true });
    writeFileSync(join(outerPackageDir, "SKILL.md"), skillMarkdown(
      "outer-package",
      "An outer package that must not gain access to a nested discovered package.",
    ));
    writeFileSync(join(nestedSkillDir, "SKILL.md"), skillMarkdown(
      "nested-private",
      "A package discovered from a nested configured state directory.",
    ));
    const nestedCatalog = new AgentModuleCatalog(database, clock, {
      cwd: root,
      stateDir: nestedStateDir,
    });
    const nestedNames = nestedCatalog.listModules()
      .filter((entry) => entry.type === "skill")
      .map((entry) => entry.name);
    assert.equal(nestedNames.includes("outer-package"), false);
    assert.equal(nestedNames.includes("nested-private"), true);
    assert.throws(
      () => new CompanionKernel({
        stateDir: join(process.cwd(), "skills", "daily-planning", "nested-state"),
        startScheduler: false,
      }),
      /state directory must not be inside an Agent Skill discovery root/,
    );

    catalog.setSkillEnabledSpaces("skill:isolated", ["normal"]);
    const readTool = createSkillReadTool(
      catalog.enabledSkills("normal"),
      root,
      undefined,
      "off",
    );
    assert.ok(readTool);
    const ownResource = await readTool.execute(
      "read-isolated-resource",
      { path: "skills/isolated/reference.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match(JSON.stringify(ownResource), /isolated-resource-sentinel/);
    await assert.rejects(
      readTool.execute(
        "read-neighbor-skill",
        { path: "skills/secret-only/SKILL.md" },
        undefined,
        undefined,
        undefined as never,
      ),
      /restricted to the workspace and enabled Skill directories/,
    );
    for (const path of [
      "skills/isolated/outside-link.txt",
      "skills/linked-package/SKILL.md",
      "skills/linked-file/SKILL.md",
    ]) {
      await assert.rejects(
        readTool.execute(
          `read-symlink-${path}`,
          { path },
          undefined,
          undefined,
          undefined as never,
        ),
        /restricted to the workspace and enabled Skill directories/,
        path,
      );
    }
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("User Profile MCP replaces the Markdown document and exposes it on later turns", async () => {
  const runtime = createTestRuntime({ seed: "user-profile-mcp" });
  try {
    const markdown = "# 用户画像\n\n## 偏好与沟通\n\n- 用户喜欢无糖茶";
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "update_user_profile",
        arguments: { markdown, reason: "用户明确说明稳定饮品偏好" },
      },
      { kind: "assistant_text", text: "记住了。" },
      { kind: "assistant_text", text: "下一轮" },
    ]);
    const response = await runtime.kernel.sendMessage("profile-tool", {
      mode: "rp",
      text: "记住我喜欢无糖茶",
    });
    assert.equal(response.actions[0].actionType, "update_user_profile");
    assert.equal(response.actions[0].payload.transport, "mcp");
    assert.equal(runtime.kernel.getUserProfile().markdown, markdown);

    await runtime.kernel.sendMessage("profile-tool", { mode: "rp", text: "我喜欢喝什么？" });
    assert.match(runtime.model.requests[2].systemPrompt, /用户喜欢无糖茶/);
  } finally {
    runtime.dispose();
  }
});

test("user profile enforces a 2000 Unicode-character limit", () => {
  const runtime = createTestRuntime({ seed: "profile-limit" });
  try {
    assert.equal(runtime.kernel.updateUserProfile("好".repeat(2_000)).characterCount, 2_000);
    assert.throws(
      () => runtime.kernel.updateUserProfile("好".repeat(2_001)),
      /must not exceed 2000 characters/,
    );
  } finally {
    runtime.dispose();
  }
});

test("disabled Schedule MCP also blocks the model-disabled reminder fallback", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  try {
    kernel.setAgentModuleEnabled("mcp:schedule", false);
    const response = await kernel.sendMessage("disabled-schedule", {
      mode: "sms",
      text: "五分钟后提醒我喝水",
    });
    assert.match(response.reply, /日程模块当前已关闭/);
    assert.equal(response.status, "blocked");
    assert.equal(response.eventType, "module_disabled");
    assert.equal(response.canRetry, false);
    const session = await kernel.getSession("disabled-schedule");
    const event = session.messages.at(-1);
    assert.deepEqual(event?.role === "custom" ? event.details : undefined, {
      eventType: "module_disabled",
      status: "blocked",
      canRetry: false,
    });
    assert.equal(kernel.listScheduleItems().length, 0);
  } finally {
    kernel.dispose();
  }
});

test("module settings and user-profile Markdown persist across restarts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-profile-"));
  const clock = new VirtualClock("2026-07-14T08:00:00.000Z");
  const markdown = "# 用户画像\n\n- 称呼：小维\n- 目标：保持规律作息";
  let first: CompanionKernel | undefined;
  let app: ReturnType<typeof createHttpServer> | undefined;
  try {
    first = new CompanionKernel({ stateDir, clock, startScheduler: false });
    app = createHttpServer({ kernel: first });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const modules = (await (await fetch(`${baseUrl}/api/v1/agent-modules`)).json()) as {
      modules: Array<{ id: string; name: string }>;
    };
    const bootstrap = await fetch(`${baseUrl}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const roleplaySkill = modules.modules.find((entry) => entry.name === "roleplay-continuity");
    assert.ok(roleplaySkill);
    const toggled = await fetch(`${baseUrl}/api/v1/agent-modules/${encodeURIComponent(roleplaySkill.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggled.status, 200);
    const profile = await fetch(`${baseUrl}/api/v1/user-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    assert.equal(profile.status, 200);
    const overLimit = await fetch(`${baseUrl}/api/v1/user-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x".repeat(2_001) }),
    });
    assert.equal(overLimit.status, 400);
    await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    app = undefined;
    first.dispose();
    first = undefined;

    const profilePath = join(stateDir, "user-profile.md");
    assert.equal(readFileSync(profilePath, "utf8"), markdown);
    assert.equal(statSync(profilePath).mode & 0o777, 0o600);

    const second = new CompanionKernel({ stateDir, clock, startScheduler: false });
    assert.equal(second.listAgentModules().find((entry) => entry.name === "roleplay-continuity")?.enabled, true);
    assert.equal(second.getUserProfile().markdown, markdown);
    assert.equal(second.getUserProfile().characterCount, [...markdown].length);
    second.deleteAllUserData();
    assert.equal(existsSync(profilePath), false);
    second.dispose();
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function isRole(value: unknown, role: string): boolean {
  return Boolean(value && typeof value === "object" && "role" in value && value.role === role);
}

function isUserPrompt(value: unknown): boolean {
  return isRole(value, "user") && !JSON.stringify(value).includes("[RP_AGENT_");
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}
