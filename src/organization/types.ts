import type { ConversationSpace } from "../domain/types.js";

export type CharacterCapabilityEvidenceOutcome =
  | "completed"
  | "declined"
  | "failed"
  | "cancelled";

export type CharacterCollaborationProfile = {
  characterId: string;
  introduction: string;
  traits: string[];
  maxConcurrentTasks: number;
  createdAt: string;
  updatedAt: string;
};

export type CharacterCollaborationProfileUpdate = {
  introduction?: string;
  traits?: string[];
  maxConcurrentTasks?: number;
};

export type CharacterSkillReflectionInput = {
  characterId: string;
  characterName: string;
  soulMarkdown: string;
  currentSkill: Pick<CharacterOwnedSkillVersion, "conversationSpace" | "markdown">;
  ownedSkillPackage?: CharacterOwnedSkillPackage;
  taskSummary: string;
  sourceTaskId: string;
  signal?: AbortSignal;
};

export type CharacterSkillReflectionResult = {
  shouldUpdate: boolean;
  markdown: string;
  changeSummary: string;
  name?: string;
  description?: string;
  tags?: string[];
};

export type CharacterSkillReflector = (
  input: CharacterSkillReflectionInput,
) => Promise<unknown>;

export type CharacterOwnedSkillStatus = "draft" | "active" | "disabled";
export type CharacterOwnedSkillCreatedBy = "user" | "character" | "migration";
export type CharacterOwnedSkillVersionStatus = "draft" | "active" | "superseded" | "rejected";
export type CharacterOwnedSkillVersionSource =
  | "manual"
  | "character_created"
  | "character_reflection"
  | "legacy_migration";
export type CharacterOwnedSkillProposalStatus = "pending" | "approved" | "rejected" | "stale";

export type CharacterOwnedSkillVersion = {
  id: string;
  packageId: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  version: number;
  status: CharacterOwnedSkillVersionStatus;
  markdown: string;
  changeSummary: string;
  source: CharacterOwnedSkillVersionSource;
  sourceTaskId?: string;
  contentHash: string;
  createdAt: string;
  activatedAt?: string;
  supersededAt?: string;
};

export type CharacterOwnedSkillPackage = {
  id: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  status: CharacterOwnedSkillStatus;
  autoImprove: boolean;
  createdBy: CharacterOwnedSkillCreatedBy;
  createdAt: string;
  updatedAt: string;
  activeVersion?: CharacterOwnedSkillVersion;
  versionCount: number;
  evaluationCount: number;
  completedCount: number;
  failedCount: number;
  averageScore?: number;
  pendingProposalCount: number;
};

export type CharacterOwnedSkillEvaluation = {
  id: string;
  packageId: string;
  versionId: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  sourceTaskId: string;
  outcome: CharacterCapabilityEvidenceOutcome;
  score?: number;
  resultSummary: string;
  lesson: string;
  createdAt: string;
};

export type CharacterOwnedSkillProposal = {
  id: string;
  packageId: string;
  baseVersionId: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  sourceTaskId: string;
  status: CharacterOwnedSkillProposalStatus;
  proposedMarkdown: string;
  changeSummary: string;
  contentHash: string;
  createdAt: string;
  reviewedAt?: string;
  activatedVersionId?: string;
};

export type CharacterOwnedSkillCreateInput = {
  name: string;
  description?: string;
  tags?: string[];
  markdown: string;
  autoImprove?: boolean;
  activate?: boolean;
  createdBy?: CharacterOwnedSkillCreatedBy;
  sourceTaskId?: string;
};

export type CharacterOwnedSkillUpdateInput = {
  name?: string;
  description?: string;
  tags?: string[];
  autoImprove?: boolean;
  status?: CharacterOwnedSkillStatus;
};

export type PublicCharacterOwnedSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  executionCount: number;
  successRate?: number;
  averageScore?: number;
};

export type CharacterTaskSkill = {
  packages: Array<{
    id: string;
    name: string;
    description: string;
    version: number;
    markdown: string;
  }>;
};

export type PublicCharacterCollaborationSummary = {
  introduction: string;
  traits: string[];
  skills: PublicCharacterOwnedSkill[];
};

export type CharacterTaskRouteCandidate = {
  characterId: string;
  characterName: string;
  introduction?: string;
  traits: string[];
  eligible: boolean;
  score: number;
  activeTasks: number;
  maxConcurrentTasks: number;
  availability: string;
  reasons: string[];
  warnings: string[];
  matchedSkillIds: string[];
};

export type CharacterTaskRoute = {
  sourceCharacterId: string;
  worldId: string;
  task: string;
  requiredSkillIds: string[];
  selectedSkillIds: string[];
  selectionMode: "automatic" | "explicit";
  selected?: CharacterTaskRouteCandidate;
  candidates: CharacterTaskRouteCandidate[];
};

export type CharacterTaskIdentity = {
  introduction: string;
  traits: string[];
};
