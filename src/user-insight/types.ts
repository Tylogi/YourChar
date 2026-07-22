import type { RealityMemoryType } from "../rp/types.js";

export type UserInsightSourceType = "schedule" | "reminder" | "conversation";
export type UserInsightObservationKind =
  | "one_off_schedule"
  | "recurring_schedule"
  | "completed_schedule"
  | "reminder_snooze"
  | "conversation_statement";
export type UserInsightSensitivity = "low" | "sensitive";
export type UserInsightDecision =
  | "context_only"
  | "accumulating"
  | "promoted"
  | "blocked_sensitive"
  | "write_disabled"
  | "conflicted"
  | "user_blocked"
  | "retracted";

export type UserInsightObservation = {
  id: string;
  sourceType: UserInsightSourceType;
  sourceId: string;
  sourceSessionId?: string;
  kind: UserInsightObservationKind;
  claimKey: string;
  claimType: RealityMemoryType;
  claimText: string;
  evidence: Record<string, unknown>;
  confidence: number;
  sensitivity: UserInsightSensitivity;
  decision: UserInsightDecision;
  memoryId?: string;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type UserInsightObservationInput = Omit<UserInsightObservation, "id" | "createdAt" | "updatedAt">;

export type ConversationUserInsightInput = {
  sourceSessionId: string;
  sourceMessageId: string;
  candidateIndex: number;
  claimKey: string;
  claimType: RealityMemoryType;
  exactQuote: string;
  confidence: number;
  salience?: number;
  tags?: string[];
  observedAt?: string;
};

export type UserInsightStatus = {
  enabled: boolean;
  observationCount: number;
  promotedCount: number;
  pendingCount: number;
  blockedCount: number;
  conflictCount: number;
  userBlockedCount: number;
  recentObservations: UserInsightObservation[];
};
