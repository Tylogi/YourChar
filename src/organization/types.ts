import type { AgentModuleType } from "../modules/types.js";
import type { ConversationSpace } from "../domain/types.js";

export const characterCapabilityIds = [
  "research.web",
  "research.analysis",
  "software.debug",
  "software.implementation",
  "planning.schedule",
  "organization.coordination",
  "communication.social",
  "creative.writing",
  "creative.visual",
  "world.knowledge",
] as const;

export type CharacterCapabilityId = typeof characterCapabilityIds[number];
export type CharacterCapabilityResponsibility = "primary" | "support";
export type CharacterCapabilitySource = "inferred" | "manual";
export type CharacterFunctionInferenceStatus =
  | "uninitialized"
  | "pending"
  | "ready"
  | "failed";
export type CharacterCapabilityEvidenceOutcome =
  | "completed"
  | "declined"
  | "failed"
  | "cancelled";

export type CharacterCapabilityDefinition = {
  id: CharacterCapabilityId;
  label: string;
  description: string;
  recommendedModuleIds: string[];
};

export type CharacterFunctionProfile = {
  characterId: string;
  publicRole: string;
  taskPreferences: string;
  avoidedTasks: string;
  maxConcurrentTasks: number;
  manualLocked: boolean;
  inferenceStatus: CharacterFunctionInferenceStatus;
  sourceSoulHash: string;
  inferenceError: string;
  inferenceStartedAt?: string;
  inferredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterCapability = {
  characterId: string;
  capabilityId: CharacterCapabilityId;
  level: number;
  responsibility: CharacterCapabilityResponsibility;
  autoAccept: boolean;
  moduleIds: string[];
  notes: string;
  source: CharacterCapabilitySource;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type CharacterCapabilityEvidence = {
  id: string;
  characterId: string;
  capabilityId: CharacterCapabilityId;
  sourceTaskId: string;
  outcome: CharacterCapabilityEvidenceOutcome;
  functionalScore?: number;
  judgeScore?: number;
  summary: string;
  lesson: string;
  createdAt: string;
};

export type CharacterCapabilityEvidenceSummary = {
  capabilityId: CharacterCapabilityId;
  total: number;
  completed: number;
  declined: number;
  failed: number;
  cancelled: number;
  scored: number;
  averageFunctionalScore?: number;
  averageJudgeScore?: number;
  averageQualityScore?: number;
  lastOutcome?: CharacterCapabilityEvidenceOutcome;
  lastCreatedAt?: string;
};

export type CharacterFunctionProfileUpdate = {
  publicRole?: string;
  taskPreferences?: string;
  avoidedTasks?: string;
  maxConcurrentTasks?: number;
  manualLocked?: boolean;
  capabilities: Array<{
    capabilityId: CharacterCapabilityId;
    level: number;
    responsibility: CharacterCapabilityResponsibility;
    autoAccept: boolean;
    moduleIds?: string[];
    notes?: string;
    source?: CharacterCapabilitySource;
    confidence?: number;
  }>;
};

export type CharacterFunctionInferenceInput = {
  characterId: string;
  conversationSpace: ConversationSpace;
  characterName: string;
  soulMarkdown: string;
  catalog: CharacterCapabilityDefinition[];
  signal?: AbortSignal;
};

export type CharacterFunctionInferenceCapability = {
  capabilityId: CharacterCapabilityId;
  level: number;
  responsibility: CharacterCapabilityResponsibility;
  confidence: number;
  rationale: string;
};

export type CharacterFunctionInferenceResult = {
  publicRole: string;
  taskPreferences: string;
  avoidedTasks: string;
  capabilities: CharacterFunctionInferenceCapability[];
  skillMarkdown: string;
};

export type CharacterFunctionInferer = (
  input: CharacterFunctionInferenceInput,
) => Promise<unknown>;

export type CharacterSkillVersionStatus = "active" | "superseded" | "rejected";
export type CharacterSkillVersionSource =
  | "bootstrap"
  | "character_reflection"
  | "manual";

export type CharacterSkillVersion = {
  id: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  version: number;
  status: CharacterSkillVersionStatus;
  markdown: string;
  changeSummary: string;
  source: CharacterSkillVersionSource;
  sourceTaskId?: string;
  contentHash: string;
  createdAt: string;
  activatedAt?: string;
  supersededAt?: string;
};

export type CharacterSkillReflectionInput = {
  characterId: string;
  characterName: string;
  soulMarkdown: string;
  capabilities: CharacterCapability[];
  capabilityDefinitions: CharacterCapabilityDefinition[];
  currentSkill: CharacterSkillVersion;
  taskSummary: string;
  sourceTaskId: string;
  signal?: AbortSignal;
};

export type CharacterSkillReflectionResult = {
  shouldUpdate: boolean;
  markdown: string;
  changeSummary: string;
};

export type CharacterSkillReflector = (
  input: CharacterSkillReflectionInput,
) => Promise<unknown>;

export type CharacterTaskSkill = {
  version: number;
  markdown: string;
};

export type CharacterCapabilityEvolutionStage =
  | "new"
  | "practicing"
  | "improving"
  | "advanced"
  | "needs_review";

export type CharacterCapabilityEvolution = {
  capabilityId: CharacterCapabilityId;
  baseLevel: number;
  effectiveLevel: number;
  learnedAdjustment: number;
  routingAdjustment: number;
  stage: CharacterCapabilityEvolutionStage;
  totalEvidence: number;
  scoredEvidence: number;
  completionRate?: number;
  averageQualityScore?: number;
};

export type CharacterCapabilityModuleStatus = {
  id: string;
  name: string;
  type: AgentModuleType;
  enabled: boolean;
  estimatedTokens: number;
};

export type CharacterFunctionSnapshot = {
  profile: CharacterFunctionProfile;
  capabilities: CharacterCapability[];
  catalog: CharacterCapabilityDefinition[];
  modules: CharacterCapabilityModuleStatus[];
  evidence: CharacterCapabilityEvidenceSummary[];
  evolution: CharacterCapabilityEvolution[];
  activeSkills: CharacterSkillVersion[];
  soulOutdated: boolean;
};

export type PublicCharacterCapability = {
  id: CharacterCapabilityId;
  label: string;
  level: number;
  baseLevel: number;
  responsibility: CharacterCapabilityResponsibility;
  autoAccept: boolean;
  source: CharacterCapabilitySource;
  evolutionStage: CharacterCapabilityEvolutionStage;
};

export type PublicCharacterFunctionSummary = {
  publicRole?: string;
  capabilities: PublicCharacterCapability[];
};

export type CharacterTaskRouteCandidate = {
  characterId: string;
  characterName: string;
  publicRole?: string;
  eligible: boolean;
  score: number;
  activeTasks: number;
  maxConcurrentTasks: number;
  availability: string;
  reasons: string[];
  warnings: string[];
};

export type CharacterTaskRoute = {
  sourceCharacterId: string;
  worldId: string;
  task: string;
  requiredCapabilityIds: CharacterCapabilityId[];
  selectionMode: "automatic" | "explicit";
  selected?: CharacterTaskRouteCandidate;
  candidates: CharacterTaskRouteCandidate[];
};

export type CharacterTaskIdentity = {
  publicRole?: string;
  taskPreferences?: string;
  avoidedTasks?: string;
  capabilities: Array<{
    id: CharacterCapabilityId;
    label: string;
    level: number;
    baseLevel: number;
    responsibility: CharacterCapabilityResponsibility;
    evolutionStage: CharacterCapabilityEvolutionStage;
  }>;
};

export function isCharacterCapabilityId(value: unknown): value is CharacterCapabilityId {
  return typeof value === "string" &&
    characterCapabilityIds.some((capabilityId) => capabilityId === value);
}
