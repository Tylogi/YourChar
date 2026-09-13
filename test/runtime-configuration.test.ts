import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VirtualClock } from "../src/app/clock.js";
import { createHttpServer } from "../src/http/router.js";
import type {
  AgentCapabilityPackage,
  AgentRuntimeProfileDefinition,
} from "../src/pi/runtime-configuration.js";
import { AgentRuntimeConfigurationManager } from "../src/pi/runtime-configuration.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/runtime.js";

const moduleId = "mcp:profile-probe";
const capabilityId = "test:profile-probe";
const toolName = "profile_probe";

test("schema 58 adds the derived runtime snapshot without changing older settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-runtime-schema-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new AppDatabase(path, { maxMigrationVersion: 57 });
    legacy.connection.prepare(`
      INSERT INTO agent_module_settings(module_id, enabled, updated_at)
      VALUES ('mcp:vision', 1, '2026-09-13T00:00:00.000Z')
    `).run();
    legacy.close();

    const upgraded = new AppDatabase(path);
    try {
      assert.equal(
        Number((upgraded.connection.prepare(
          "SELECT MAX(version) AS version FROM schema_migrations",
        ).get() as { version: number }).version),
        58,
      );
      const manager = new AgentRuntimeConfigurationManager(
        upgraded,
        new VirtualClock("2026-09-13T00:00:00.000Z"),
      );
      assert.equal(manager.get().revision, 1);
      assert.equal(
        Number((upgraded.connection.prepare(
          "SELECT enabled FROM agent_module_settings WHERE module_id = 'mcp:vision'",
        ).get() as { enabled: number }).enabled),
        1,
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default runtime configuration is inspectable, bounded, and persisted without code", () => {
  const runtime = createTestRuntime({ seed: "runtime-configuration-default" });
  try {
    const snapshot = runtime.kernel.getAgentRuntimeConfiguration();
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.activeProfileId, "default");
    assert.match(snapshot.digest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      snapshot.packages.map((entry) => [entry.id, entry.trust, entry.active]),
      [["builtin-core", "built_in", true]],
    );
    assert.equal(snapshot.activeCapabilities.length, 14);
    assert.equal(new Set(snapshot.activeCapabilities.map((entry) => entry.id)).size, 14);

    const row = runtime.kernel.database.connection.prepare(`
      SELECT revision, digest, snapshot_json
      FROM agent_runtime_configuration_snapshots
      WHERE singleton = 1
    `).get() as { revision: number; digest: string; snapshot_json: string };
    assert.equal(Number(row.revision), snapshot.revision);
    assert.equal(row.digest, snapshot.digest);
    assert.equal(JSON.parse(row.snapshot_json).activeProfileId, "default");
    assert.doesNotMatch(row.snapshot_json, /mount|function|apiKey|secret-key/u);
  } finally {
    runtime.dispose();
  }
});

test("an untrusted package is inventoried but remains inactive by default", () => {
  const calls: string[] = [];
  const runtime = createTestRuntime({
    seed: "runtime-untrusted-package",
    agentCapabilityPackages: [{ ...probePackage("e", calls), trusted: false }],
  });
  try {
    const packageSnapshot = runtime.kernel.getAgentRuntimeConfiguration().packages
      .find((entry) => entry.id === "test-probes");
    assert.ok(packageSnapshot);
    assert.equal(packageSnapshot.trust, "untrusted");
    assert.equal(packageSnapshot.active, false);
    assert.equal(runtime.kernel.listAgentModules().some((entry) => entry.id === moduleId), false);
  } finally {
    runtime.dispose();
  }
});

test("profile activation adds and removes a package at an idle cleanup boundary", async () => {
  let closeStarted = false;
  let releaseClose: (() => void) | undefined;
  const calls: string[] = [];
  const runtime = createTestRuntime({
    seed: "runtime-profile-activation",
    agentCapabilityPackages: [probePackage("a", calls, () => new Promise<void>((resolve) => {
      closeStarted = true;
      releaseClose = resolve;
    }))],
    agentRuntimeProfiles: runtimeProfiles(),
    activeAgentRuntimeProfileId: "lean",
  });
  try {
    assert.equal(runtime.kernel.listAgentModules().some((entry) => entry.id === moduleId), false);
    assert.equal(
      runtime.kernel.getAgentRuntimeConfiguration().packages
        .find((entry) => entry.id === "test-probes")?.active,
      false,
    );

    const activated = runtime.kernel.activateAgentRuntimeProfile("extended");
    assert.equal(activated.revision, 2);
    assert.equal(activated.activeProfileId, "extended");
    assert.equal(runtime.kernel.listAgentModules().find((entry) => entry.id === moduleId)?.enabled, true);

    runtime.model.enqueue([
      { kind: "tool_call", name: toolName, arguments: {} },
      { kind: "assistant_text", text: "扩展探针已运行。" },
    ]);
    await runtime.kernel.sendMessage("runtime-profile", { mode: "sms", text: "运行扩展。" });
    assert.deepEqual(calls, ["a"]);

    const requestsBeforeRemoval = runtime.model.requests.length;
    const deactivated = runtime.kernel.activateAgentRuntimeProfile("lean");
    assert.equal(deactivated.revision, 3);
    assert.equal(runtime.kernel.listAgentModules().some((entry) => entry.id === moduleId), false);
    runtime.model.enqueue([{ kind: "assistant_text", text: "现在是精简配置。" }]);
    const nextTurn = runtime.kernel.sendMessage("runtime-profile", {
      mode: "sms",
      text: "确认扩展已移除。",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeStarted, true);
    assert.equal(
      runtime.model.requests.length,
      requestsBeforeRemoval,
      "a replacement handle must wait until the prior package finishes closing",
    );
    releaseClose?.();
    await nextTurn;
    assert.equal(runtime.model.requests.at(-1)?.toolNames.includes(toolName), false);
  } finally {
    releaseClose?.();
    runtime.dispose();
  }
});

test("trusted host reload detects artifact changes and rolls back invalid configurations", async () => {
  const calls: string[] = [];
  const runtime = createTestRuntime({
    seed: "runtime-package-reload",
    agentCapabilityPackages: [probePackage("a", calls)],
    agentRuntimeProfiles: [{
      id: "default",
      name: "Default with probes",
      description: "Loads the reviewed probe package.",
      packageIds: ["test-probes"],
    }],
  });
  try {
    runtime.model.enqueue([
      { kind: "tool_call", name: toolName, arguments: {} },
      { kind: "assistant_text", text: "v1" },
    ]);
    await runtime.kernel.sendMessage("runtime-reload", { mode: "sms", text: "v1" });

    const reloaded = runtime.kernel.reloadAgentRuntimeConfiguration({
      packages: [probePackage("b", calls)],
      profiles: [{
        id: "default",
        name: "Default with probes",
        description: "Loads the reviewed probe package.",
        packageIds: ["test-probes"],
      }],
    });
    assert.equal(reloaded.revision, 2);
    runtime.model.enqueue([
      { kind: "tool_call", name: toolName, arguments: {} },
      { kind: "assistant_text", text: "v2" },
    ]);
    await runtime.kernel.sendMessage("runtime-reload", { mode: "sms", text: "v2" });
    assert.deepEqual(calls, ["a", "b"]);

    const beforeInvalidReload = runtime.kernel.getAgentRuntimeConfiguration();
    runtime.kernel.database.connection.exec(`
      CREATE TRIGGER fail_runtime_configuration_snapshot
      BEFORE UPDATE ON agent_runtime_configuration_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'simulated snapshot failure');
      END;
    `);
    assert.throws(
      () => runtime.kernel.reloadAgentRuntimeConfiguration({
        packages: [probePackage("c", calls)],
        profiles: [{
          id: "default",
          name: "Default with probes",
          description: "Loads the reviewed probe package.",
          packageIds: ["test-probes"],
        }],
      }),
      /simulated snapshot failure/u,
    );
    runtime.kernel.database.connection.exec("DROP TRIGGER fail_runtime_configuration_snapshot");
    assert.equal(
      runtime.kernel.getAgentRuntimeConfiguration().digest,
      beforeInvalidReload.digest,
    );
    runtime.model.enqueue([
      { kind: "tool_call", name: toolName, arguments: {} },
      { kind: "assistant_text", text: "still v2" },
    ]);
    await runtime.kernel.sendMessage("runtime-reload", { mode: "sms", text: "still v2" });
    assert.deepEqual(calls, ["a", "b", "b"]);

    assert.throws(
      () => runtime.kernel.reloadAgentRuntimeConfiguration({
        packages: [{ ...probePackage("c", calls), trusted: false }],
        profiles: [{
          id: "default",
          name: "Unsafe",
          description: "Must not activate code that has not been reviewed.",
          packageIds: ["test-probes"],
        }],
      }),
      /cannot activate untrusted package test-probes/u,
    );
    assert.equal(
      runtime.kernel.getAgentRuntimeConfiguration().digest,
      beforeInvalidReload.digest,
    );
    assert.equal(runtime.kernel.listAgentModules().some((entry) => entry.id === moduleId), true);

    const uninstalled = runtime.kernel.reloadAgentRuntimeConfiguration({
      packages: [],
      profiles: [{
        id: "default",
        name: "Default",
        description: "Built-in capabilities only.",
        packageIds: [],
      }],
    });
    assert.equal(uninstalled.revision, 3);
    assert.equal(runtime.kernel.listAgentModules().some((entry) => entry.id === moduleId), false);
  } finally {
    runtime.dispose();
  }
});

test("profile selection survives restart and the HTTP control plane exposes only snapshots", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-runtime-profile-"));
  const calls: string[] = [];
  const options = {
    stateDir,
    agentCapabilityPackages: [probePackage("d", calls)],
    agentRuntimeProfiles: runtimeProfiles(),
  } as const;
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    ...options,
    seed: "runtime-profile-first",
    activeAgentRuntimeProfileId: "lean",
  });
  try {
    const activated = first.kernel.activateAgentRuntimeProfile("extended");
    first.dispose();
    first = undefined;

    const second = createTestRuntime({ ...options, seed: "runtime-profile-second" });
    try {
      const restored = second.kernel.getAgentRuntimeConfiguration();
      assert.equal(restored.activeProfileId, "extended");
      assert.equal(restored.revision, activated.revision);
      assert.equal(restored.resolvedAt, activated.resolvedAt);
      assert.equal(second.kernel.listAgentModules().some((entry) => entry.id === moduleId), true);

      const server = createHttpServer({ kernel: second.kernel });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${baseUrl}/api/v1/agent-runtime/configuration`);
        assert.equal(response.status, 200);
        const body = await response.json() as { configuration: { digest: string } };
        assert.equal(body.configuration.digest, restored.digest);
        assert.doesNotMatch(JSON.stringify(body), /mount|function/u);

        const rejected = await fetch(`${baseUrl}/api/v1/agent-runtime/profile`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            origin: "https://untrusted.example",
          },
          body: JSON.stringify({ profileId: "lean" }),
        });
        assert.equal(rejected.status, 403);
        assert.equal(second.kernel.getAgentRuntimeConfiguration().activeProfileId, "extended");

        const bootstrap = await fetch(`${baseUrl}/`);
        const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
        assert.ok(cookie);
        assert.match(await bootstrap.text(), /id="runtimeProfileSelect"/u);
        const accepted = await fetch(`${baseUrl}/api/v1/agent-runtime/profile`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: baseUrl,
          },
          body: JSON.stringify({ profileId: "lean" }),
        });
        assert.equal(accepted.status, 200);
        const acceptedBody = await accepted.json() as {
          configuration: { activeProfileId: string; revision: number };
        };
        assert.equal(acceptedBody.configuration.activeProfileId, "lean");
        assert.equal(acceptedBody.configuration.revision, restored.revision + 1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve())
        );
      }
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function runtimeProfiles(): readonly AgentRuntimeProfileDefinition[] {
  return [{
    id: "lean",
    name: "Lean",
    description: "Built-in capabilities only.",
    packageIds: [],
  }, {
    id: "extended",
    name: "Extended",
    description: "Adds the reviewed probe package.",
    packageIds: ["test-probes"],
  }];
}

function probePackage(
  version: string,
  calls: string[],
  close: () => void | Promise<void> = () => undefined,
): AgentCapabilityPackage {
  return {
    id: "test-probes",
    name: "Test Probes",
    version,
    contentDigest: version.repeat(64),
    source: "test fixture",
    trusted: true,
    capabilities: [{
      id: capabilityId,
      moduleContribution: {
        id: moduleId,
        name: "Profile Probe MCP",
        description: "A profile-scoped test capability.",
        source: "test",
        defaultEnabled: true,
        estimatedTokens: 12,
        detail: "# Profile Probe MCP\n\nA profile-scoped test capability.\n",
        context: {
          order: 20_000,
          enabled: "Capability status: Profile Probe MCP is enabled.",
          disabled: "Capability status: Profile Probe MCP is disabled.",
        },
      },
      async mount() {
        return {
          tools: [defineTool({
            name: toolName,
            label: "Profile probe",
            description: "Return the active test package version.",
            parameters: Type.Object({}),
            async execute() {
              calls.push(version);
              return {
                content: [{ type: "text", text: version }],
                details: { version },
              };
            },
          })],
          close,
        };
      },
    }],
  };
}
