import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VirtualClock } from "../src/app/clock.js";
import { createHttpServer } from "../src/http/router.js";
import {
  AgentModuleSettingsConflictError,
  AgentModuleSettingsSchemaConflictError,
  AgentModuleSettingsValidationError,
  normalizeAgentModuleSettingsSchema,
} from "../src/modules/provider-settings.js";
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
const providerSettingsModuleId = "mcp:provider-settings-probe";

test("schemas 58-67 add runtime, execution, and durable goals without changing older settings", () => {
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
        67,
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
      upgraded.connection.prepare(`
        INSERT INTO agent_module_provider_settings(module_id, revision, values_json, updated_at)
        VALUES ('mcp:migration-probe', 1, '{}', '2026-09-13T00:00:00.000Z')
      `).run();
      const subagentJobColumns = new Set(
        (upgraded.connection.prepare("PRAGMA table_info(subagent_jobs)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      for (const column of [
        "transcript_json",
        "pending_input_text",
        "pending_input_sha256",
        "pending_input_characters",
        "followup_count",
        "timezone",
      ]) {
        assert.equal(subagentJobColumns.has(column), true, `${column} must be migrated`);
      }
      const deliveryColumns = new Set(
        (upgraded.connection.prepare("PRAGMA table_info(subagent_job_deliveries)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      for (const column of [
        "job_id",
        "generation",
        "status",
        "outcome_status",
        "job_revision",
        "attempts",
        "delivered_at",
        "discarded_at",
      ]) {
        assert.equal(deliveryColumns.has(column), true, `${column} must be migrated`);
      }
      const runColumns = new Set(
        (upgraded.connection.prepare("PRAGMA table_info(subagent_job_runs)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      for (const column of [
        "job_id",
        "generation",
        "status",
        "attempt_count",
        "model_calls",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "duration_ms",
        "result_characters",
        "checkpoint_at",
        "owner_id",
        "claim_token",
        "lease_expires_at",
      ]) {
        assert.equal(runColumns.has(column), true, `${column} must be migrated`);
      }
      const toolJournalColumns = new Set(
        (upgraded.connection.prepare("PRAGMA table_info(subagent_job_tool_calls)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      for (const column of [
        "job_id",
        "generation",
        "attempt",
        "model_call",
        "tool_call_id",
        "tool_name",
        "replay_policy",
        "status",
        "arguments_sha256",
        "arguments_bytes",
        "result_json",
        "result_sha256",
        "result_bytes",
        "is_error",
        "result_reason",
      ]) {
        assert.equal(toolJournalColumns.has(column), true, `${column} must be migrated`);
      }
      const executionJobColumns = new Set(
        (upgraded.connection.prepare("PRAGMA table_info(execution_jobs)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      for (const column of [
        "parent_session_id",
        "command_text",
        "command_sha256",
        "conversation_space",
        "workspace_dir",
        "workspace_access",
        "network_enabled",
        "timeout_seconds",
        "max_output_bytes",
        "current_attempt",
      ]) {
        assert.equal(executionJobColumns.has(column), true, `${column} must be migrated`);
      }
      assert.ok(upgraded.connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_job_runs'",
      ).get());
      assert.ok(upgraded.connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_job_output_chunks'",
      ).get());
      for (const table of [
        "session_goals",
        "session_goal_dependencies",
        "session_goal_todos",
        "session_goal_transitions",
      ]) {
        assert.ok(upgraded.connection.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table), `${table} must be migrated`);
      }
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
    assert.equal(snapshot.activeCapabilities.length, 16);
    assert.equal(new Set(snapshot.activeCapabilities.map((entry) => entry.id)).size, 16);

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

test("provider settings schemas reject executable or unsafe declarations", () => {
  assert.throws(
    () => normalizeAgentModuleSettingsSchema({
      version: 1,
      fields: [{
        key: "apiToken",
        kind: "secret",
        label: "API Token",
        defaultValue: "a secret must never be embedded in an inspectable schema",
      }],
    }, providerSettingsModuleId),
    (error) => error instanceof AgentModuleSettingsValidationError &&
      /secret field apiToken cannot declare a default/u.test(error.message),
  );
  assert.throws(
    () => normalizeAgentModuleSettingsSchema({
      version: 1,
      fields: [{ key: "region", kind: "text", label: "Region" }],
      ui: { slot: "arbitrary_html" as never },
    }, providerSettingsModuleId),
    /UI slot must be module_detail/u,
  );
  assert.throws(
    () => normalizeAgentModuleSettingsSchema({
      version: 1,
      fields: [{ key: "toString", kind: "text", label: "Prototype key" }],
    }, providerSettingsModuleId),
    /invalid field key toString/u,
  );
});

test("declared provider settings are revisioned, redacted, mount-scoped, and locally controlled", async () => {
  const mounts: Array<Record<string, unknown>> = [];
  const runtime = createTestRuntime({
    seed: "runtime-provider-settings",
    agentCapabilityPackages: [providerSettingsPackage(mounts)],
    agentRuntimeProfiles: [{
      id: "default",
      name: "Configured provider",
      description: "Loads one provider-settings fixture.",
      packageIds: ["provider-settings-fixture"],
    }],
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const module = runtime.kernel.listAgentModules()
      .find((entry) => entry.id === providerSettingsModuleId);
    assert.equal(module?.hasSettings, true);
    assert.equal(module?.settingsUi, true);
    const initial = runtime.kernel.getAgentModuleProviderSettings(providerSettingsModuleId);
    assert.equal(initial.revision, 0);
    assert.equal(initial.complete, false);
    assert.deepEqual(initial.values, {
      retries: 2,
      region: "global",
      telemetry: false,
    });
    assert.deepEqual(initial.secrets, {
      apiToken: { configured: false, masked: "" },
    });

    runtime.model.enqueue([{ kind: "assistant_text", text: "默认配置。" }]);
    await runtime.kernel.sendMessage("provider-settings", { mode: "sms", text: "检查默认值。" });
    assert.deepEqual(mounts, [{ retries: 2, region: "global", telemetry: false }]);

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const settingsPath = `/api/v1/agent-modules/${encodeURIComponent(providerSettingsModuleId)}/settings`;
    const rejected = await fetch(`${baseUrl}${settingsPath}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({
        expectedSchemaVersion: 1,
        expectedRevision: 0,
        values: { apiToken: "REJECTED_PROVIDER_TOKEN" },
      }),
    });
    assert.equal(rejected.status, 403);

    const bootstrap = await fetch(`${baseUrl}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const providerToken = "PRIVATE_PROVIDER_TOKEN_SENTINEL";
    const accepted = await fetch(`${baseUrl}${settingsPath}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: baseUrl,
      },
      body: JSON.stringify({
        expectedSchemaVersion: 1,
        expectedRevision: 0,
        values: {
          endpoint: "https://provider.example/v1",
          apiToken: providerToken,
          retries: 4,
          region: "eu",
          telemetry: true,
        },
      }),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json() as {
      settings: { revision: number; complete: boolean; secrets: Record<string, unknown> };
    };
    assert.equal(acceptedBody.settings.revision, 1);
    assert.equal(acceptedBody.settings.complete, true);
    assert.deepEqual(acceptedBody.settings.secrets, {
      apiToken: { configured: true, masked: "••••••••" },
    });
    assert.doesNotMatch(JSON.stringify(acceptedBody), new RegExp(providerToken, "u"));
    const settingsAudit = runtime.kernel.store.actions.at(-1);
    assert.equal(settingsAudit?.actionType, "set_agent_module_provider_settings");
    assert.deepEqual(settingsAudit?.payload.changedKeys, [
      "apiToken",
      "endpoint",
      "region",
      "retries",
      "telemetry",
    ]);
    assert.doesNotMatch(JSON.stringify(settingsAudit), new RegExp(providerToken, "u"));
    assert.doesNotMatch(
      JSON.stringify(runtime.kernel.getAgentRuntimeConfiguration()),
      new RegExp(providerToken, "u"),
    );
    const projected = await fetch(`${baseUrl}${settingsPath}`);
    assert.equal(projected.status, 200);
    const projectedText = await projected.text();
    assert.doesNotMatch(projectedText, new RegExp(providerToken, "u"));
    assert.doesNotMatch(projectedText, /"apiToken"\s*:\s*"PRIVATE/u);

    runtime.model.enqueue([{ kind: "assistant_text", text: "已使用新配置。" }]);
    await runtime.kernel.sendMessage("provider-settings", { mode: "sms", text: "重新检查。" });
    assert.deepEqual(mounts.at(-1), {
      endpoint: "https://provider.example/v1",
      apiToken: providerToken,
      retries: 4,
      region: "eu",
      telemetry: true,
    });

    const stale = await fetch(`${baseUrl}${settingsPath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({
        expectedSchemaVersion: 1,
        expectedRevision: 0,
        values: { retries: 3 },
      }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as { code: string; actualRevision: number };
    assert.equal(staleBody.code, "AGENT_MODULE_SETTINGS_CONFLICT");
    assert.equal(staleBody.actualRevision, 1);
    assert.throws(
      () => runtime.kernel.patchAgentModuleProviderSettings(providerSettingsModuleId, {
        expectedSchemaVersion: 1,
        expectedRevision: 1,
        values: { retries: 99 },
      }),
      AgentModuleSettingsValidationError,
    );
    assert.throws(
      () => runtime.kernel.patchAgentModuleProviderSettings(providerSettingsModuleId, {
        expectedSchemaVersion: 2,
        expectedRevision: 1,
        values: { retries: 3 },
      }),
      AgentModuleSettingsSchemaConflictError,
    );

    const cleared = runtime.kernel.patchAgentModuleProviderSettings(providerSettingsModuleId, {
      expectedSchemaVersion: 1,
      expectedRevision: 1,
      values: { endpoint: "https://provider.example/v2" },
      clear: ["apiToken"],
    });
    assert.equal(cleared.revision, 2);
    assert.equal(cleared.complete, false);
    assert.equal(cleared.secrets.apiToken?.configured, false);
    assert.doesNotMatch(JSON.stringify(cleared), new RegExp(providerToken, "u"));
    runtime.model.enqueue([{ kind: "assistant_text", text: "密钥已清除。" }]);
    await runtime.kernel.sendMessage("provider-settings", { mode: "sms", text: "确认清除。" });
    assert.deepEqual(mounts.at(-1), {
      endpoint: "https://provider.example/v2",
      retries: 4,
      region: "eu",
      telemetry: true,
    });

    assert.throws(
      () => runtime.kernel.patchAgentModuleProviderSettings(providerSettingsModuleId, {
        expectedSchemaVersion: 1,
        expectedRevision: 1,
        values: { retries: 3 },
      }),
      AgentModuleSettingsConflictError,
    );
    await runtime.kernel.deleteAllUserData();
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(
        "SELECT COUNT(*) AS count FROM agent_module_provider_settings",
      ).get() as { count: number }).count),
      0,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    runtime.dispose();
  }
});

test("provider settings survive restart while secret values remain write-only", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-provider-settings-restart-"));
  const mounts: Array<Record<string, unknown>> = [];
  const options = {
    stateDir,
    agentCapabilityPackages: [providerSettingsPackage(mounts)],
    agentRuntimeProfiles: [{
      id: "default",
      name: "Configured provider",
      description: "Loads one provider-settings fixture.",
      packageIds: ["provider-settings-fixture"],
    }],
  } as const;
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    ...options,
    seed: "provider-settings-restart-first",
  });
  const providerToken = "RESTARTED_PROVIDER_TOKEN_SENTINEL";
  try {
    const saved = first.kernel.patchAgentModuleProviderSettings(providerSettingsModuleId, {
      expectedSchemaVersion: 1,
      expectedRevision: 0,
      values: {
        endpoint: "https://restart.example/v1",
        apiToken: providerToken,
      },
    });
    assert.equal(saved.revision, 1);
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      ...options,
      seed: "provider-settings-restart-second",
    });
    try {
      const restored = second.kernel.getAgentModuleProviderSettings(providerSettingsModuleId);
      assert.equal(restored.revision, 1);
      assert.equal(restored.complete, true);
      assert.equal(restored.values.endpoint, "https://restart.example/v1");
      assert.equal(restored.secrets.apiToken?.configured, true);
      assert.doesNotMatch(JSON.stringify(restored), new RegExp(providerToken, "u"));
      second.model.enqueue([{ kind: "assistant_text", text: "已恢复配置。" }]);
      await second.kernel.sendMessage("provider-settings-restart", {
        mode: "sms",
        text: "检查重启后的配置。",
      });
      assert.deepEqual(mounts.at(-1), {
        endpoint: "https://restart.example/v1",
        apiToken: providerToken,
        retries: 2,
        region: "global",
        telemetry: false,
      });
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
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

function providerSettingsPackage(
  mounts: Array<Record<string, unknown>>,
): AgentCapabilityPackage {
  return {
    id: "provider-settings-fixture",
    name: "Provider Settings Fixture",
    version: "1",
    contentDigest: "f".repeat(64),
    source: "test fixture",
    trusted: true,
    capabilities: [{
      id: "test:provider-settings",
      moduleContribution: {
        id: providerSettingsModuleId,
        name: "Provider Settings Probe MCP",
        description: "A test-only provider configuration surface.",
        source: "test",
        defaultEnabled: true,
        estimatedTokens: 1,
        detail: "# Provider Settings Probe MCP\n\nExercises declarative settings.\n",
        settings: {
          version: 1,
          fields: [{
            key: "endpoint",
            kind: "text",
            label: "Endpoint",
            required: true,
            maxLength: 300,
            placeholder: "https://provider.example/v1",
          }, {
            key: "apiToken",
            kind: "secret",
            label: "API Token",
            required: true,
            minLength: 8,
            maxLength: 200,
          }, {
            key: "retries",
            kind: "integer",
            label: "Retries",
            defaultValue: 2,
            minimum: 0,
            maximum: 5,
          }, {
            key: "region",
            kind: "select",
            label: "Region",
            defaultValue: "global",
            options: [
              { value: "global", label: "Global" },
              { value: "eu", label: "Europe" },
            ],
          }, {
            key: "telemetry",
            kind: "boolean",
            label: "Telemetry",
            defaultValue: false,
          }],
          ui: {
            slot: "module_detail",
            title: "Provider connection",
            description: "Values are scoped to this module.",
            submitLabel: "Save provider",
          },
        },
      },
      async mount(context) {
        mounts.push({ ...context.settings });
        return { tools: [] };
      },
    }],
  };
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
