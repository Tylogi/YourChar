import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelReasoningEffort } from "../model/reasoning-effort.js";

export type { ModelReasoningEffort } from "../model/reasoning-effort.js";

export type Mode = "sms" | "rp";
export type ConversationSpace = "normal" | "secret";
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
  conversationSpace?: ConversationSpace;
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
  previewKind?: "text" | "html" | "image" | "pdf" | "unsupported";
};

export type ActionRecord = {
  id: string;
  actionType: string;
  status: "completed" | "failed" | "blocked";
  conversationSpace: ConversationSpace;
  secretOwnerCharacterId?: string;
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
  attachments?: MessageAttachment[];
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
  contextWindowTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
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
  contextWindowTokens?: number | null;
  reasoningEffort?: ModelReasoningEffort | null;
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
  conversationSpace: ConversationSpace;
  secretOwnerCharacterId?: string;
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

export type ModelContextTraceTurnKind =
  | "user"
  | "reminder_due"
  | "group_gate"
  | "group_reply"
  | "subagent"
  | "memory_extraction"
  | "relationship_extraction"
  | "post_turn_analysis"
  | "world_planning"
  | "proactive_message"
  | "world_director"
  | "world_actor"
  | "world_analysis"
  | "character_function_inference"
  | "character_skill_reflection";

export type ModelContextTraceScope = "conversation" | "background";

const conversationModelContextTraceTurnKinds = new Set<ModelContextTraceTurnKind>([
  "user",
  "group_gate",
  "group_reply",
  "subagent",
  "world_director",
]);

export function modelContextTraceScope(
  turnKind: ModelContextTraceTurnKind,
): ModelContextTraceScope {
  return conversationModelContextTraceTurnKinds.has(turnKind)
    ? "conversation"
    : "background";
}

export type ModelContextTrace = {
  id: string;
  sessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  secretOwnerCharacterId?: string;
  turnKind: ModelContextTraceTurnKind;
  scope: ModelContextTraceScope;
  requestText: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TraceArchiveConfig = {
  enabled: boolean;
  available: boolean;
  updatedAt?: string;
};

export type TraceArchiveStatus = TraceArchiveConfig & {
  format: "jsonl";
  directory?: string;
  currentFile?: string;
  files: number;
  totalBytes: number;
  lastError?: string;
};

export type SessionRecord = {
  id: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
};
