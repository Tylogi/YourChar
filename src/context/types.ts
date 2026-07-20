import type { Mode } from "../domain/types.js";
import type { MemoryRealm, MemoryType } from "../rp/types.js";

export type ContextPlannerBudgets = {
  dynamicTokens: number;
  memoryTokens: number;
  realityMemoryTokens: number;
  roleplayMemoryTokens: number;
  sceneTokens: number;
  worldCoreTokens: number;
  worldRuntimeTokens: number;
  interactionTokens: number;
  realityItems: number;
  roleplayItems: number;
  bootstrapItems: number;
};

export type RetrievalScoreBreakdown = {
  relevance: number;
  salience: number;
  recency: number;
  confidence: number;
  exactKey: boolean;
  exactTag: boolean;
  exactContent: boolean;
  fts: number;
  lexical: number;
};

export type MemoryRetrievalCandidate = {
  memoryId: string;
  realm: Exclude<MemoryRealm, "legacy">;
  characterId?: string;
  type: MemoryType;
  key?: string;
  tags: string[];
  content: string;
  updatedAt: string;
  version: string;
  lastUsedAt?: string;
  estimatedTokens: number;
  score: number;
  breakdown: RetrievalScoreBreakdown;
  reason: string;
  selected: boolean;
  exclusionReason?: string;
  bootstrap: boolean;
};

export type MemoryRetrievalPlan = {
  realm: "reality" | "roleplay";
  characterId?: string;
  query: string;
  normalizedQuery: string;
  bootstrapRequested: boolean;
  candidateCount: number;
  selectedMemoryIds: string[];
  candidates: MemoryRetrievalCandidate[];
};

export type ContextSectionManifest = {
  id: "stable_rules" | "profile" | "soul" | "skills" | "capabilities" | "tools" |
    "world_core" | "latest_time" | "interaction" | "relationship" | "world_runtime" | "scene" |
    "reality_memory" | "rp_memory";
  placement: "stable" | "dynamic" | "provider";
  characters: number;
  estimatedTokens: number;
  budgetTokens?: number;
  included: boolean;
  truncated: boolean;
  exclusionReason?: string;
};

export type ContextPlan = {
  schemaVersion: 1;
  sessionId: string;
  mode: Mode;
  characterId?: string;
  generatedAt: string;
  timezone: string;
  query: string;
  queryHash: string;
  bootstrapApplied: boolean;
  bootstrapAlreadyConsumed: boolean;
  budgets: ContextPlannerBudgets;
  sections: ContextSectionManifest[];
  retrieval: MemoryRetrievalPlan[];
  selectedMemoryIds: string[];
  selectedMemoryVersions: Record<string, string>;
  excludedCount: number;
  truncated: boolean;
  runtimeEnvelope: string;
  stableSystemContext: string;
  volatileContext: string;
  memoryContext: string;
  turnContext: string;
  stableEstimatedTokens: number;
  dynamicEstimatedTokens: number;
  memoryEstimatedTokens: number;
};

export type ActualProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

export type ContextEconomics = {
  id: string;
  sessionId: string;
  mode: Mode;
  turnKind: "user" | "reminder_due";
  systemHash: string;
  toolSchemaHash: string;
  messageCount: number;
  estimatedInputTokens: number;
  stableEstimatedTokens: number;
  dynamicEstimatedTokens: number;
  memoryEstimatedTokens: number;
  toolEstimatedTokens: number;
  memoryIds: string[];
  plannerBudgetTokens: number;
  plannerTruncated: boolean;
  lcpMessageCount: number;
  lcpEstimatedTokens: number;
  prefixReuseRatio: number;
  cacheBreakReason: string | null;
  actual: ActualProviderUsage;
  plan: ContextEconomicsPlan;
  messageDigests: Array<{ hash: string; estimatedTokens: number }>;
  createdAt: string;
};

export type ContextEconomicsPlan = Omit<
  ContextPlan,
  "stableSystemContext" | "volatileContext" | "memoryContext" | "turnContext" | "query" | "retrieval"
> & {
  query: null;
  retrieval: Array<Omit<MemoryRetrievalPlan, "query" | "normalizedQuery" | "candidates"> & {
    query: null;
    normalizedQuery: null;
    candidates: Array<Omit<MemoryRetrievalCandidate, "content" | "key" | "tags">>;
  }>;
};

export type MemoryRetrievalStat = {
  memoryId: string;
  hitCount: number;
  lastHitAt?: string;
};
