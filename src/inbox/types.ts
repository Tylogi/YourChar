import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { MessageAttachment, MessageResponse, Mode } from "../domain/types.js";

export type PrivateInboxMessageStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export type PrivateInboxMessage = {
  id: string;
  clientMessageId: string;
  sessionId: string;
  characterId: string;
  mode: Mode;
  text: string;
  timezone: string;
  attachments: MessageAttachment[];
  status: PrivateInboxMessageStatus;
  burstId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type PrivateMessageBurst = {
  id: string;
  sessionId: string;
  characterId: string;
  mode: Mode;
  messages: PrivateInboxMessage[];
};

export type PrivateInboxEvent =
  | { type: "message_queued"; message: PrivateInboxMessage }
  | { type: "message_updated"; message: PrivateInboxMessage }
  | { type: "message_retracted"; messageId: string; clientMessageId: string }
  | { type: "burst_started"; burst: PrivateMessageBurst }
  | { type: "agent_event"; burstId: string; event: AgentSessionEvent }
  | { type: "burst_done"; burstId: string; messageIds: string[]; response: MessageResponse }
  | { type: "burst_failed"; burstId: string; messageIds: string[]; error: string };

export type PrivateInboxSnapshot = {
  messages: PrivateInboxMessage[];
  running: boolean;
};
