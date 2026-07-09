import { randomUUID } from "node:crypto";

export type AgentRole = "system" | "user" | "assistant" | "tool" | "event";

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "toolResult";
  toolCallId: string;
  name: string;
  content: unknown;
  isError?: boolean;
};

export type AgentContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: AgentContentBlock[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type AgentEvent =
  | { type: "agent_start"; runId: string }
  | { type: "agent_end"; runId: string; messages: AgentMessage[] }
  | { type: "turn_start"; runId: string; turn: number }
  | { type: "turn_end"; runId: string; turn: number; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "message_start"; runId: string; message: AgentMessage }
  | { type: "message_end"; runId: string; message: AgentMessage }
  | { type: "tool_execution_start"; runId: string; toolCall: ToolCallBlock }
  | { type: "tool_execution_end"; runId: string; toolCall: ToolCallBlock; result: AgentToolResult }
  | { type: "error"; runId: string; message: string };

export type ToolExecutionMode = "sequential" | "parallel";

export type AgentToolResult<T = unknown> = {
  content: T;
  isError?: boolean;
  terminate?: boolean;
  metadata?: Record<string, unknown>;
};

export type ToolExecutionContext = {
  runId: string;
  state: Record<string, unknown>;
};

export type AgentTool<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  executionMode?: ToolExecutionMode;
  validate?: (input: Record<string, unknown>) => TInput;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<AgentToolResult<TOutput>>;
};

export type AgentContext = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool<any, any>[];
  state: Record<string, unknown>;
};

export type AgentModel = (context: AgentContext, signal?: AbortSignal) => Promise<AgentMessage>;

export type BeforeToolCall = (
  input: {
    context: AgentContext;
    assistantMessage: AgentMessage;
    toolCall: ToolCallBlock;
    tool: AgentTool;
  },
  signal?: AbortSignal,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

export type AfterToolCall = (
  input: {
    context: AgentContext;
    assistantMessage: AgentMessage;
    toolCall: ToolCallBlock;
    tool: AgentTool;
    result: AgentToolResult;
  },
  signal?: AbortSignal,
) => Promise<AgentToolResult | undefined>;

export type AgentLoopConfig = {
  model: AgentModel;
  maxTurns?: number;
  toolExecution?: ToolExecutionMode;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  shouldStopAfterTurn?: (input: {
    context: AgentContext;
    message: AgentMessage;
    toolResults: AgentMessage[];
    newMessages: AgentMessage[];
  }) => Promise<boolean> | boolean;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
};

export function textMessage(role: AgentRole, text: string, metadata?: Record<string, unknown>): AgentMessage {
  return {
    id: createId(),
    role,
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
    metadata,
  };
}

export function assistantToolCall(name: string, input: Record<string, unknown>): ToolCallBlock {
  return {
    type: "toolCall",
    id: createId(),
    name,
    input,
  };
}

export function toolResultMessage(toolCall: ToolCallBlock, result: AgentToolResult): AgentMessage {
  return {
    id: createId(),
    role: "tool",
    content: [
      {
        type: "toolResult",
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: result.content,
        isError: result.isError,
      },
    ],
    createdAt: new Date().toISOString(),
    metadata: result.metadata,
  };
}

export function textOf(message: AgentMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function toolCallsOf(message: AgentMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
}

export function toolResultsOf(message: AgentMessage): ToolResultBlock[] {
  return message.content.filter((block): block is ToolResultBlock => block.type === "toolResult");
}

function createId(): string {
  return randomUUID();
}
