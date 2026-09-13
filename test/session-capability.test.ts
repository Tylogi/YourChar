import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VirtualClock } from "../src/app/clock.js";
import {
  AgentMcpModuleContributionError,
  AgentModuleCatalog,
} from "../src/modules/catalog.js";
import {
  SessionCapabilityMountError,
  SessionCapabilityRegistrationError,
  SessionCapabilityRegistry,
  closeMountedSessionCapabilities,
  type SessionCapability,
  type SessionCapabilityRegistryContext,
} from "../src/pi/session-capability.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("session capability registry orders mounts and closes them once in reverse order", async () => {
  const events: string[] = [];
  const registry = new SessionCapabilityRegistry([
    capability("test:later", 20, events),
    capability("test:earlier", 10, events),
    {
      id: "test:disabled",
      order: 15,
      mount: async () => {
        events.push("mount:disabled");
        return undefined;
      },
    },
  ]);

  assert.deepEqual(registry.list(), [
    { id: "test:earlier", order: 10 },
    { id: "test:disabled", order: 15 },
    { id: "test:later", order: 20 },
  ]);
  const mounts = await registry.mountAll({} as SessionCapabilityRegistryContext);
  assert.deepEqual(events, ["mount:earlier", "mount:disabled", "mount:later"]);
  assert.deepEqual(mounts.map((mount) => mount.id), ["test:earlier", "test:later"]);

  await closeMountedSessionCapabilities(mounts);
  await closeMountedSessionCapabilities(mounts);
  assert.deepEqual(events, [
    "mount:earlier",
    "mount:disabled",
    "mount:later",
    "close:later",
    "close:earlier",
  ]);
});

test("session capability registry resolves one immutable settings namespace per module", async () => {
  const observed: Array<{ moduleId: string; settings: Record<string, unknown> }> = [];
  const registry = new SessionCapabilityRegistry([{
    id: "test:settings-one",
    moduleId: "mcp:settings-one",
    async mount(context) {
      observed.push({ moduleId: "mcp:settings-one", settings: { ...context.settings } });
      return undefined;
    },
  }, {
    id: "test:settings-two",
    moduleId: "mcp:settings-two",
    async mount(context) {
      observed.push({ moduleId: "mcp:settings-two", settings: { ...context.settings } });
      return undefined;
    },
  }]);
  await registry.mountAll({
    moduleEnabled: () => true,
    settingsForModule: (moduleId: string) => Object.freeze({
      owner: moduleId,
      [moduleId === "mcp:settings-one" ? "one" : "two"]: true,
    }),
  } as unknown as SessionCapabilityRegistryContext);
  assert.deepEqual(observed, [{
    moduleId: "mcp:settings-one",
    settings: { owner: "mcp:settings-one", one: true },
  }, {
    moduleId: "mcp:settings-two",
    settings: { owner: "mcp:settings-two", two: true },
  }]);
});

test("session capability registry rejects invalid and duplicate identities", () => {
  assert.throws(
    () => new SessionCapabilityRegistry([
      capability("test:same", 1, []),
      capability("test:same", 2, []),
    ]),
    (error) => error instanceof SessionCapabilityRegistrationError &&
      /duplicate session capability id/u.test(error.message),
  );
  assert.throws(
    () => new SessionCapabilityRegistry([{
      id: "UPPER CASE",
      mount: async () => undefined,
    }]),
    SessionCapabilityRegistrationError,
  );
  assert.throws(
    () => new SessionCapabilityRegistry([
      { id: "test:module-one", moduleId: "mcp:test-shared", mount: async () => undefined },
      { id: "test:module-two", moduleId: "mcp:test-shared", mount: async () => undefined },
    ]),
    (error) => error instanceof SessionCapabilityRegistrationError &&
      /already bound to session capability test:module-one/u.test(error.message),
  );
});

test("module contributions cannot shadow a built-in module", (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  assert.throws(
    () => new AgentModuleCatalog(
      database,
      new VirtualClock("2026-09-13T00:00:00.000Z"),
      {
        additionalMcpModules: [{
          id: "mcp:schedule",
          name: "Shadow Schedule",
          description: "Must not replace a built-in module.",
          source: "test",
          defaultEnabled: false,
          estimatedTokens: 1,
          detail: "# Shadow Schedule",
        }],
      },
    ),
    (error) => error instanceof AgentMcpModuleContributionError &&
      /duplicate MCP module contribution id: mcp:schedule/u.test(error.message),
  );
});

test("module contributions reject malformed context metadata", (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  assert.throws(
    () => new AgentModuleCatalog(
      database,
      new VirtualClock("2026-09-13T00:00:00.000Z"),
      {
        additionalMcpModules: [{
          id: "mcp:invalid-context",
          name: "Invalid Context MCP",
          description: "Must fail closed instead of silently dropping invalid context.",
          source: "test",
          defaultEnabled: false,
          estimatedTokens: 1,
          detail: "# Invalid Context MCP",
          context: null as never,
        }],
      },
    ),
    (error) => error instanceof AgentMcpModuleContributionError &&
      /context must be an object/u.test(error.message),
  );
});

test("session capability registry fails closed on duplicate tool names", async () => {
  const events: string[] = [];
  const registry = new SessionCapabilityRegistry([
    capability("test:first", 1, events, "same_tool"),
    capability("test:second", 2, events, "same_tool"),
  ]);

  await assert.rejects(
    registry.mountAll({} as SessionCapabilityRegistryContext),
    (error) => error instanceof SessionCapabilityMountError &&
      error.capabilityId === "test:second" &&
      /conflicts with test:first/u.test(error.message),
  );
  assert.deepEqual(events, [
    "mount:first",
    "mount:second",
    "close:second",
    "close:first",
  ]);
});

test("session capability registry cannot shadow a host tool", async () => {
  const events: string[] = [];
  const registry = new SessionCapabilityRegistry([
    capability("test:shadow", 1, events, "read"),
  ]);

  await assert.rejects(
    registry.mountAll({} as SessionCapabilityRegistryContext, ["read", "write"]),
    (error) => error instanceof SessionCapabilityMountError &&
      error.capabilityId === "test:shadow" &&
      /conflicts with host runtime/u.test(error.message),
  );
  assert.deepEqual(events, ["mount:shadow", "close:shadow"]);
});

test("session capability registry rolls back earlier mounts after a later failure", async () => {
  const events: string[] = [];
  const registry = new SessionCapabilityRegistry([
    capability("test:first", 1, events),
    {
      id: "test:failing",
      order: 2,
      mount: async () => {
        events.push("mount:failing");
        throw new Error("boom");
      },
    },
  ]);

  await assert.rejects(
    registry.mountAll({} as SessionCapabilityRegistryContext),
    (error) => error instanceof SessionCapabilityMountError &&
      error.capabilityId === "test:failing" &&
      error.cause instanceof Error &&
      error.cause.message === "boom",
  );
  assert.deepEqual(events, ["mount:first", "mount:failing", "close:first"]);
});

test("a trusted additional capability mounts without changing PiSessionRuntime", async () => {
  const lifecycle: string[] = [];
  let calls = 0;
  const runtime = createTestRuntime({
    additionalSessionCapabilities: [{
      id: "test:runtime-probe",
      order: 2_000,
      async mount(context) {
        lifecycle.push(`mount:${context.sessionId}:${context.conversationSpace}`);
        return {
          tools: [defineTool({
            name: "runtime_probe",
            label: "Runtime probe",
            description: "Return a deterministic probe value.",
            parameters: Type.Object({}),
            async execute() {
              calls += 1;
              return {
                content: [{ type: "text", text: "probe-ok" }],
                details: { ok: true },
              };
            },
          })],
          close: async () => {
            lifecycle.push(`close:${context.sessionId}`);
          },
        };
      },
    }],
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "林澈" });
    runtime.model.enqueue([
      { kind: "tool_call", name: "runtime_probe", arguments: {} },
      { kind: "assistant_text", text: "探针完成。" },
    ]);
    await runtime.kernel.sendMessage("capability-probe", {
      mode: "sms",
      characterId: character.id,
      text: "运行探针。",
    });

    assert.equal(calls, 1);
    assert.equal(runtime.model.requests[0]?.toolNames.includes("runtime_probe"), true);
    assert.deepEqual(lifecycle, ["mount:capability-probe:normal"]);

    const metadata = runtime.kernel.sessionRuntime.getConversationMetadata()
      .find((entry) => entry.id === "capability-probe");
    assert.ok(metadata);
    await runtime.kernel.sessionRuntime.deleteConversation(
      metadata.id,
      metadata.title || metadata.id,
    );
    assert.deepEqual(lifecycle, [
      "mount:capability-probe:normal",
      "close:capability-probe",
    ]);
  } finally {
    runtime.dispose();
  }
});

test("one capability contribution drives module UI, context, enablement, and mounting", async () => {
  const moduleId = "mcp:runtime-probe";
  let mounts = 0;
  let closes = 0;
  let calls = 0;
  const runtime = createTestRuntime({
    additionalSessionCapabilities: [{
      id: "test:contributed-runtime-probe",
      moduleContribution: {
        id: moduleId,
        name: "Runtime Probe MCP",
        description: "A test-only declarative capability.",
        source: "test",
        defaultEnabled: false,
        estimatedTokens: 12,
        detail: "# Runtime Probe MCP\n\nA declarative test module.\n",
        context: {
          order: 10_000,
          enabled: "Capability status: Runtime Probe MCP is enabled.",
          disabled: "Capability status: Runtime Probe MCP is disabled.",
          availableSpaces: ["normal"],
        },
      },
      async mount() {
        mounts += 1;
        return {
          tools: [defineTool({
            name: "contributed_runtime_probe",
            label: "Contributed runtime probe",
            description: "Return a deterministic contributed probe value.",
            parameters: Type.Object({}),
            async execute() {
              calls += 1;
              return {
                content: [{ type: "text", text: "contributed-probe-ok" }],
                details: { ok: true },
              };
            },
          })],
          close: async () => {
            closes += 1;
          },
        };
      },
    }],
  });
  try {
    const module = runtime.kernel.listAgentModules().find((entry) => entry.id === moduleId);
    assert.deepEqual(module, {
      id: moduleId,
      type: "mcp",
      name: "Runtime Probe MCP",
      description: "A test-only declarative capability.",
      source: "test",
      enabled: false,
      defaultEnabled: false,
      estimatedTokens: 12,
    });
    assert.match(runtime.kernel.getAgentModuleDetail(moduleId).content, /declarative test module/u);

    const character = runtime.kernel.createCharacter({ name: "闻溪" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "当前不运行探针。" }]);
    await runtime.kernel.sendMessage("contributed-probe", {
      mode: "sms",
      characterId: character.id,
      text: "先检查模块。",
    });
    assert.equal(mounts, 0);
    assert.equal(runtime.model.requests[0]?.toolNames.includes("contributed_runtime_probe"), false);
    assert.match(runtime.model.requests[0]?.systemPrompt ?? "", /Runtime Probe MCP is disabled/u);

    runtime.kernel.setAgentModuleEnabled(moduleId, true);
    runtime.model.enqueue([
      { kind: "tool_call", name: "contributed_runtime_probe", arguments: {} },
      { kind: "assistant_text", text: "声明式探针完成。" },
    ]);
    await runtime.kernel.sendMessage("contributed-probe", {
      mode: "sms",
      characterId: character.id,
      text: "现在运行探针。",
    });
    assert.equal(mounts, 1);
    assert.equal(calls, 1);
    assert.equal(runtime.model.requests[1]?.toolNames.includes("contributed_runtime_probe"), true);
    assert.match(runtime.model.requests[1]?.systemPrompt ?? "", /Runtime Probe MCP is enabled/u);

    runtime.kernel.setAgentModuleEnabled(moduleId, false);
    await Promise.resolve();
    runtime.model.enqueue([{ kind: "assistant_text", text: "模块已经关闭。" }]);
    await runtime.kernel.sendMessage("contributed-probe", {
      mode: "sms",
      characterId: character.id,
      text: "再次检查模块。",
    });
    assert.equal(closes, 1);
    assert.equal(runtime.model.requests.at(-1)?.toolNames.includes("contributed_runtime_probe"), false);
    assert.match(runtime.model.requests.at(-1)?.systemPrompt ?? "", /Runtime Probe MCP is disabled/u);
  } finally {
    runtime.dispose();
  }
});

function capability(
  id: string,
  order: number,
  events: string[],
  toolName = `${id.replaceAll(":", "_")}_tool`,
): SessionCapability {
  const label = id.split(":").at(-1) ?? id;
  return {
    id,
    order,
    async mount() {
      events.push(`mount:${label}`);
      return {
        tools: [defineTool({
          name: toolName,
          label: toolName,
          description: `Tool for ${id}`,
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        })],
        close: async () => {
          events.push(`close:${label}`);
        },
      };
    },
  };
}
