import {
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  textMessage,
  toolCallsOf,
  toolResultMessage,
  type ToolCallBlock,
} from "./types.js";

export type AgentLoopResult = {
  messages: AgentMessage[];
  events: AgentEvent[];
};

export async function runAgentLoop(input: {
  prompts: AgentMessage[];
  context: AgentContext;
  config: AgentLoopConfig;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentLoopResult> {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const maxTurns = input.config.maxTurns ?? 8;
  const events: AgentEvent[] = [];
  const newMessages: AgentMessage[] = [...input.prompts];
  const context: AgentContext = {
    ...input.context,
    messages: [...input.context.messages, ...input.prompts],
  };

  const emit = async (event: AgentEvent) => {
    events.push(event);
    await input.emit?.(event);
  };

  await emit({ type: "agent_start", runId });
  for (const prompt of input.prompts) {
    await emit({ type: "message_start", runId, message: prompt });
    await emit({ type: "message_end", runId, message: prompt });
  }

  let pendingMessages = (await input.config.getSteeringMessages?.()) ?? [];
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    await emit({ type: "turn_start", runId, turn });

    for (const message of pendingMessages) {
      context.messages.push(message);
      newMessages.push(message);
      await emit({ type: "message_start", runId, message });
      await emit({ type: "message_end", runId, message });
    }
    pendingMessages = [];

    const assistantMessage = await input.config.model(context, input.signal);
    context.messages.push(assistantMessage);
    newMessages.push(assistantMessage);
    await emit({ type: "message_start", runId, message: assistantMessage });
    await emit({ type: "message_end", runId, message: assistantMessage });

    const toolCalls = toolCallsOf(assistantMessage);
    const toolResults =
      toolCalls.length === 0
        ? []
        : await executeToolCalls({
            runId,
            context,
            assistantMessage,
            toolCalls,
            config: input.config,
            signal: input.signal,
            emit,
          });

    for (const resultMessage of toolResults) {
      context.messages.push(resultMessage);
      newMessages.push(resultMessage);
    }

    await emit({
      type: "turn_end",
      runId,
      turn,
      message: assistantMessage,
      toolResults,
    });

    if (
      await input.config.shouldStopAfterTurn?.({
        context,
        message: assistantMessage,
        toolResults,
        newMessages,
      })
    ) {
      await emit({ type: "agent_end", runId, messages: newMessages });
      return { messages: newMessages, events };
    }

    if (toolResults.length > 0) {
      continue;
    }

    const followUps = (await input.config.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }

    await emit({ type: "agent_end", runId, messages: newMessages });
    return { messages: newMessages, events };
  }

  const errorMessage = textMessage("assistant", `Agent exceeded maxTurns=${maxTurns}.`);
  newMessages.push(errorMessage);
  await emit({ type: "error", runId, message: `maxTurns exceeded: ${maxTurns}` });
  await emit({ type: "agent_end", runId, messages: newMessages });
  return { messages: newMessages, events };
}

async function executeToolCalls(input: {
  runId: string;
  context: AgentContext;
  assistantMessage: AgentMessage;
  toolCalls: ToolCallBlock[];
  config: AgentLoopConfig;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => Promise<void>;
}): Promise<AgentMessage[]> {
  const hasSequentialTool = input.toolCalls.some(
    (call) => findTool(input.context.tools, call.name)?.executionMode === "sequential",
  );
  const mode = input.config.toolExecution ?? (hasSequentialTool ? "sequential" : "parallel");
  if (mode === "parallel" && !hasSequentialTool) {
    const results = await Promise.all(input.toolCalls.map((call) => executeOneToolCall(input, call)));
    return results.map(({ call, result }) => toolResultMessage(call, result));
  }

  const resultMessages: AgentMessage[] = [];
  for (const call of input.toolCalls) {
    const { result } = await executeOneToolCall(input, call);
    resultMessages.push(toolResultMessage(call, result));
  }
  return resultMessages;
}

async function executeOneToolCall(
  input: {
    runId: string;
    context: AgentContext;
    assistantMessage: AgentMessage;
    config: AgentLoopConfig;
    signal?: AbortSignal;
    emit: (event: AgentEvent) => Promise<void>;
  },
  toolCall: ToolCallBlock,
): Promise<{ call: ToolCallBlock; result: AgentToolResult }> {
  await input.emit({ type: "tool_execution_start", runId: input.runId, toolCall });

  const tool = findTool(input.context.tools, toolCall.name);
  if (!tool) {
    const result: AgentToolResult = {
      content: `Tool not found: ${toolCall.name}`,
      isError: true,
    };
    await input.emit({ type: "tool_execution_end", runId: input.runId, toolCall, result });
    return { call: toolCall, result };
  }

  const before = await input.config.beforeToolCall?.(
    { context: input.context, assistantMessage: input.assistantMessage, toolCall, tool },
    input.signal,
  );
  if (before?.block) {
    const result: AgentToolResult = {
      content: before.reason ?? `Tool blocked: ${toolCall.name}`,
      isError: true,
    };
    await input.emit({ type: "tool_execution_end", runId: input.runId, toolCall, result });
    return { call: toolCall, result };
  }

  try {
    const parsed = tool.validate ? tool.validate(toolCall.input) : toolCall.input;
    const executed = await tool.execute(parsed, {
      runId: input.runId,
      state: input.context.state,
    });
    const override = await input.config.afterToolCall?.(
      {
        context: input.context,
        assistantMessage: input.assistantMessage,
        toolCall,
        tool,
        result: executed,
      },
      input.signal,
    );
    const result = override ?? executed;
    await input.emit({ type: "tool_execution_end", runId: input.runId, toolCall, result });
    return { call: toolCall, result };
  } catch (error) {
    const result: AgentToolResult = {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
    await input.emit({ type: "tool_execution_end", runId: input.runId, toolCall, result });
    return { call: toolCall, result };
  }
}

function findTool(tools: AgentTool<any, any>[], name: string): AgentTool<any, any> | undefined {
  return tools.find((tool) => tool.name === name);
}
