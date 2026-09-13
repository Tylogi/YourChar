import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SessionCapabilityMountError,
  SessionCapabilityRegistrationError,
  SessionCapabilityRegistry,
  closeMountedSessionCapabilities,
  type SessionCapability,
  type SessionCapabilityContext,
} from "../src/pi/session-capability.js";
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
  const mounts = await registry.mountAll({} as SessionCapabilityContext);
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
});

test("session capability registry fails closed on duplicate tool names", async () => {
  const events: string[] = [];
  const registry = new SessionCapabilityRegistry([
    capability("test:first", 1, events, "same_tool"),
    capability("test:second", 2, events, "same_tool"),
  ]);

  await assert.rejects(
    registry.mountAll({} as SessionCapabilityContext),
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
    registry.mountAll({} as SessionCapabilityContext, ["read", "write"]),
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
    registry.mountAll({} as SessionCapabilityContext),
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
