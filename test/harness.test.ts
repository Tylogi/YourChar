import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

test("Pi Agent executes a tool call and continues to final text", async () => {
  const echoParameters = Type.Object({ value: Type.String() });
  const tool: AgentTool<typeof echoParameters, string> = {
    name: "echo",
    label: "Echo",
    description: "Echo a value",
    parameters: echoParameters,
    async execute(_toolCallId, input) {
      return {
        content: [{ type: "text", text: input.value }],
        details: input.value,
      };
    },
  };

  let callCount = 0;
  const agent = new Agent({
    initialState: {
      tools: [tool],
    },
    toolExecution: "sequential",
    streamFn: (_model, context) => {
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (callCount === 1) {
          stream.push({
            type: "done",
            reason: "toolUse",
            message: fauxAssistantMessage(fauxToolCall("echo", { value: "ok" }), { stopReason: "toolUse" }),
          });
        } else {
          const toolResult = lastToolResultText(context.messages);
          stream.push({
            type: "done",
            reason: "stop",
            message: fauxAssistantMessage(`final:${toolResult}`),
          });
        }
        stream.end();
      });
      return stream;
    },
  });

  const eventTypes: string[] = [];
  agent.subscribe((event) => {
    eventTypes.push(event.type);
  });

  await agent.prompt("hello");

  const last = agent.state.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.role === "assistant" ? last.content[0]?.type : undefined, "text");
  assert.equal(last?.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "", "final:ok");
  assert.ok(eventTypes.includes("tool_execution_start"));
  assert.ok(eventTypes.includes("agent_end"));
});

function lastToolResultText(messages: Array<{ role: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || !Array.isArray(message.content)) {
      continue;
    }
    const first = message.content[0];
    if (first && typeof first === "object" && "type" in first && first.type === "text" && "text" in first) {
      return typeof first.text === "string" ? first.text : "";
    }
  }
  return "";
}
