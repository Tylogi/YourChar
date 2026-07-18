import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("module toggles rebuild Pi capabilities and profile context without losing conversation", async () => {
  const runtime = createTestRuntime({ seed: "module-toggle" });
  try {
    const modules = runtime.kernel.listAgentModules();
    assert.deepEqual(modules.map((entry) => [entry.type, entry.name, entry.enabled]), [
      ["mcp", "Memory Coordinator MCP", true],
      ["mcp", "Relationship State MCP", false],
      ["mcp", "Schedule MCP", true],
      ["mcp", "Subagent Delegation MCP", false],
      ["mcp", "Tavily Search MCP", false],
      ["mcp", "User Profile MCP", true],
      ["mcp", "Vision MCP", false],
      ["mcp", "Web Reader MCP", false],
      ["skill", "daily-planning", false],
      ["skill", "roleplay-continuity", false],
    ]);
    assert.deepEqual(
      modules.filter((entry) => entry.type === "mcp").map((entry) => [entry.name, entry.estimatedTokens]),
      [["Memory Coordinator MCP", 430], ["Relationship State MCP", 230], ["Schedule MCP", 960], ["Subagent Delegation MCP", 390], ["Tavily Search MCP", 350], ["User Profile MCP", 270], ["Vision MCP", 420], ["Web Reader MCP", 260]],
    );
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
    const roleplaySkill = modules.modules.find((entry) => entry.name === "roleplay-continuity");
    assert.ok(roleplaySkill);
    const toggled = await fetch(`${baseUrl}/api/v1/agent-modules/${encodeURIComponent(roleplaySkill.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
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
