import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("permission defaults are conservative and profile write can be disabled independently", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "rp-agent-workspace-default-"));
  const runtime = createTestRuntime({ seed: "permission-defaults", workspaceDir });
  try {
    assert.deepEqual(runtime.kernel.getAgentPermissions(), {
      workspaceAccess: "off",
      shellEnabled: false,
      networkEnabled: false,
      userProfileWriteEnabled: true,
      characterSoulWriteEnabled: false,
      realityMemoryWriteEnabled: false,
      characterMemoryWriteEnabled: false,
      workspaceDir,
      shellAvailable: true,
    });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一轮" },
      { kind: "assistant_text", text: "第二轮" },
    ]);
    await runtime.kernel.sendMessage("permission-defaults", { mode: "sms", text: "你好" });
    const defaults = runtime.model.requests[0].toolNames;
    assert.equal(defaults.includes("read"), false);
    assert.equal(defaults.includes("list_workspace"), false);
    assert.equal(defaults.includes("write"), false);
    assert.equal(defaults.includes("edit"), false);
    assert.equal(defaults.includes("bash"), false);
    assert.equal(defaults.includes("update_user_profile"), true);

    runtime.kernel.patchAgentPermissions({ userProfileWriteEnabled: false });
    await runtime.kernel.sendMessage("permission-defaults", { mode: "sms", text: "继续" });
    const restricted = runtime.model.requests[1].toolNames;
    assert.equal(restricted.includes("get_user_profile"), true);
    assert.equal(restricted.includes("update_user_profile"), false);
    assert.equal(runtime.model.requests[1].messages.filter(isUserPrompt).length, 2);
  } finally {
    runtime.dispose();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace tools enforce read-only and read-write boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-workspace-tools-"));
  const workspaceDir = join(root, "workspace");
  const secretPath = join(root, "secret.txt");
  const runtime = createTestRuntime({ seed: "workspace-tools", workspaceDir });
  try {
    writeFileSync(join(workspaceDir, "notes.txt"), "alpha\nbeta\n", "utf8");
    writeFileSync(secretPath, "host secret", "utf8");
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "read", arguments: { path: "notes.txt" } },
      { kind: "assistant_text", text: "读取完成" },
      { kind: "tool_call", name: "read", arguments: { path: "../secret.txt" } },
      { kind: "assistant_text", text: "越界被拒绝" },
    ]);
    await runtime.kernel.sendMessage("workspace-read", { mode: "sms", text: "读取文件" });
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /alpha/);
    assert.equal(runtime.model.requests[0].toolNames.includes("list_workspace"), true);
    assert.equal(runtime.model.requests[0].toolNames.includes("write"), false);
    await runtime.kernel.sendMessage("workspace-escape", { mode: "sms", text: "读取外部文件" });
    assert.match(JSON.stringify(runtime.model.requests[3].messages), /restricted to the workspace/);

    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "write", arguments: { path: "drafts/today.md", content: "water: pending\n" } },
      { kind: "tool_call", name: "edit", arguments: { path: "drafts/today.md", oldText: "pending", newText: "done" } },
      { kind: "assistant_text", text: "写入完成" },
    ]);
    await runtime.kernel.sendMessage("workspace-write", { mode: "sms", text: "更新工作区" });
    assert.equal(readFileSync(join(workspaceDir, "drafts/today.md"), "utf8"), "water: done\n");
    assert.equal(readFileSync(secretPath, "utf8"), "host secret");
    assert.deepEqual(
      runtime.kernel.store.actions
        .filter((action) => action.actionType.startsWith("workspace_"))
        .map((action) => action.actionType),
      ["workspace_write", "workspace_edit"],
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandboxed shell sees only the configured workspace and honors read-only mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-shell-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({ seed: "sandbox-shell", workspaceDir });
  try {
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: false,
    });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command: "printf shell-ok > result.txt; test ! -e /home; test ! -e /etc/resolv.conf; printf isolated",
        },
      },
      { kind: "assistant_text", text: "终端完成" },
    ]);
    await runtime.kernel.sendMessage("shell-write", { mode: "sms", text: "执行测试" });
    assert.equal(readFileSync(join(workspaceDir, "result.txt"), "utf8"), "shell-ok");
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /isolated/);

    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command: "if touch blocked.txt 2>/dev/null; then printf writable; else printf readonly; fi",
        },
      },
      { kind: "assistant_text", text: "只读验证完成" },
    ]);
    await runtime.kernel.sendMessage("shell-readonly", { mode: "sms", text: "验证只读" });
    assert.match(JSON.stringify(runtime.model.requests[3].messages), /readonly/);
    assert.equal(existsSync(join(workspaceDir, "blocked.txt")), false);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("character SOUL write permission exposes a character-bound MCP in SMS and RP", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "rp-agent-soul-permission-"));
  const runtime = createTestRuntime({ seed: "soul-permission", workspaceDir });
  try {
    const character = runtime.kernel.createCharacter({
      name: "岚",
      soulMarkdown: "# SOUL.md - 岚\n\n## 核心身份\n\n冷静的旅伴。\n",
    });
    runtime.kernel.patchAgentPermissions({ characterSoulWriteEnabled: true });
    const unboundBlocked = await runtime.kernel.sendMessage("soul-unbound", {
      mode: "sms",
      text: "帮我搜索红莉栖的人设，然后更新你的人设",
    });
    assert.match(unboundBlocked.reply, /没有绑定角色/);
    assert.equal(runtime.model.requests.length, 0);

    const updatedSoul = "# SOUL.md - 岚\n\n## 核心身份\n\n冷静、坦率的旅伴。\n";
    runtime.model.enqueue([
      { kind: "tool_call", name: "get_current_character_soul", arguments: {} },
      {
        kind: "tool_call",
        name: "update_current_character_soul",
        arguments: { markdown: updatedSoul, reason: "用户明确要求增加坦率特质" },
      },
      { kind: "assistant_text", text: "角色设定已更新。" },
      { kind: "assistant_text", text: "剧情继续。" },
      { kind: "assistant_text", text: "私聊继续。" },
    ]);
    await runtime.kernel.sendMessage("soul-sms", {
      mode: "sms",
      characterId: character.id,
      text: "把你的设定改得更坦率",
    });
    assert.equal(runtime.kernel.getCharacter(character.id).soulMarkdown, updatedSoul);
    assert.equal(runtime.model.requests[0].toolNames.includes("update_current_character_soul"), true);
    assert.match(runtime.model.requests[0].systemPrompt, /reading and writing are available/);
    assert.match(runtime.model.requests[0].systemPrompt, /第一人称即时消息口吻/);

    await runtime.kernel.sendMessage("soul-rp", {
      mode: "rp",
      characterId: character.id,
      text: "继续剧情",
    });
    assert.equal(runtime.model.requests[3].toolNames.includes("update_current_character_soul"), true);
    assert.match(runtime.model.requests[3].systemPrompt, /第三人称剧情演绎/);

    runtime.kernel.patchAgentPermissions({ characterSoulWriteEnabled: false });
    await runtime.kernel.sendMessage("soul-sms", {
      mode: "sms",
      characterId: character.id,
      text: "继续",
    });
    assert.equal(runtime.model.requests[4].toolNames.includes("get_current_character_soul"), false);
    assert.equal(runtime.model.requests[4].toolNames.includes("update_current_character_soul"), false);
    assert.match(runtime.model.requests[4].systemPrompt, /Character SOUL\.md writing is disabled/);
  } finally {
    runtime.dispose();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("agent permission API persists settings and prevents network without shell", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-permission-api-"));
  const clock = new VirtualClock("2026-07-14T08:00:00.000Z");
  let kernel: CompanionKernel | undefined;
  let app: ReturnType<typeof createHttpServer> | undefined;
  try {
    kernel = new CompanionKernel({ stateDir, clock, startScheduler: false });
    app = createHttpServer({ kernel });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const invalid = await fetch(`${baseUrl}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ networkEnabled: true }),
    });
    assert.equal(invalid.status, 400);

    const updated = await fetch(`${baseUrl}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceAccess: "read_write",
        shellEnabled: true,
        networkEnabled: true,
        userProfileWriteEnabled: false,
        characterSoulWriteEnabled: true,
      }),
    });
    assert.equal(updated.status, 200);
    await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    app = undefined;
    kernel.dispose();
    kernel = undefined;

    const restarted = new CompanionKernel({ stateDir, clock, startScheduler: false });
    assert.deepEqual(restarted.getAgentPermissions(), {
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
      userProfileWriteEnabled: false,
      characterSoulWriteEnabled: true,
      realityMemoryWriteEnabled: false,
      characterMemoryWriteEnabled: false,
      workspaceDir: join(stateDir, "workspace"),
      shellAvailable: true,
    });
    const disabled = restarted.patchAgentPermissions({ shellEnabled: false });
    assert.equal(disabled.networkEnabled, false);
    restarted.dispose();
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    kernel?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("operational backup and restore include profile, avatars, character SOUL, workspace, and service credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-capability-backup-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  try {
    const kernel = new CompanionKernel({ stateDir, startScheduler: false });
    kernel.updateUserProfile("# 用户画像\n\n- 称呼：备份测试");
    const character = kernel.createCharacter({
      name: "备份角色",
      soulMarkdown: "# SOUL.md - 备份角色\n\n保持完整。\n",
    });
    const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    kernel.updateUserAvatar(avatar);
    kernel.updateCharacterAvatar(character.id, avatar);
    kernel.patchTavilyConfig({ apiKey: "tvly-backup-secret" });
    kernel.patchVisionConfig({
      mode: "mcp",
      baseUrl: "https://vision.example.test/v1",
      model: "vision-backup",
      apiKey: "vision-backup-secret",
    });
    writeFileSync(join(stateDir, "workspace", "project.txt"), "workspace-data", "utf8");
    kernel.dispose();

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    assert.equal(readFileSync(join(restoredDir, "user-profile.md"), "utf8"), "# 用户画像\n\n- 称呼：备份测试");
    assert.equal(
      readFileSync(join(restoredDir, "characters", character.id, "SOUL.md"), "utf8"),
      "# SOUL.md - 备份角色\n\n保持完整。\n",
    );
    assert.equal(readFileSync(join(restoredDir, "workspace", "project.txt"), "utf8"), "workspace-data");
    assert.equal(readFileSync(join(restoredDir, "avatars", "user.png")).byteLength > 0, true);
    assert.equal(readFileSync(join(restoredDir, "avatars", `character-${character.id}.png`)).byteLength > 0, true);
    assert.match(readFileSync(join(restoredDir, "tavily.json"), "utf8"), /tvly-backup-secret/);
    assert.match(readFileSync(join(restoredDir, "vision.json"), "utf8"), /vision-backup-secret/);
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(
      manifest.containsTavilyCredentials,
      true,
    );
    assert.equal(manifest.containsVisionCredentials, true);
    assert.equal(manifest.credentials.visionConfigPresent, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function hasRole(value: unknown, role: string): boolean {
  return Boolean(value && typeof value === "object" && "role" in value && value.role === role);
}

function isUserPrompt(value: unknown): boolean {
  return hasRole(value, "user") && !JSON.stringify(value).includes("[RP_AGENT_");
}
