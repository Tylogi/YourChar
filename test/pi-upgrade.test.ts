import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ScriptedModelController } from "../src/testing/runtime.js";

test("Pi 0.84 compacts a threshold-crossing tool result before the next model request", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "yourchar-pi-upgrade-"));
  const controller = new ScriptedModelController("pi-upgrade-compaction", {
    contextWindowTokens: 8_192,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = await controller.resolver({ appSessionId: "pi-upgrade", modelRuntime });
  assert.ok(model);

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 6_144,
      keepRecentTokens: 1_255,
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "Pi upgrade regression test.",
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const largeOutputTool = defineTool({
    name: "large_output",
    label: "Large output",
    description: "Return enough data to cross the configured compaction threshold.",
    parameters: Type.Object({}),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute() {
      return {
        content: [{ type: "text" as const, text: "T".repeat(5_000) }],
        details: {},
      };
    },
  });

  controller.enqueue([
    { kind: "assistant_text", text: "S".repeat(5_000) },
    { kind: "tool_call", name: "large_output", arguments: {} },
    { kind: "assistant_text", text: "The earlier seed turn contained repeated test data." },
    { kind: "assistant_text", text: "final after compact" },
  ]);

  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    thinkingLevel: "off",
    noTools: "builtin",
    tools: [largeOutputTool.name],
    customTools: [largeOutputTool],
  });
  const events: AgentSessionEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  try {
    await session.prompt("seed prior context", { expandPromptTemplates: false, source: "rpc" });
    assert.equal(controller.requests.length, 1);

    await session.prompt("call the large output tool", {
      expandPromptTemplates: false,
      source: "rpc",
    });

    assert.ok(controller.requests.length >= 4);
    assert.equal(controller.requests[2]?.toolNames.length, 0, "compaction must not expose tools");
    assert.match(JSON.stringify(controller.requests[2]?.messages), /Summarize|summary|conversation/iu);
    assert.equal(session.getLastAssistantText(), "final after compact");
    assert.ok(events.some((event) => event.type === "compaction_start" && event.reason === "threshold"));
    assert.ok(events.some((event) =>
      event.type === "compaction_end" &&
      event.reason === "threshold" &&
      !event.aborted &&
      !event.errorMessage
    ));
    assert.equal(events.filter((event) => event.type === "agent_settled").length, 2);
  } finally {
    unsubscribe();
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
