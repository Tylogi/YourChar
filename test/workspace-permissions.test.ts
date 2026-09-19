import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { VirtualClock } from "../src/app/clock.js";
import { shellSandboxAvailability } from "../src/execution/shell-sandbox.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { CharacterAgentSkillPackageService } from "../src/modules/character-skill-packages.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime, ScriptedModelController } from "../src/testing/index.js";

test("Workspace defaults to read-write while shell and privileged character mutations remain opt-in", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "rp-agent-workspace-default-"));
  const runtime = createTestRuntime({ seed: "permission-defaults", workspaceDir });
  try {
    assert.deepEqual(runtime.kernel.getAgentPermissions(), {
      workspaceAccess: "read_write",
      shellEnabled: false,
      networkEnabled: false,
      userProfileWriteEnabled: true,
      characterSoulWriteEnabled: false,
      characterSkillManageEnabled: false,
      realityMemoryWriteEnabled: false,
      characterMemoryWriteEnabled: false,
      workspaceDir,
      shellAvailable: true,
      shellBackend: shellSandboxAvailability().backend,
      shellNetworkIsolationAvailable: shellSandboxAvailability().networkIsolation,
    });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "第一轮" },
      { kind: "assistant_text", text: "第二轮" },
    ]);
    await runtime.kernel.sendMessage("permission-defaults", { mode: "sms", text: "你好" });
    const defaults = runtime.model.requests[0].toolNames;
    assert.equal(defaults.includes("read"), true);
    assert.equal(defaults.includes("list_workspace"), true);
    assert.equal(defaults.includes("write"), true);
    assert.equal(defaults.includes("edit"), true);
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

test("default Workspace tools can read and write in a small model window without enabling Shell", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "yourchar-default-workspace-use-"));
  const runtime = createTestRuntime({ seed: "default-workspace-use", workspaceDir });
  try {
    runtime.kernel.patchModelApiConfig({ contextWindowTokens: 32_768, maxTokens: 2_048 });
    runtime.model.enqueue([
      { kind: "tool_call", name: "write", arguments: { path: "plan.md", content: "# Weekend\n" } },
      { kind: "tool_call", name: "read", arguments: { path: "plan.md" } },
      { kind: "assistant_text", text: "计划已保存。" },
    ]);
    const response = await runtime.kernel.sendMessage("default-workspace-use", { mode: "sms", text: "保存并读回周末计划" });
    assert.equal(response.status, "completed");
    assert.equal(readFileSync(join(workspaceDir, "plan.md"), "utf8"), "# Weekend\n");
    assert.match(JSON.stringify(runtime.model.requests.at(-1)?.messages), /# Weekend/);
    assert.equal(runtime.kernel.getAgentPermissions().shellEnabled, false);
  } finally { runtime.dispose(); rmSync(workspaceDir, { recursive: true, force: true }); }
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
      shellBackend: shellSandboxAvailability().backend,
      shellNetworkIsolationAvailable: shellSandboxAvailability().networkIsolation,
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

test("private state preserves the user's enabled shell-network permission", async () => {
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
    const healthUrl = `${baseUrl}/api/v1/health`;

    runtime.model.enqueue([
      { kind: "assistant_text", text: "普通回复", delayMs: 500 },
    ]);
    const activeTurn = runtime.kernel.sendMessage("network-active", {
      mode: "sms",
      text: "保持普通会话运行",
    });
    await waitUntil(() => runtime.model.requests.length === 1);
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    await activeTurn;

    assert.equal(secret.conversationSpace, "secret");
    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, true);

    const runNetworkTurn = async (
      sessionId: string,
      conversationSpace: "normal" | "secret",
      label: string,
    ) => {
      const requestStart = runtime.model.requests.length;
      const actionStart = runtime.kernel.store.actions.length;
      runtime.model.enqueue([
        {
          kind: "tool_call",
          name: "bash",
          arguments: {
            command:
              `if /usr/bin/curl -fsS --max-time 2 '${healthUrl}' >/dev/null 2>&1; ` +
              `then printf '${label}_REACHABLE'; else printf '${label}_BLOCKED'; fi`,
          },
        },
        { kind: "assistant_text", text: `${label} done` },
      ]);
      await runtime.kernel.sendMessage(sessionId, {
        mode: "sms",
        characterId: character.id,
        conversationSpace,
        text: `${label} network check`,
      });
      assert.match(
        JSON.stringify(runtime.model.requests.slice(requestStart)),
        new RegExp(`${label}_REACHABLE\\\\nCommand exited with code 0`),
      );
      const shellActions = runtime.kernel.store.actions.slice(actionStart)
        .filter((action) => action.actionType === "workspace_shell");
      assert.equal(shellActions.length, 1);
      assert.equal(shellActions[0].payload.networkEnabled, true);
    };

    await runNetworkTurn("network-normal", "normal", "NORMAL");
    await runNetworkTurn(secret.id, "secret", "SECRET");

    await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    app = undefined;
    runtime.dispose();
    runtimeDisposed = true;
    restarted = new CompanionKernel({ stateDir, startScheduler: false });
    assert.equal(restarted.getAgentPermissions().shellEnabled, true);
    assert.equal(restarted.getAgentPermissions().networkEnabled, true);
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    restarted?.dispose();
    if (!runtimeDisposed) runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("active incognito mode does not override enabled network for ordinary Agent shells", async () => {
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
    const healthUrl = `${baseUrl}/api/v1/health`;

    runtime.model.enqueue([{ kind: "assistant_text", text: "普通会话仍在运行", delayMs: 300 }]);
    const activeTurn = runtime.kernel.sendMessage(normal.id, { text: "保持联网会话运行" });
    await waitUntil(() => runtime.model.requests.length === 1);
    const incognito = await runtime.kernel.openIncognitoConversation(character.id);
    await activeTurn;

    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "bash",
        arguments: {
          command:
            `if /usr/bin/curl -fsS --max-time 2 '${healthUrl}' >/dev/null 2>&1; ` +
            "then printf INCOGNITO_OPEN_NETWORK_REACHABLE; else printf INCOGNITO_OPEN_NETWORK_BLOCKED; fi",
        },
      },
      { kind: "assistant_text", text: "无痕期间普通会话仍按用户授权联网" },
    ]);
    await runtime.kernel.sendMessage(normal.id, { text: "无痕期间检查网络" });
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /INCOGNITO_OPEN_NETWORK_REACHABLE/);
    const enabledShellAction = [...runtime.kernel.store.actions].reverse().find((action) =>
      action.actionType === "workspace_shell"
    );
    assert.ok(enabledShellAction);
    assert.equal(enabledShellAction.payload.networkEnabled, true);

    await runtime.kernel.closeIncognitoConversation(incognito.id);
    assert.equal(runtime.kernel.getAgentPermissions().networkEnabled, true);
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("character autonomy and loaded private Skills honor the user's network permission", async () => {
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

    await runShellTurn("PRIVATE_PACKAGE", true);

    // Skill mutations do not silently override the user's explicit network choice.
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
      { kind: "assistant_text", text: "同回合网络保持开启" },
    ]);
    await kernel.sendMessage(normal.id, { text: "disable the private package and retry" });
    const mutationMessages = JSON.stringify(model.requests.slice(mutationRequestStart));
    assert.match(mutationMessages, /BEFORE_DISABLE_REACHABLE\\nCommand exited with code 0/);
    assert.match(mutationMessages, /AFTER_DISABLE_REACHABLE\\nCommand exited with code 0/);
    assert.equal(packageService.list({
      characterId: character.id,
      conversationSpace: "normal",
    })[0].enabled, false);
    const mutationShellActions = kernel.store.actions.slice(mutationActionStart)
      .filter((action) => action.actionType === "workspace_shell");
    assert.equal(mutationShellActions.length, 2);
    assert.equal(mutationShellActions.every((action) => action.payload.networkEnabled === true), true);

    kernel.patchAgentPermissions({ characterSkillManageEnabled: false });
    await runShellTurn("DISABLED_PACKAGE_NEXT_SAFE_TURN", true);

    kernel.patchAgentPermissions({ characterSkillManageEnabled: true });
    await runShellTurn("MANAGEMENT_PERMISSION", true);
    kernel.patchAgentPermissions({ characterSkillManageEnabled: false });
    await runShellTurn("MANAGEMENT_PERMISSION_OFF_NEXT_TURN", true);

    const owned = kernel.createCharacterOwnedSkill(character.id, {
      name: "Autonomous loopback boundary",
      description: "Character-created workflow",
      markdown: "# Autonomous workflow\n\nNever trust a local control endpoint from a Skill.\n",
      activate: true,
      createdBy: "character",
    });
    await runShellTurn("AUTONOMOUS_OWNED_WORKFLOW", true);
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
