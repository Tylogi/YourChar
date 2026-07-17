import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type Mode = "sms" | "rp";
export type TurnStatus = "completed" | "failed" | "cancelled" | "blocked";
export type SystemEventType =
  | "model_unavailable"
  | "module_disabled"
  | "operation_completed"
  | "operation_blocked"
  | "operation_failed"
  | "input_required"
  | "cancelled";

export type MessageRequest = {
  mode?: Mode;
  text: string;
  timezone?: string;
  characterId?: string;
  attachments?: MessageAttachment[];
};

export type MessageAttachment = {
  path: string;
  name?: string;
  contentType?: string;
  size?: number;
};

export type ActionRecord = {
  id: string;
  actionType: string;
  status: "completed" | "failed" | "blocked";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type MessageResponse = {
  reply: string;
  actions: ActionRecord[];
  events: AgentSessionEvent[];
  status: TurnStatus;
  messageType: "assistant" | "system";
  eventType?: SystemEventType;
  canRetry: boolean;
  nativeModelSuccess?: boolean;
  recoveryUsed?: boolean;
  recoveryReason?: "output_guard_exhausted";
};

export type ModelApiConfig = {
  enabled: boolean;
  provider: "openai_compatible";
  baseUrl: string;
  model: string;
  visionInputEnabled: boolean;
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
  visionInputEnabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  temperature?: number | null;
  maxTokens?: number | null;
};

export type ModelApiProfile = ModelApiConfig & {
  id: string;
  name: string;
  isDefault: boolean;
};

export type ModelApiProfilePatch = ModelApiConfigPatch & {
  name?: string;
};

export type ModelApiProfileCollection = {
  defaultProfileId: string;
  profiles: ModelApiProfile[];
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
  status: TurnStatus;
  canRetry: boolean;
  actions: ActionRecord[];
  events: AgentSessionEvent[];
  createdAt: string;
};

export type ModelContextTrace = {
  id: string;
  sessionId: string;
  mode: Mode;
  turnKind: "user" | "reminder_due" | "group_gate" | "group_reply" | "subagent" | "relationship_extraction";
  requestText: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
};
