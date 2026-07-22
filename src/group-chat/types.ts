import type { Mode } from "../domain/types.js";

export type GroupChatStatus = "active" | "archived";
export type GroupTurnStatus = "running" | "completed" | "partial" | "failed" | "cancelled";
export type GroupDecisionOutcome = "speak" | "silent" | "failed";

export type GroupChat = {
  id: string;
  title: string;
  mode: Mode;
  status: GroupChatStatus;
  maxSpeakers: number;
  characterIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateGroupChatInput = {
  title?: string;
  mode?: Mode;
  characterIds: string[];
  maxSpeakers?: number;
};

export type GroupChatMessage = {
  id: string;
  groupId: string;
  turnId: string;
  sequence: number;
  senderType: "user" | "character" | "system";
  senderId?: string;
  content: string;
  createdAt: string;
};

export type GroupChatDecision = {
  id: string;
  turnId: string;
  characterId: string;
  outcome: GroupDecisionOutcome;
  reasonCode: string;
  modelProfileId?: string;
  model?: string;
  createdAt: string;
};

export type GroupChatTurn = {
  id: string;
  groupId: string;
  status: GroupTurnStatus;
  modelCalls: number;
  speakerCount: number;
  messageCount: number;
  startedAt: string;
  completedAt?: string;
};

export type GroupTurnEvent =
  | { type: "participant_state"; characterId: string; phase: "evaluating" | "silent" | "typing" | "failed"; reasonCode?: string }
  | { type: "message"; message: GroupChatMessage }
  | { type: "turn_done"; turn: GroupChatTurn };

export type GroupTurnResult = {
  turn: GroupChatTurn;
  userMessage: GroupChatMessage;
  messages: GroupChatMessage[];
  decisions: GroupChatDecision[];
};
