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
  "bond_defined",
  "confession",
  "confession_accepted",
  "confession_rejected",
  "relationship_confirmed",
  "commitment",
  "jealousy",
  "shared_secret",
  "breakup",
  "reconciliation",
] as const;

export type RelationshipEventType = typeof relationshipEventTypes[number];
export type RelationshipImpact = "minor" | "moderate" | "major";
export type RelationshipStage = "stranger" | "acquaintance" | "familiar" | "close" | "intimate" | "strained";
export const relationshipBondFacets = [
  "friendship",
  "confidant",
  "companionship",
  "partnership",
  "mentorship",
  "rivalry",
  "familial",
] as const;
export type RelationshipBondFacet = typeof relationshipBondFacets[number];
export const romanceStatuses = [
  "none",
  "user_interest",
  "character_interest",
  "mutual_interest",
  "dating",
  "committed",
  "former_partners",
] as const;
export type RomanceStatus = typeof romanceStatuses[number];
export type RelationshipInitiator = "user" | "character" | "mutual";
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
  bond: number;
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
  bondFacets: RelationshipBondFacet[];
  romanceStatus: RomanceStatus;
  semanticUpdatedAt?: string;
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
  initiator?: RelationshipInitiator;
  bondFacet?: RelationshipBondFacet;
  evidence?: RelationshipEvidence;
  semanticChange?: RelationshipSemanticChange;
  createdAt: string;
};

export type RelationshipEvidence = {
  user?: string;
  assistant?: string;
};

export type RelationshipSemanticChange = {
  addedBondFacets: RelationshipBondFacet[];
  romanceFrom?: RomanceStatus;
  romanceTo?: RomanceStatus;
};

export type RelationshipReviewTurn = {
  sourceContextLogId: string;
  userText: string;
  assistantText: string;
};

export type RelationshipExtractionInput = {
  mode: Mode;
  characterId: string;
  sourceSessionId: string;
  sourceContextLogId: string;
  userText: string;
  assistantText: string;
  reviewKind?: "single_turn" | "periodic";
  reviewTurns?: RelationshipReviewTurn[];
  currentRelationship?: {
    stage: RelationshipStage;
    bondFacets: RelationshipBondFacet[];
    romanceStatus: RomanceStatus;
  };
};

export type RelationshipExtraction = {
  significant: boolean;
  eventType?: RelationshipEventType;
  impact?: RelationshipImpact;
  summary?: string;
  confidence: number;
  initiator?: RelationshipInitiator;
  bondFacet?: RelationshipBondFacet;
  evidence?: RelationshipEvidence;
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
  analysisKinds: Array<"relationship" | "interaction" | "world_attributes">;
  interactionPresence?: "co_present";
  interactionRevision?: number;
  status: RelationshipJobStatus;
  attempts: number;
  maxAttempts: number;
  inputTokenEstimate: number;
  durationMs?: number;
  resultCount: number;
  relationshipResultCount: number;
  interactionResultCount: number;
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
  relationshipEnabled: boolean;
  interactionFallbackEnabled: boolean;
  worldAttributeAnalysisEnabled: boolean;
  pendingCount: number;
  estimatedTokensLast24Hours: number;
  recentJobs: RelationshipExtractionJob[];
};
