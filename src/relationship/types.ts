import type { Mode } from "../domain/types.js";

export const relationshipEventTypes = [
  "support",
  "reliability",
  "vulnerability",
  "shared_success",
  "conflict",
  "boundary_violation",
  "repair",
  "affection",
] as const;

export type RelationshipEventType = typeof relationshipEventTypes[number];
export type RelationshipImpact = "minor" | "moderate" | "major";
export type RelationshipStage = "stranger" | "acquaintance" | "familiar" | "close" | "intimate" | "strained";
export type AffectLabel =
  | "calm"
  | "warm"
  | "happy"
  | "excited"
  | "moved"
  | "shy"
  | "worried"
  | "sad"
  | "angry"
  | "hurt"
  | "guarded";

export type RelationshipDimensions = {
  trust: number;
  closeness: number;
  affection: number;
  respect: number;
  tension: number;
};

export type AffectState = {
  valence: number;
  arousal: number;
  control: number;
  labels: AffectLabel[];
  updatedAt: string;
};

export type CharacterRelationshipState = RelationshipDimensions & {
  characterId: string;
  stage: RelationshipStage;
  affect: AffectState;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipDelta = RelationshipDimensions;

export type RelationshipEvent = {
  id: string;
  characterId: string;
  sourceSessionId: string;
  sourceContextLogId: string;
  type: RelationshipEventType;
  impact: RelationshipImpact;
  summary: string;
  confidence: number;
  delta: RelationshipDelta;
  createdAt: string;
};

export type RelationshipExtractionInput = {
  mode: Mode;
  characterId: string;
  sourceSessionId: string;
  sourceContextLogId: string;
  userText: string;
  assistantText: string;
};

export type RelationshipExtraction = {
  significant: boolean;
  eventType?: RelationshipEventType;
  impact?: RelationshipImpact;
  summary?: string;
  confidence: number;
};

export type RelationshipExtractor = (input: RelationshipExtractionInput) => Promise<unknown>;

export type RelationshipJobStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type RelationshipExtractionJob = {
  id: string;
  idempotencyKey: string;
  sourceContextLogId: string;
  sessionId: string;
  characterId: string;
  mode: Mode;
  triggerReason: string;
  status: RelationshipJobStatus;
  attempts: number;
  maxAttempts: number;
  inputTokenEstimate: number;
  durationMs?: number;
  resultCount: number;
  lastError?: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
};

export type RelationshipSnapshot = {
  state: CharacterRelationshipState;
  qualitative: string;
  recentEvents: RelationshipEvent[];
};

export type RelationshipCoordinatorStatus = {
  enabled: boolean;
  pendingCount: number;
  estimatedTokensLast24Hours: number;
  recentJobs: RelationshipExtractionJob[];
};
