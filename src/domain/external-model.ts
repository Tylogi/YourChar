import type { AgentContext, AgentMessage, AgentRole } from "../harness/index.js";
import { textMessage, textOf } from "../harness/index.js";
import { CompanionStore } from "./store.js";
import type { Mode, ModelApiConfig } from "./types.js";

type RawModelApiConfig = ModelApiConfig & { apiKey?: string };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    text?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

export async function tryExternalModelReply(
  context: AgentContext,
  mode: Mode,
  signal?: AbortSignal,
): Promise<AgentMessage | undefined> {
  const config = readModelConfig(context);
  if (!config?.enabled) {
    return undefined;
  }
  if (!config.baseUrl || !config.model) {
    return textMessage("assistant", "模型 API 未配置完整：请填写 Base URL 和模型名。");
  }

  try {
    const reply = await callOpenAiCompatibleChat(config, buildChatMessages(context, mode), signal);
    return textMessage("assistant", reply, {
      modelProvider: config.provider,
      model: config.model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textMessage("assistant", `模型调用失败：${message}`);
  }
}

export function stripReasoningText(text: string): string {
  const withoutThinkTags = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const finalMatch = withoutThinkTags.match(
    /(?:^|\n)(?:final(?: answer| response)?|最终回复|正式回复|回复)[:：]\s*([\s\S]+)$/i,
  );
  return (finalMatch?.[1] ?? withoutThinkTags).trim();
}

function readModelConfig(context: AgentContext): RawModelApiConfig | undefined {
  const store = context.state.store;
  if (store instanceof CompanionStore) {
    return store.getRawModelApiConfig();
  }
  return undefined;
}

function buildChatMessages(context: AgentContext, mode: Mode): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        context.systemPrompt,
        mode === "rp"
          ? "用中文回复。RP 模式采用第三人称生活叙事，像角色与用户共享同一条现实时间线。不要暴露推理过程。"
          : "用中文回复。SMS 模式采用第一人称私信口吻，简短、自然、可执行。不要暴露推理过程。",
      ].join("\n"),
    },
  ];

  for (const message of context.messages.slice(-24)) {
    const role = toChatRole(message.role);
    const text = textOf(message).trim();
    if (!role || !text) {
      continue;
    }
    messages.push({ role, content: text });
  }

  return messages;
}

function toChatRole(role: AgentRole): ChatMessage["role"] | undefined {
  if (role === "system" || role === "user" || role === "assistant") {
    return role;
  }
  return undefined;
}

async function callOpenAiCompatibleChat(
  config: RawModelApiConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };
  if (typeof config.temperature === "number") {
    body.temperature = config.temperature;
  }
  if (typeof config.maxTokens === "number") {
    body.max_tokens = config.maxTokens;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const responseText = await response.text();
  const json = parseJson(responseText);
  if (!response.ok) {
    throw new Error(extractErrorMessage(json, responseText, response.status));
  }

  const content = extractAssistantText(json);
  if (!content) {
    throw new Error("模型返回为空。");
  }
  return content;
}

function parseJson(text: string): ChatCompletionResponse | undefined {
  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    return undefined;
  }
}

function extractAssistantText(json: ChatCompletionResponse | undefined): string {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  return stripReasoningText(content);
}

function extractErrorMessage(
  json: ChatCompletionResponse | undefined,
  responseText: string,
  status: number,
): string {
  const message = json?.error?.message ?? responseText.trim();
  return message ? `HTTP ${status}: ${message.slice(0, 240)}` : `HTTP ${status}`;
}
