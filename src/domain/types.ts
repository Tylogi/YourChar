import type { AgentEvent, AgentMessage } from "../harness/index.js";

export type Mode = "sms" | "rp";

export type MessageRequest = {
  mode?: Mode;
  text: string;
  now?: string;
  timezone?: string;
  characterId?: string;
};

export type ActionRecord = {
  id: string;
  actionType: string;
  status: "completed" | "failed" | "blocked";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Reminder = {
  id: string;
  title: string;
  remindAt: string;
  timezone: string;
  status: "scheduled" | "due" | "cancelled";
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Memory = {
  id: string;
  mode: Mode;
  sessionId: string;
  characterId?: string;
  content: string;
  tags: string[];
  createdAt: string;
};

export type MessageResponse = {
  reply: string;
  actions: ActionRecord[];
  events: AgentEvent[];
};

export type ModelApiConfig = {
  enabled: boolean;
  provider: "openai_compatible";
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  temperature?: number;
  maxTokens?: number;
  updatedAt?: string;
};

export type ModelApiConfigPatch = {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  temperature?: number | null;
  maxTokens?: number | null;
};

export type ContextLogEntry = {
  id: string;
  sessionId: string;
  mode: Mode;
  requestText: string;
  systemPrompt: string;
  messageCountBefore: number;
  toolNames: string[];
  reply: string;
  actions: ActionRecord[];
  events: AgentEvent[];
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
};
