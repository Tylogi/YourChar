import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { AgentSkillInstallerService } from "../src/modules/skill-installer.js";

const sourceUrl = "https://downloads.example.com/private-helper.zip";
const privateSentinel = "PRIVATE_INSTALLED_SKILL_SENTINEL";
const skillMarkdown = [
  "---",
  "name: private-helper",
  "description: A private-only installed Agent Skill.",
  "---",
  "",
  "# Private Helper",
  "",
  privateSentinel,
  "",
].join("\n");

test("protected installer API publishes a secret-only Skill without overriding shell network", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-http-"));
  const archive = zipSync({
    "private-helper/SKILL.md": strToU8(skillMarkdown),
    "private-helper/references/guide.txt": strToU8("private reference\n"),
  });
  let transportCalls = 0;
  const installer = new AgentSkillInstallerService({
    stateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      transportCalls += 1;
      return {
        response: new Response(toArrayBuffer(archive), {
          headers: { "content-type": "application/zip" },
        }),
      };
    },
  });
  let kernel: CompanionKernel | undefined;
  let server: Server | undefined;
  try {
    kernel = new CompanionKernel({
      stateDir,
      skillInstaller: installer,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    const character = kernel.createCharacter({ name: "安装器私密边界" });
    kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: true,
    });
    kernel.database.connection.prepare(`
      INSERT INTO agent_skill_space_settings(
        module_id, normal_enabled, secret_enabled, updated_at
      ) VALUES (?, 1, 0, ?)
    `).run("skill:private-helper", new Date().toISOString());
    server = createHttpServer({ kernel });
    await listen(server);
    const origin = originOf(server);

    const rejected = await fetch(`${origin}/api/v1/agent-skills/install/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ sourceUrl }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(transportCalls, 0, "untrusted requests are rejected before any network access");

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const hostileOrigin = await fetch(`${origin}/api/v1/agent-skills/install/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ sourceUrl }),
    });
    assert.equal(hostileOrigin.status, 403);
    const unsafeContentType = await fetch(`${origin}/api/v1/agent-skills/install/preview`, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie, origin },
      body: JSON.stringify({ sourceUrl }),
    });
    assert.equal(unsafeContentType.status, 415);
    assert.equal(transportCalls, 0, "control-plane checks run before parsing or downloading");
    const headers = {
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    const preview = await fetch(`${origin}/api/v1/agent-skills/install/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceUrl }),
    });
    assert.equal(preview.status, 201);
    const previewBody = await preview.json() as {
      stage: {
        id: string;
        sourceUrl: string;
        sourceHost: string;
        skillName: string;
        sha256: string;
        files: Array<{ path: string }>;
        skillMarkdown: string;
      };
    };
    assert.equal(previewBody.stage.sourceUrl, sourceUrl);
    assert.equal(previewBody.stage.sourceHost, "downloads.example.com");
    assert.equal(previewBody.stage.skillName, "private-helper");
    assert.match(previewBody.stage.skillMarkdown, new RegExp(privateSentinel));
    assert.deepEqual(previewBody.stage.files.map((entry) => entry.path), [
      "SKILL.md",
      "references/guide.txt",
    ]);

    const normalBeforeInstall = JSON.stringify(await kernel.exportUserData("normal"));
    assert.doesNotMatch(normalBeforeInstall, new RegExp(privateSentinel));
    const confirm = await fetch(`${origin}/api/v1/agent-skills/install/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stageId: previewBody.stage.id,
        sha256: previewBody.stage.sha256,
        enabledSpaces: ["secret"],
      }),
    });
    assert.equal(confirm.status, 201, await confirm.text());
    assert.equal(kernel.getAgentPermissions().networkEnabled, true);
    assert.equal(
      readFileSync(join(stateDir, "skills", "private-helper", "SKILL.md"), "utf8"),
      skillMarkdown,
    );
    const moduleId = "skill:private-helper";
    assert.deepEqual(
      kernel.listAgentModules().find((entry) => entry.id === moduleId)?.enabledSpaces,
      ["secret"],
    );
    assert.equal(kernel.getAgentModuleDetail(moduleId, "normal").content, "");
    assert.match(kernel.getAgentModuleDetail(moduleId, "secret").content, new RegExp(privateSentinel));
    assert.doesNotMatch(
      JSON.stringify(await kernel.exportUserData("normal")),
      new RegExp(privateSentinel),
    );

    const untrustedSpaceChange = await fetch(
      `${origin}/api/v1/agent-modules/${encodeURIComponent(moduleId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ enabledSpaces: ["normal"] }),
      },
    );
    assert.equal(untrustedSpaceChange.status, 403);
    assert.deepEqual(
      kernel.listAgentModules().find((entry) => entry.id === moduleId)?.enabledSpaces,
      ["secret"],
    );
    const trustedSpaceChange = await fetch(
      `${origin}/api/v1/agent-modules/${encodeURIComponent(moduleId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabledSpaces: ["secret"] }),
      },
    );
    assert.equal(trustedSpaceChange.status, 200);

    const secretDetail = await fetch(
      `${origin}/api/v1/agent-modules/${encodeURIComponent(moduleId)}` +
      `?conversationSpace=secret&characterId=${encodeURIComponent(character.id)}`,
    );
    assert.equal(secretDetail.status, 200);
    assert.match(await secretDetail.text(), new RegExp(privateSentinel));
    const normalDetail = await fetch(
      `${origin}/api/v1/agent-modules/${encodeURIComponent(moduleId)}`,
    );
    assert.equal(normalDetail.status, 200);
    assert.doesNotMatch(await normalDetail.text(), new RegExp(privateSentinel));

    await close(server);
    server = undefined;
    kernel.dispose();
    kernel = undefined;

    const restarted = new CompanionKernel({
      stateDir,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    try {
      assert.deepEqual(
        restarted.listAgentModules().find((entry) => entry.id === moduleId)?.enabledSpaces,
        ["secret"],
      );
      assert.equal(restarted.getAgentModuleDetail(moduleId, "normal").content, "");
      assert.match(restarted.getAgentModuleDetail(moduleId, "secret").content, new RegExp(privateSentinel));
      assert.equal(restarted.getAgentPermissions().networkEnabled, true);
    } finally {
      restarted.dispose();
    }
  } finally {
    if (server) await close(server);
    kernel?.dispose();
    assert.equal(existsSync(join(stateDir, "skill-installer-quarantine")), true);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Kernel rejects an installed package whose name collides with another discovery root", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-name-collision-"));
  const archive = zipSync({
    "daily-planning/SKILL.md": strToU8([
      "---",
      "name: daily-planning",
      "description: This must not replace the built-in project package.",
      "---",
      "",
      "COLLIDING_DOWNLOADED_SKILL_SENTINEL",
      "",
    ].join("\n")),
  });
  const installer = new AgentSkillInstallerService({
    stateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      response: new Response(toArrayBuffer(archive), {
        headers: { "content-type": "application/zip" },
      }),
    }),
  });
  const kernel = new CompanionKernel({
    stateDir,
    skillInstaller: installer,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  try {
    await assert.rejects(
      kernel.stageAgentSkillInstall({ sourceUrl }),
      (error: unknown) => error instanceof Error &&
        "code" in error && error.code === "SKILL_NAME_CONFLICT",
    );
    assert.equal(existsSync(join(stateDir, "skills", "daily-planning")), false);
    assert.deepEqual(
      kernel.listAgentModules().find((entry) => entry.name === "daily-planning")?.source,
      "skills/daily-planning/SKILL.md",
    );
  } finally {
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Kernel rolls back a package published outside its exact managed discovery root", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-skill-source-mismatch-"));
  const stateDir = join(root, "state");
  const installerStateDir = join(root, "other-installer-state");
  const markdown = [
    "---",
    "name: mismatched-helper",
    "description: This package must be rolled back from the wrong root.",
    "---",
    "",
    "MISMATCHED_SKILL_SENTINEL",
    "",
  ].join("\n");
  const archive = zipSync({
    "mismatched-helper/SKILL.md": strToU8(markdown),
  });
  const installer = new AgentSkillInstallerService({
    stateDir: installerStateDir,
    resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      response: new Response(toArrayBuffer(archive), {
        headers: { "content-type": "application/zip" },
      }),
    }),
  });
  const kernel = new CompanionKernel({
    stateDir,
    skillInstaller: installer,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  try {
    const stage = await kernel.stageAgentSkillInstall({ sourceUrl });
    kernel.database.connection.prepare(`
      INSERT INTO agent_skill_space_settings(
        module_id, normal_enabled, secret_enabled, updated_at
      ) VALUES (?, 1, 0, ?)
    `).run("skill:mismatched-helper", new Date().toISOString());
    assert.throws(
      () => kernel.confirmAgentSkillInstall({
        stageId: stage.stageId,
        digest: stage.digest,
        enabledSpaces: ["secret"],
      }),
      (error: unknown) => error instanceof Error &&
        "code" in error && error.code === "SKILL_SOURCE_MISMATCH",
    );
    assert.equal(
      existsSync(join(installerStateDir, "skills", "mismatched-helper")),
      false,
    );
    const setting = kernel.database.connection.prepare(`
      SELECT module_id
      FROM agent_skill_space_settings
      WHERE module_id = ?
    `).get("skill:mismatched-helper");
    assert.equal(setting, undefined);
  } finally {
    kernel.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function originOf(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}
