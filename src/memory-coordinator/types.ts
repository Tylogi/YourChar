import type { ConversationSpace, Mode } from "../domain/types.js";
import type {
  MemoryRealm,
  MemoryType,
  RealityMemoryType,
  RoleplayMemoryType,
  RpMemory,
} from "../rp/types.js";

export type MemoryTargetRealm = Exclude<MemoryRealm, "legacy">;

export type MemoryCandidateInput = {
  conversationSpace?: ConversationSpace;
  secretOwnerCharacterId?: string;
  realm: MemoryTargetRealm;
  type: RealityMemoryType | RoleplayMemoryType;
  key?: string;
  content: string;
  characterId?: string;
  sourceSessionId: string;
  sourceMessageId: string;
  salience?: number;
  confidence?: number;
  tags?: string[];
  idempotencyKey: string;
};

export type MemoryControlPlaneEdit = Partial<
  Pick<RpMemory, "type" | "key" | "content" | "salience" | "confidence" | "tags">
>;

export type MemoryConfirmationResult = {
  memory: RpMemory;
  superseded?: RpMemory;
  diff?: { previous: string; next: string };
};

export type MemoryExtractionJobStatus = "pending" | "running" | "completed" | "skipped" | "failed";
export type MemoryExtractionTrigger = "explicit" | "durable_signal" | "none";

export type MemoryExtractionJob = {
  id: string;
  idempotencyKey: string;
  sourceContextLogId: string;
  sessionId: string;
  sourceMessageId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  secretOwnerCharacterId?: string;
  realm: MemoryTargetRealm;
  characterId?: string;
  triggerKind: MemoryExtractionTrigger;
  triggerReason: string;
  status: MemoryExtractionJobStatus;
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

export type MemoryExtractionInput = {
  mode: Mode;
  conversationSpace?: ConversationSpace;
  secretOwnerCharacterId?: string;
  realm: MemoryTargetRealm;
  characterId?: string;
  sourceSessionId: string;
  sourceMessageId: string;
  userText: string;
  assistantText: string;
};

export type ExtractedMemoryCandidate = {
  type: MemoryType;
  key?: string;
  content: string;
  salience?: number;
  confidence?: number;
  tags?: string[];
  evidence?: { user: string };
  person?: {
    name: string;
    aliases?: string[];
    relationship?: string;
  };
};

export type MemoryExtractor = (input: MemoryExtractionInput) => Promise<unknown>;

export type TrustedRealityMemoryObservation = {
  sourceSessionId: string;
  sourceMessageId: string;
  candidateIndex: number;
  claimKey: string;
  claimType: RealityMemoryType;
  exactQuote: string;
  confidence: number;
  salience?: number;
  tags?: string[];
};

export type TrustedRealityMemoryObserver = (input: TrustedRealityMemoryObservation) => void;

export type MemoryCoordinatorStatus = {
  enabled: boolean;
  pendingCount: number;
  pendingCandidateCount: number;
  estimatedTokensLast24Hours: number;
  recentJobs: MemoryExtractionJob[];
};
