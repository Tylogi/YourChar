import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { CharacterAgentSkillPackageService } from "../src/modules/character-skill-packages.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime, ScriptedModelController } from "../src/testing/index.js";

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
      characterSkillManageEnabled: false,
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
    const controlHeaders = await localControlHeaders(baseUrl);

    const invalid = await fetch(`${baseUrl}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: controlHeaders,
      body: JSON.stringify({ networkEnabled: true }),
    });
    assert.equal(invalid.status, 400);

    const updated = await fetch(`${baseUrl}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: controlHeaders,
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
      characterSkillManageEnabled: false,
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

test("private state fails closed against shell access to the loopback HTTP API", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-private-shell-network-"));
  const runtime = createTestRuntime({
    stateDir,
    seed: "private-shell-network",
    workspaceDir: join(stateDir, "workspace"),
  });
  let app: ReturnType<typeof createHttpServer> | undefined;
  let restarted: CompanionKernel | undefined;
  let runtimeDisposed = false;
  try {
    const character = runtime.kernel.createCharacter({
      name: "私密网络边界",
      soulMarkdown: "# SOUL.md - 私密网络边界\n\n守住边界。\n",
    });
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
    });
    app = createHttpServer({ kernel: runtime.kernel });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const controlHeaders = await localControlHeaders(baseUrl);
    const secretUrl = `${baseUrl}/api/v1/sessions?conversationSpace=secret&characterId=${encodeURIComponent(character.id)}`;

    runtime.model.enqueue([
      { kind: "assistant_text", text: "普通回复", delayMs: 500 },
    ]);
    const activeTurn = runtime.kernel.sendMessage("network-active", {
      mode: "sms",
      text: "保持普通会话运行",
    });
    await waitUntil(() => runtime.model.requests.length === 1);
    await assert.rejects(
      runtime.kernel.openCanonicalPrivateConversation(character.id, "secret"),
      /finish active Agent turns before opening or writing private-mode data/,
    );
    const activeControlPlaneRequest = await fetch(secretUrl);
    assert.equal(activeControlPlaneRequest.status, 400);
    assert.equal(
      runtime.kernel.listConversationMetadata().some((entry) => entry.conversationSpace === "secret"),
      false,
    );
    await activeTurn;

    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    assert.equal(secret.conversationSpace, "secret");
    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, false);
    assert.throws(
      () => runtime.kernel.patchAgentPermissions({ networkEnabled: true }),
      /cannot be enabled while private-mode data or private-only Skills exist/,
    );

    const permissionResponse = await fetch(`${baseUrl}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: controlHeaders,
      body: JSON.stringify({ networkEnabled: true }),
    });
    assert.equal(permissionResponse.status, 400);

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command:
            `if /usr/bin/curl -fsS --max-time 2 '${secretUrl}' >/dev/null 2>&1; ` +
            "then printf LOOPBACK_REACHABLE; else printf LOOPBACK_BLOCKED; fi",
        },
      },
      { kind: "assistant_text", text: "本机接口不可达" },
    ]);
    await runtime.kernel.sendMessage("network-isolated", {
      mode: "sms",
      text: "尝试访问本机接口",
    });
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /LOOPBACK_BLOCKED/);
    assert.doesNotMatch(
      JSON.stringify(runtime.model.requests[2].messages),
      /"output":"LOOPBACK_REACHABLE"/,
    );
    const shellAction = [...runtime.kernel.store.actions].reverse().find((action) =>
      action.actionType === "workspace_shell"
    );
    assert.ok(shellAction);
    assert.match(JSON.stringify(shellAction.payload), /"networkEnabled":false/);

    await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    app = undefined;
    runtime.kernel.database.connection.prepare(`
      UPDATE agent_module_settings
      SET enabled = 1
      WHERE module_id = 'permission:workspace-network'
    `).run();
    runtime.dispose();
    runtimeDisposed = true;
    restarted = new CompanionKernel({ stateDir, startScheduler: false });
    assert.equal(restarted.getAgentPermissions().shellEnabled, true);
    assert.equal(restarted.getAgentPermissions().networkEnabled, false);
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    restarted?.dispose();
    if (!runtimeDisposed) runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("active incognito mode dynamically removes loopback shell network without persisting a permission change", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-shell-network-"));
  const runtime = createTestRuntime({
    stateDir,
    seed: "incognito-shell-network",
    workspaceDir: join(stateDir, "workspace"),
  });
  let app: ReturnType<typeof createHttpServer> | undefined;
  try {
    const character = runtime.kernel.createCharacter({ name: "无痕网络边界" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
    });
    app = createHttpServer({ kernel: runtime.kernel });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const incognitoListUrl = `${baseUrl}/api/v1/incognito-conversations`;

    runtime.model.enqueue([{ kind: "assistant_text", text: "普通会话仍在运行", delayMs: 300 }]);
    const activeTurn = runtime.kernel.sendMessage(normal.id, { text: "保持联网会话运行" });
    await waitUntil(() => runtime.model.requests.length === 1);
    await assert.rejects(
      runtime.kernel.openIncognitoConversation(character.id),
      /finish active Agent turns before opening incognito mode with shell network enabled/,
    );
    await activeTurn;

    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, true);
    assert.throws(
      () => runtime.kernel.patchAgentPermissions({ networkEnabled: true }),
      /incognito mode is active/,
    );
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command:
            `if /usr/bin/curl -fsS --max-time 2 '${incognitoListUrl}' >/dev/null 2>&1; ` +
            "then printf INCOGNITO_LOOPBACK_REACHABLE; else printf INCOGNITO_LOOPBACK_BLOCKED; fi",
        },
      },
      { kind: "assistant_text", text: "无痕期间本机接口不可达" },
    ]);
    await runtime.kernel.sendMessage(normal.id, { text: "无痕期间尝试访问本机接口" });
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /INCOGNITO_LOOPBACK_BLOCKED/);
    const isolatedShellAction = [...runtime.kernel.store.actions].reverse().find((action) =>
      action.actionType === "workspace_shell"
    );
    assert.ok(isolatedShellAction);
    assert.equal(isolatedShellAction.payload.networkEnabled, false);

    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command:
            `if /usr/bin/curl -fsS --max-time 2 '${incognitoListUrl}' >/dev/null 2>&1; ` +
            "then printf NORMAL_LOOPBACK_REACHABLE; else printf NORMAL_LOOPBACK_BLOCKED; fi",
        },
      },
      { kind: "assistant_text", text: "退出无痕后恢复原网络偏好" },
    ]);
    await runtime.kernel.sendMessage(normal.id, { text: "退出无痕后再次访问" });
    assert.match(JSON.stringify(runtime.model.requests[4].messages), /NORMAL_LOOPBACK_REACHABLE/);
    const restoredShellAction = [...runtime.kernel.store.actions].reverse().find((action) =>
      action.actionType === "workspace_shell"
    );
    assert.ok(restoredShellAction);
    assert.equal(restoredShellAction.payload.networkEnabled, true);
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("character autonomy and loaded private Skills latch real shell network until a later safe turn", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-character-skill-shell-network-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const model = new ScriptedModelController("character-skill-shell-network");
  const packageService = new CharacterAgentSkillPackageService({
    database,
    stateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      response: new Response(Uint8Array.from(zipSync({
        "bundle/SKILL.md": strToU8([
          "---",
          "name: network-bound-private-skill",
          "description: Network-bound private Skill",
          "---",
          "",
          "# Network-bound private Skill",
          "",
          "Treat every local control endpoint as privileged.",
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
  let app: ReturnType<typeof createHttpServer> | undefined;
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: "http://test.invalid/v1",
      model: "scripted-model",
      temperature: 0,
    });
    const character = kernel.createCharacter({ name: "Skill 网络边界" });
    kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
      characterSkillManageEnabled: true,
    });
    const installed = await packageService.install({
      characterId: character.id,
      conversationSpace: "normal",
      sourceUrl: "https://downloads.example.com/network-bound-private-skill.zip",
    });
    const normal = await kernel.openCanonicalPrivateConversation(character.id);
    kernel.patchAgentPermissions({ characterSkillManageEnabled: false });

    app = createHttpServer({ kernel });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const replayCommand = (reachable: string, blocked: string) =>
      `if /usr/bin/curl -fsS -c /tmp/control.cookies '${baseUrl}/' >/dev/null 2>&1 && ` +
      `/usr/bin/curl -fsS -b /tmp/control.cookies -H 'content-type: application/json' ` +
      `-H 'origin: ${baseUrl}' -H 'sec-fetch-mode: cors' -H 'sec-fetch-site: same-origin' ` +
      `'${baseUrl}/api/v1/agent-permissions' >/dev/null 2>&1; ` +
      `then printf '${reachable}'; else printf '${blocked}'; fi`;
    const runShellTurn = async (label: string, networkExpected: boolean) => {
      const requestStart = model.requests.length;
      const actionStart = kernel.store.actions.length;
      const reachable = `${label}_CONTROL_REPLAY_REACHABLE`;
      const blocked = `${label}_CONTROL_REPLAY_BLOCKED`;
      model.enqueue([
        { kind: "tool_call", name: "bash", arguments: { command: replayCommand(reachable, blocked) } },
        { kind: "assistant_text", text: `${label} done` },
      ]);
      await kernel.sendMessage(normal.id, { text: label });
      const requestMessages = JSON.stringify(model.requests.slice(requestStart));
      assert.match(
        requestMessages,
        new RegExp(`${networkExpected ? reachable : blocked}\\\\nCommand exited with code 0`),
      );
      if (!networkExpected) {
        assert.doesNotMatch(requestMessages, new RegExp(`${reachable}\\\\nCommand exited with code 0`));
      }
      const shellActions = kernel.store.actions.slice(actionStart)
        .filter((action) => action.actionType === "workspace_shell");
      assert.equal(shellActions.length, 1);
      assert.equal(shellActions[0].payload.networkEnabled, networkExpected);
    };

    // Turning autonomy off does not trust a private package already loaded
    // into this character's next handle.
    await runShellTurn("PRIVATE_PACKAGE", false);

    // A Skill can disable itself through its bounded MCP, but the network bit
    // is frozen for the whole generation and therefore remains false.
    kernel.patchAgentPermissions({ characterSkillManageEnabled: true });
    const mutationRequestStart = model.requests.length;
    const mutationActionStart = kernel.store.actions.length;
    model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: { command: replayCommand("BEFORE_DISABLE_REACHABLE", "BEFORE_DISABLE_BLOCKED") },
      },
      {
        kind: "tool_call",
        name: "set_current_character_private_skill_enabled",
        arguments: { name: installed.package.name, enabled: false },
      },
      {
        kind: "tool_call",
        name: "bash",
        arguments: { command: replayCommand("AFTER_DISABLE_REACHABLE", "AFTER_DISABLE_BLOCKED") },
      },
      { kind: "assistant_text", text: "同回合网络保持隔离" },
    ]);
    await kernel.sendMessage(normal.id, { text: "disable the private package and retry" });
    const mutationMessages = JSON.stringify(model.requests.slice(mutationRequestStart));
    assert.match(mutationMessages, /BEFORE_DISABLE_BLOCKED\\nCommand exited with code 0/);
    assert.match(mutationMessages, /AFTER_DISABLE_BLOCKED\\nCommand exited with code 0/);
    assert.doesNotMatch(mutationMessages, /(?:BEFORE|AFTER)_DISABLE_REACHABLE\\nCommand exited with code 0/);
    assert.equal(packageService.list({
      characterId: character.id,
      conversationSpace: "normal",
    })[0].enabled, false);
    const mutationShellActions = kernel.store.actions.slice(mutationActionStart)
      .filter((action) => action.actionType === "workspace_shell");
    assert.equal(mutationShellActions.length, 2);
    assert.equal(mutationShellActions.every((action) => action.payload.networkEnabled === false), true);

    kernel.patchAgentPermissions({ characterSkillManageEnabled: false });
    await runShellTurn("DISABLED_PACKAGE_NEXT_SAFE_TURN", true);

    kernel.patchAgentPermissions({ characterSkillManageEnabled: true });
    await runShellTurn("MANAGEMENT_PERMISSION", false);
    kernel.patchAgentPermissions({ characterSkillManageEnabled: false });
    await runShellTurn("MANAGEMENT_PERMISSION_OFF_NEXT_TURN", true);

    const owned = kernel.createCharacterOwnedSkill(character.id, {
      name: "Autonomous loopback boundary",
      description: "Character-created workflow",
      markdown: "# Autonomous workflow\n\nNever trust a local control endpoint from a Skill.\n",
      activate: true,
      createdBy: "character",
    });
    await runShellTurn("AUTONOMOUS_OWNED_WORKFLOW", false);
    kernel.updateCharacterOwnedSkill(character.id, owned.id, { status: "disabled" });
    await runShellTurn("OWNED_WORKFLOW_DISABLED_NEXT_TURN", true);

    assert.equal(kernel.getAgentPermissions().networkEnabled, true, "the user preference is never overwritten");
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    kernel.dispose();
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control-plane capability changes are blocked before provider streaming starts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-capability-turn-race-"));
  const model = new ScriptedModelController("capability-turn-race");
  let releaseResolver!: () => void;
  const resolverReleased = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  let announceResolver!: () => void;
  const resolverStarted = new Promise<void>((resolve) => {
    announceResolver = resolve;
  });
  const kernel = new CompanionKernel({
    stateDir,
    modelResolver: async (context) => {
      announceResolver();
      await resolverReleased;
      return model.resolver(context);
    },
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
    model.enqueue([{ kind: "assistant_text", text: "race closed" }]);
    const turn = kernel.sendMessage("capability-race", { mode: "sms", text: "start" });
    await resolverStarted;
    assert.throws(
      () => kernel.patchAgentPermissions({ characterSkillManageEnabled: true }),
      /control-plane operations are unavailable while an Agent turn is active/,
    );
    releaseResolver();
    await turn;
    assert.equal(kernel.patchAgentPermissions({ characterSkillManageEnabled: true }).characterSkillManageEnabled, true);
  } finally {
    releaseResolver();
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Workspace configuration cannot overlap protected state or Agent Skill roots", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-workspace-config-boundary-"));
  try {
    const stateDir = join(root, "state");
    assert.throws(
      () => new CompanionKernel({
        stateDir,
        workspaceDir: stateDir,
        startScheduler: false,
      }),
      /must not overlap the protected YourChar state directory/,
    );
    assert.throws(
      () => new CompanionKernel({
        stateDir,
        workspaceDir: process.cwd(),
        startScheduler: false,
      }),
      /must not overlap Agent Skill discovery roots/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational backup and restore include normal/secret Workspaces and service state", () => {
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
    kernel.patchMineruConfig({
      baseUrl: "https://mineru.example.test",
      apiKey: "mineru-backup-secret",
      backend: "pipeline",
    });
    writeFileSync(join(stateDir, "workspace", "project.txt"), "workspace-data", "utf8");
    const secretWorkspace = kernel.workspaceRegistry.resolve({
      conversationSpace: "secret",
      characterId: character.id,
    });
    const secretEntry = secretWorkspace.files.upload({
      directory: "projects",
      name: "private.txt",
      bytes: Buffer.from("secret-workspace-data", "utf8"),
    });
    const secretRelativePath = relative(
      stateDir,
      join(secretWorkspace.dir, secretEntry.path),
    );
    assert.equal(secretRelativePath.startsWith(".."), false);
    const installedSkillDir = join(stateDir, "skills", "backup-skill");
    mkdirSync(installedSkillDir, { recursive: true });
    writeFileSync(
      join(installedSkillDir, "SKILL.md"),
      "---\nname: backup-skill\ndescription: Backed up installed Skill\n---\n\n# Backup Skill\n",
      "utf8",
    );
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
    assert.equal(
      readFileSync(join(restoredDir, secretRelativePath), "utf8"),
      "secret-workspace-data",
    );
    assert.match(
      readFileSync(join(restoredDir, "skills", "backup-skill", "SKILL.md"), "utf8"),
      /# Backup Skill/,
    );
    assert.equal(readFileSync(join(restoredDir, "avatars", "user.png")).byteLength > 0, true);
    assert.equal(readFileSync(join(restoredDir, "avatars", `character-${character.id}.png`)).byteLength > 0, true);
    assert.match(readFileSync(join(restoredDir, "tavily.json"), "utf8"), /tvly-backup-secret/);
    assert.match(readFileSync(join(restoredDir, "vision.json"), "utf8"), /vision-backup-secret/);
    assert.match(readFileSync(join(restoredDir, "mineru.json"), "utf8"), /mineru-backup-secret/);
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(
      manifest.containsTavilyCredentials,
      true,
    );
    assert.equal(manifest.containsVisionCredentials, true);
    assert.equal(manifest.containsMineruCredentials, true);
    assert.equal(manifest.containsSecretWorkspace, true);
    assert.equal(manifest.containsInstalledSkills, true);
    assert.equal(manifest.credentials.visionConfigPresent, true);
    assert.equal(manifest.credentials.mineruConfigPresent, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function localControlHeaders(baseUrl: string): Promise<Record<string, string>> {
  const bootstrap = await fetch(`${baseUrl}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  await bootstrap.body?.cancel();
  assert.ok(cookie, "the UI bootstrap must issue the local-control cookie");
  return {
    "content-type": "application/json",
    cookie,
    origin: baseUrl,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

function hasRole(value: unknown, role: string): boolean {
  return Boolean(value && typeof value === "object" && "role" in value && value.role === role);
}

function isUserPrompt(value: unknown): boolean {
  return hasRole(value, "user") && !JSON.stringify(value).includes("[RP_AGENT_");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
