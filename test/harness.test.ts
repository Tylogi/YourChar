import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentContext,
  type AgentMessage,
  type AgentTool,
  assistantToolCall,
  runAgentLoop,
  textMessage,
  textOf,
  toolResultsOf,
} from "../src/harness/index.js";

test("agent loop executes a tool call and continues to final text", async () => {
  const tool: AgentTool<{ value: string }, string> = {
    name: "echo",
    description: "Echo a value",
    validate(input) {
      return { value: String(input.value ?? "") };
    },
    async execute(input) {
      return { content: input.value };
    },
  };

  const model = async (context: AgentContext): Promise<AgentMessage> => {
    const last = context.messages.at(-1);
    if (last?.role === "tool") {
      const result = toolResultsOf(last)[0];
      return textMessage("assistant", `final:${result.content}`);
    }
    return {
      ...textMessage("assistant", ""),
      content: [assistantToolCall("echo", { value: "ok" })],
    };
  };

  const result = await runAgentLoop({
    prompts: [textMessage("user", "hello")],
    context: {
      systemPrompt: "test",
      messages: [],
      tools: [tool],
      state: {},
    },
    config: { model, toolExecution: "sequential" },
  });

  assert.equal(textOf(result.messages.at(-1)!), "final:ok");
  assert.ok(result.events.some((event) => event.type === "tool_execution_start"));
  assert.ok(result.events.some((event) => event.type === "agent_end"));
});
