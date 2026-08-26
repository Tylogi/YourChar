import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace } from "../domain/types.js";
import type { RpService } from "../rp/service.js";
import type { WorldConversationService } from "../world/conversation-service.js";
import type { WorldService } from "../world/service.js";
import {
  characterSkillContentHash,
  parseCharacterSkillReflection,
  validateCharacterSkillMarkdown,
} from "./inference.js";
import type { CharacterCapabilityRepository } from "./repository.js";
import {
  type CharacterCapabilityEvidenceOutcome,
  type CharacterCollaborationProfile,
  type CharacterCollaborationProfileUpdate,
  type CharacterOwnedSkillCreateInput,
  type CharacterOwnedSkillEvaluation,
  type CharacterOwnedSkillPackage,
  type CharacterOwnedSkillProposal,
  type CharacterOwnedSkillUpdateInput,
  type CharacterOwnedSkillVersion,
  type CharacterSkillReflector,
  type CharacterTaskIdentity,
  type CharacterTaskRoute,
  type CharacterTaskRouteCandidate,
  type CharacterTaskSkill,
  type PublicCharacterCollaborationSummary,
} from "./types.js";

const COLLABORATION_INTRODUCTION_LIMIT = 600;
const COLLABORATION_TRAIT_LIMIT = 32;
const COLLABORATION_TRAITS_MAX = 12;
const TASK_LIMIT = 2_000;
const EVIDENCE_SUMMARY_LIMIT = 1_000;
const OWNED_SKILL_NAME_LIMIT = 80;
const OWNED_SKILL_DESCRIPTION_LIMIT = 600;
const OWNED_SKILL_TAG_LIMIT = 32;
const OWNED_SKILL_TAGS_MAX = 12;
const OWNED_SKILL_SELECTED_MAX = 3;
const OWNED_SKILLS_PER_CHARACTER_MAX = 12;

type OrganizationActionStatus = "completed" | "failed" | "blocked";

export type CharacterCapabilityServiceOptions = {
  modelAvailable: (characterId: string) => boolean;
  skillReflector?: CharacterSkillReflector;
  ownedSkillCreator?: CharacterSkillReflector;
  onAction?: (
    actionType: string,
    status: OrganizationActionStatus,
    details: Record<string, unknown>,
  ) => void;
};

export class CharacterCapabilityValidationError extends Error {
  readonly code = "CHARACTER_CAPABILITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CharacterCapabilityValidationError";
  }
}

export class CharacterTaskRoutingError extends Error {
  readonly code = "CHARACTER_TASK_ROUTE_UNAVAILABLE";

  constructor(message: string, readonly route?: CharacterTaskRoute) {
    super(message);
    this.name = "CharacterTaskRoutingError";
  }
}

export class CharacterCapabilityService {
  private readonly ownedSkillJobs = new Map<string, Promise<CharacterOwnedSkillProposal | CharacterOwnedSkillPackage | undefined>>();
  private readonly controllers = new Set<AbortController>();
  private skillTail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    readonly repository: CharacterCapabilityRepository,
    private readonly rpService: RpService,
    private readonly worldService: WorldService,
    private readonly worldConversationService: WorldConversationService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly options: CharacterCapabilityServiceOptions,
  ) {}

  start(): void {
    for (const character of this.rpService.listCharacters()) {
      this.ensureCollaborationProfile(character.id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }

  cancelPending(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async waitForIdle(): Promise<void> {
    while (this.ownedSkillJobs.size) {
      await Promise.allSettled(this.ownedSkillJobs.values());
    }
  }

  ensureCollaborationProfile(characterId: string): CharacterCollaborationProfile {
    const character = this.rpService.getCharacter(characterId);
    const existing = this.repository.getCollaborationProfile(characterId);
    if (existing) return existing;
    const now = this.clock.now().toISOString();
    return this.repository.upsertCollaborationProfile({
      characterId,
      introduction: "",
      traits: [],
      maxConcurrentTasks: 1,
      createdAt: character.createdAt || now,
      updatedAt: now,
    });
  }

  updateCollaborationProfile(
    characterId: string,
    input: CharacterCollaborationProfileUpdate,
  ): CharacterCollaborationProfile {
    const current = this.ensureCollaborationProfile(characterId);
    const updated = this.repository.upsertCollaborationProfile({
      ...current,
      introduction: input.introduction === undefined
        ? current.introduction
        : boundedText(input.introduction, COLLABORATION_INTRODUCTION_LIMIT),
      traits: input.traits === undefined
        ? current.traits
        : collaborationTraits(input.traits),
      maxConcurrentTasks: input.maxConcurrentTasks === undefined
        ? current.maxConcurrentTasks
        : boundedInteger(input.maxConcurrentTasks, 1, 5, "maxConcurrentTasks"),
      updatedAt: this.clock.now().toISOString(),
    });
    this.options.onAction?.("character_collaboration_profile_updated", "completed", {
      characterId,
      maxConcurrentTasks: updated.maxConcurrentTasks,
    });
    return updated;
  }

  listOwnedSkills(
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillPackage[] {
    this.rpService.getCharacter(characterId);
    return this.repository.listOwnedSkills(characterId, conversationSpace);
  }

  getOwnedSkill(
    characterId: string,
    packageId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillPackage {
    const skill = this.listOwnedSkills(characterId, conversationSpace)
      .find((entry) => entry.id === packageId);
    if (!skill) {
      throw new CharacterCapabilityValidationError("character-owned Skill was not found in this space");
    }
    return skill;
  }

  createOwnedSkill(
    characterId: string,
    input: CharacterOwnedSkillCreateInput,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillPackage {
    this.rpService.getCharacter(characterId);
    const sourceTaskId = input.sourceTaskId
      ? requiredText(input.sourceTaskId, 300, "sourceTaskId")
      : undefined;
    if (sourceTaskId) {
      const existing = this.repository.findOwnedSkillBySourceTask(
        characterId,
        conversationSpace,
        sourceTaskId,
      );
      if (existing) return existing;
    }
    if (this.repository.listOwnedSkills(characterId, conversationSpace).length >= OWNED_SKILLS_PER_CHARACTER_MAX) {
      throw new CharacterCapabilityValidationError(
        `a character can own at most ${OWNED_SKILLS_PER_CHARACTER_MAX} Skills in one space`,
      );
    }
    const name = requiredText(input.name, OWNED_SKILL_NAME_LIMIT, "Skill name");
    const markdown = validateCharacterSkillMarkdown(input.markdown);
    const now = this.clock.now().toISOString();
    const slug = this.availableOwnedSkillSlug(characterId, conversationSpace, name);
    const activate = input.activate !== false;
    const createdBy = input.createdBy ?? "user";
    if (!(["user", "character", "migration"] as const).includes(createdBy)) {
      throw new CharacterCapabilityValidationError("invalid character-owned Skill creator");
    }
    const skill: CharacterOwnedSkillPackage = {
      id: this.idGenerator.next("character-owned-skill"),
      characterId,
      conversationSpace,
      slug,
      name,
      description: boundedText(input.description, OWNED_SKILL_DESCRIPTION_LIMIT),
      tags: ownedSkillTags(input.tags),
      status: activate ? "active" : "draft",
      autoImprove: input.autoImprove !== false,
      createdBy,
      createdAt: now,
      updatedAt: now,
      versionCount: 1,
      evaluationCount: 0,
      completedCount: 0,
      failedCount: 0,
      pendingProposalCount: 0,
    };
    const version: CharacterOwnedSkillVersion = {
      id: this.idGenerator.next("character-owned-skill-version"),
      packageId: skill.id,
      characterId,
      conversationSpace,
      version: 1,
      status: activate ? "active" : "draft",
      markdown,
      changeSummary: createdBy === "character" ? "角色根据任务经验创建了新 Skill 草稿" : "创建专属 Skill",
      source: createdBy === "character"
        ? "character_created"
        : createdBy === "migration"
          ? "legacy_migration"
          : "manual",
      ...(sourceTaskId ? { sourceTaskId } : {}),
      contentHash: characterSkillContentHash(markdown),
      createdAt: now,
      ...(activate ? { activatedAt: now } : {}),
    };
    this.repository.transaction(() => {
      this.repository.insertOwnedSkillPackage(skill);
      this.repository.insertOwnedSkillVersion(version);
    });
    this.options.onAction?.("character_owned_skill_created", "completed", {
      characterId,
      conversationSpace,
      packageId: skill.id,
      activated: activate,
      createdBy,
    });
    return this.getOwnedSkill(characterId, skill.id, conversationSpace);
  }

  updateOwnedSkill(
    characterId: string,
    packageId: string,
    input: CharacterOwnedSkillUpdateInput,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillPackage {
    const current = this.getOwnedSkill(characterId, packageId, conversationSpace);
    const status = input.status ?? current.status;
    if (!(["draft", "active", "disabled"] as const).includes(status)) {
      throw new CharacterCapabilityValidationError("invalid character-owned Skill status");
    }
    if (status === "active" && !current.activeVersion) {
      throw new CharacterCapabilityValidationError("a Skill needs an active version before it can be enabled");
    }
    const updated: CharacterOwnedSkillPackage = {
      ...current,
      name: input.name === undefined
        ? current.name
        : requiredText(input.name, OWNED_SKILL_NAME_LIMIT, "Skill name"),
      description: input.description === undefined
        ? current.description
        : boundedText(input.description, OWNED_SKILL_DESCRIPTION_LIMIT),
      tags: input.tags === undefined ? current.tags : ownedSkillTags(input.tags),
      autoImprove: input.autoImprove ?? current.autoImprove,
      status,
      updatedAt: this.clock.now().toISOString(),
    };
    this.repository.updateOwnedSkillPackage(updated);
    this.options.onAction?.("character_owned_skill_updated", "completed", {
      characterId,
      conversationSpace,
      packageId,
      status,
    });
    return this.getOwnedSkill(characterId, packageId, conversationSpace);
  }

  listOwnedSkillVersions(
    characterId: string,
    packageId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillVersion[] {
    this.getOwnedSkill(characterId, packageId, conversationSpace);
    return this.repository.listOwnedSkillVersions(packageId);
  }

  createOwnedSkillVersion(
    characterId: string,
    packageId: string,
    input: {
      markdown: string;
      changeSummary?: string;
      activate?: boolean;
      source?: CharacterOwnedSkillVersion["source"];
      sourceTaskId?: string;
    },
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillVersion {
    const skill = this.getOwnedSkill(characterId, packageId, conversationSpace);
    const markdown = validateCharacterSkillMarkdown(input.markdown);
    const contentHash = characterSkillContentHash(markdown);
    if (input.sourceTaskId) {
      const existing = this.repository.findOwnedSkillVersionBySourceTask(packageId, input.sourceTaskId);
      if (existing) return existing;
    }
    const active = this.repository.getActiveOwnedSkillVersion(packageId);
    if (active?.contentHash === contentHash && input.activate !== false) return active;
    const now = this.clock.now().toISOString();
    const activate = input.activate !== false;
    const source = input.source ?? "manual";
    if (!(["manual", "character_created", "character_reflection", "legacy_migration"] as const).includes(source)) {
      throw new CharacterCapabilityValidationError("invalid character-owned Skill version source");
    }
    const version: CharacterOwnedSkillVersion = {
      id: this.idGenerator.next("character-owned-skill-version"),
      packageId,
      characterId,
      conversationSpace,
      version: this.repository.nextOwnedSkillVersion(packageId),
      status: activate ? "active" : "draft",
      markdown,
      changeSummary: boundedText(input.changeSummary, 300),
      source,
      ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
      contentHash,
      createdAt: now,
      ...(activate ? { activatedAt: now } : {}),
    };
    this.repository.transaction(() => {
      if (activate) this.repository.supersedeActiveOwnedSkillVersion(packageId, now);
      this.repository.insertOwnedSkillVersion(version);
      this.repository.updateOwnedSkillPackage({
        ...skill,
        status: activate ? "active" : skill.status,
        updatedAt: now,
      });
    });
    this.options.onAction?.("character_owned_skill_version_created", "completed", {
      characterId,
      conversationSpace,
      packageId,
      version: version.version,
      activated: activate,
    });
    return this.repository.getOwnedSkillVersion(packageId, version.id)!;
  }

  activateOwnedSkillVersion(
    characterId: string,
    packageId: string,
    versionId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillVersion {
    const skill = this.getOwnedSkill(characterId, packageId, conversationSpace);
    const target = this.repository.getOwnedSkillVersion(packageId, versionId);
    if (!target || target.status === "rejected") {
      throw new CharacterCapabilityValidationError("character-owned Skill version is unavailable");
    }
    const now = this.clock.now().toISOString();
    this.repository.transaction(() => {
      this.repository.supersedeActiveOwnedSkillVersion(packageId, now);
      this.repository.activateOwnedSkillVersion(packageId, versionId, now);
      this.repository.updateOwnedSkillPackage({ ...skill, status: "active", updatedAt: now });
    });
    return this.repository.getOwnedSkillVersion(packageId, versionId)!;
  }

  listOwnedSkillEvaluations(
    characterId: string,
    packageId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillEvaluation[] {
    this.getOwnedSkill(characterId, packageId, conversationSpace);
    return this.repository.listOwnedSkillEvaluations(packageId);
  }

  listOwnedSkillProposals(
    characterId: string,
    packageId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillProposal[] {
    this.getOwnedSkill(characterId, packageId, conversationSpace);
    return this.repository.listOwnedSkillProposals(packageId);
  }

  approveOwnedSkillProposal(
    characterId: string,
    packageId: string,
    proposalId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillVersion {
    const skill = this.getOwnedSkill(characterId, packageId, conversationSpace);
    const proposal = this.repository.getOwnedSkillProposal(packageId, proposalId);
    if (!proposal || proposal.status !== "pending") {
      throw new CharacterCapabilityValidationError("Skill improvement proposal is not pending");
    }
    const active = this.repository.getActiveOwnedSkillVersion(packageId);
    if (!active || active.id !== proposal.baseVersionId) {
      this.repository.updateOwnedSkillProposal(
        packageId,
        proposalId,
        "stale",
        this.clock.now().toISOString(),
      );
      throw new CharacterCapabilityValidationError(
        "Skill improvement proposal is stale because the active version changed",
      );
    }
    const now = this.clock.now().toISOString();
    const created: CharacterOwnedSkillVersion = {
      id: this.idGenerator.next("character-owned-skill-version"),
      packageId,
      characterId,
      conversationSpace,
      version: this.repository.nextOwnedSkillVersion(packageId),
      status: "active",
      markdown: proposal.proposedMarkdown,
      changeSummary: proposal.changeSummary,
      source: "character_reflection",
      sourceTaskId: proposal.sourceTaskId,
      contentHash: proposal.contentHash,
      createdAt: now,
      activatedAt: now,
    };
    this.repository.transaction(() => {
      this.repository.supersedeActiveOwnedSkillVersion(packageId, now);
      this.repository.insertOwnedSkillVersion(created);
      this.repository.updateOwnedSkillPackage({ ...skill, status: "active", updatedAt: now });
      this.repository.updateOwnedSkillProposal(
        packageId,
        proposalId,
        "approved",
        now,
        created.id,
      );
    });
    this.options.onAction?.("character_owned_skill_proposal_approved", "completed", {
      characterId,
      conversationSpace,
      packageId,
      proposalId,
      version: created.version,
    });
    return created;
  }

  rejectOwnedSkillProposal(
    characterId: string,
    packageId: string,
    proposalId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterOwnedSkillProposal {
    this.getOwnedSkill(characterId, packageId, conversationSpace);
    const proposal = this.repository.getOwnedSkillProposal(packageId, proposalId);
    if (!proposal || proposal.status !== "pending") {
      throw new CharacterCapabilityValidationError("Skill improvement proposal is not pending");
    }
    this.repository.updateOwnedSkillProposal(
      packageId,
      proposalId,
      "rejected",
      this.clock.now().toISOString(),
    );
    return this.repository.getOwnedSkillProposal(packageId, proposalId)!;
  }

  getPublicSummary(characterId: string): PublicCharacterCollaborationSummary {
    const profile = this.ensureCollaborationProfile(characterId);
    const skills = this.repository.listOwnedSkills(characterId, "normal")
      .filter((skill) => skill.status === "active" && skill.activeVersion)
      .map((skill) => {
        const operational = skill.completedCount + skill.failedCount;
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          tags: [...skill.tags],
          version: skill.activeVersion!.version,
          executionCount: skill.evaluationCount,
          ...(operational
            ? { successRate: skill.completedCount / operational }
            : {}),
          ...(skill.averageScore === undefined ? {} : { averageScore: skill.averageScore }),
        };
      });
    return {
      introduction: profile.introduction,
      traits: [...profile.traits],
      skills,
    };
  }

  getTaskIdentity(characterId: string): CharacterTaskIdentity {
    const profile = this.ensureCollaborationProfile(characterId);
    return {
      introduction: profile.introduction,
      traits: [...profile.traits],
    };
  }

  getTaskSkill(
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
    selectedSkillIds: string[] = [],
  ): CharacterTaskSkill | undefined {
    const requestedIds = new Set(uniqueSkillIds(selectedSkillIds));
    const packages = this.listOwnedSkills(characterId, conversationSpace)
      .filter((entry) => entry.status === "active" && entry.activeVersion)
      .filter((entry) => requestedIds.size
        ? requestedIds.has(entry.id)
        : true)
      .slice(0, OWNED_SKILL_SELECTED_MAX)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        version: entry.activeVersion!.version,
        markdown: entry.activeVersion!.markdown,
      }));
    return packages.length ? { packages } : undefined;
  }

  routeTask(input: {
    sourceCharacterId: string;
    task: string;
    requiredSkillIds?: string[];
    targetCharacterId?: string;
  }): CharacterTaskRoute {
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const membership = this.worldService.repository.getMembership(source.id);
    if (!membership) {
      throw new CharacterTaskRoutingError("source character is not assigned to a shared world");
    }
    const task = requiredText(input.task, TASK_LIMIT, "task");
    const requiredSkillIds = uniqueSkillIds(input.requiredSkillIds ?? []);
    const selectionMode = input.targetCharacterId ? "explicit" as const : "automatic" as const;
    if (
      selectionMode === "automatic" && requiredSkillIds.length === 0
    ) {
      throw new CharacterCapabilityValidationError(
        "automatic character routing requires at least one public Skill id",
      );
    }
    if (requiredSkillIds.length > OWNED_SKILL_SELECTED_MAX) {
      throw new CharacterCapabilityValidationError(
        `character routing accepts at most ${OWNED_SKILL_SELECTED_MAX} required Skills`,
      );
    }
    const directory = this.worldService.listWorldCharacters(source.id)
      .filter((entry) => !entry.self);
    if (input.targetCharacterId && input.targetCharacterId === source.id) {
      throw new CharacterCapabilityValidationError("a character cannot delegate a task to itself");
    }
    if (
      input.targetCharacterId &&
      !directory.some((entry) => entry.characterId === input.targetCharacterId)
    ) {
      throw new CharacterTaskRoutingError(
        "explicit target must be another character in the same shared world",
      );
    }
    const candidates = directory.map((entry) => this.scoreCandidate({
      sourceCharacterId: source.id,
      worldId: membership.worldId,
      characterId: entry.characterId,
      characterName: entry.name,
      availability: entry.availability,
      requiredSkillIds,
      explicit: entry.characterId === input.targetCharacterId,
    })).sort((left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      right.score - left.score ||
      left.characterId.localeCompare(right.characterId));
    const explicitCandidate = input.targetCharacterId
      ? candidates.find((candidate) => candidate.characterId === input.targetCharacterId)
      : undefined;
    const selected = input.targetCharacterId
      ? requiredSkillIds.length && !explicitCandidate?.eligible
        ? undefined
        : explicitCandidate
      : candidates.find((candidate) => candidate.eligible);
    const route: CharacterTaskRoute = {
      sourceCharacterId: source.id,
      worldId: membership.worldId,
      task,
      requiredSkillIds,
      selectedSkillIds: selected?.matchedSkillIds ?? [],
      selectionMode,
      ...(selected ? { selected } : {}),
      candidates,
    };
    if (!selected) {
      throw new CharacterTaskRoutingError(
        "no same-world character is currently eligible for the requested capabilities or Skills",
        route,
      );
    }
    return route;
  }

  recordTaskEvidence(input: {
    characterId: string;
    skillPackageIds?: string[];
    conversationSpace?: ConversationSpace;
    sourceTaskId: string;
    outcome: CharacterCapabilityEvidenceOutcome;
    summary: string;
    functionalScore?: number;
    judgeScore?: number;
  }): void {
    this.rpService.getCharacter(input.characterId);
    const functionalScore = optionalScore(input.functionalScore, "functionalScore");
    const judgeScore = optionalScore(input.judgeScore, "judgeScore");
    const sourceTaskId = requiredText(input.sourceTaskId, 300, "sourceTaskId");
    const summary = boundedText(input.summary, EVIDENCE_SUMMARY_LIMIT);
    const createdAt = this.clock.now().toISOString();
    const conversationSpace = input.conversationSpace ?? "normal";
    const requestedSkillIds = new Set(uniqueSkillIds(input.skillPackageIds ?? []));
    const selectedPackages = this.listOwnedSkills(input.characterId, conversationSpace)
      .filter((skill) => skill.status === "active" && skill.activeVersion)
      .filter((skill) => requestedSkillIds.has(skill.id))
      .slice(0, OWNED_SKILL_SELECTED_MAX);
    const score = functionalScore !== undefined && judgeScore !== undefined
      ? (functionalScore + judgeScore) / 2
      : functionalScore ?? judgeScore ?? defaultOwnedSkillScore(input.outcome);
    for (const skill of selectedPackages) {
      this.repository.createOwnedSkillEvaluation({
        id: this.idGenerator.next("character-owned-skill-evaluation"),
        packageId: skill.id,
        versionId: skill.activeVersion!.id,
        characterId: input.characterId,
        conversationSpace,
        sourceTaskId,
        outcome: input.outcome,
        ...(score === undefined ? {} : { score }),
        resultSummary: summary,
        lesson: "",
        createdAt,
      });
      if ((input.outcome === "completed" || input.outcome === "failed") && skill.autoImprove) {
        this.scheduleOwnedSkillReflection(skill, sourceTaskId, summary);
      }
    }
    if (
      input.outcome === "completed" &&
      conversationSpace === "normal" &&
      selectedPackages.length === 0
    ) {
      this.scheduleOwnedSkillCreation(
        input.characterId,
        sourceTaskId,
        summary,
      );
    }
  }

  private availableOwnedSkillSlug(
    characterId: string,
    conversationSpace: ConversationSpace,
    name: string,
  ): string {
    const base = slugifyOwnedSkillName(name) || "skill";
    let candidate = base;
    let suffix = 2;
    while (this.repository.findOwnedSkillBySlug(characterId, conversationSpace, candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private scheduleOwnedSkillReflection(
    skill: CharacterOwnedSkillPackage,
    sourceTaskId: string,
    taskSummary: string,
  ): void {
    if (
      this.disposed ||
      !skill.activeVersion ||
      !this.options.skillReflector ||
      !this.options.modelAvailable(skill.characterId) ||
      this.repository.findOwnedSkillProposalBySourceTask(skill.id, sourceTaskId)
    ) return;
    const key = `improve:${skill.id}:${sourceTaskId}`;
    if (this.ownedSkillJobs.has(key)) return;
    const job = this.skillTail
      .catch(() => undefined)
      .then(() => this.performOwnedSkillReflection(skill, sourceTaskId, taskSummary));
    this.skillTail = job.catch(() => undefined);
    this.ownedSkillJobs.set(key, job);
    void job.finally(() => {
      if (this.ownedSkillJobs.get(key) === job) this.ownedSkillJobs.delete(key);
    }).catch(() => undefined);
  }

  private scheduleOwnedSkillCreation(
    characterId: string,
    sourceTaskId: string,
    taskSummary: string,
  ): void {
    if (
      this.disposed ||
      !this.options.ownedSkillCreator ||
      !this.options.modelAvailable(characterId)
    ) return;
    const key = `create:${characterId}:${sourceTaskId}`;
    if (this.ownedSkillJobs.has(key)) return;
    const job = this.skillTail
      .catch(() => undefined)
      .then(() => this.performOwnedSkillCreation(
        characterId,
        sourceTaskId,
        taskSummary,
      ));
    this.skillTail = job.catch(() => undefined);
    this.ownedSkillJobs.set(key, job);
    void job.finally(() => {
      if (this.ownedSkillJobs.get(key) === job) this.ownedSkillJobs.delete(key);
    }).catch(() => undefined);
  }

  private async performOwnedSkillReflection(
    skill: CharacterOwnedSkillPackage,
    sourceTaskId: string,
    taskSummary: string,
  ): Promise<CharacterOwnedSkillProposal | undefined> {
    const latest = this.repository.getOwnedSkill(
      skill.characterId,
      skill.conversationSpace,
      skill.id,
    );
    const active = latest?.activeVersion;
    if (!latest || !active || latest.status !== "active" || !latest.autoImprove) return undefined;
    const character = this.rpService.getCharacter(skill.characterId);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const raw = await this.options.skillReflector!({
        characterId: skill.characterId,
        characterName: character.name,
        soulMarkdown: character.soulMarkdown,
        currentSkill: active,
        ownedSkillPackage: latest,
        taskSummary,
        sourceTaskId,
        signal: controller.signal,
      });
      if (this.disposed || controller.signal.aborted) return undefined;
      const reflection = parseCharacterSkillReflection(raw);
      if (!reflection.shouldUpdate) return undefined;
      const contentHash = characterSkillContentHash(reflection.markdown);
      if (contentHash === active.contentHash) return undefined;
      const existing = this.repository.findOwnedSkillProposalBySourceTask(skill.id, sourceTaskId);
      if (existing) return existing;
      const proposal: CharacterOwnedSkillProposal = {
        id: this.idGenerator.next("character-owned-skill-proposal"),
        packageId: skill.id,
        baseVersionId: active.id,
        characterId: skill.characterId,
        conversationSpace: skill.conversationSpace,
        sourceTaskId,
        status: "pending",
        proposedMarkdown: reflection.markdown,
        changeSummary: reflection.changeSummary || "角色根据执行结果提出改进",
        contentHash,
        createdAt: this.clock.now().toISOString(),
      };
      this.repository.insertOwnedSkillProposal(proposal);
      this.options.onAction?.("character_owned_skill_improvement_proposed", "completed", {
        characterId: skill.characterId,
        conversationSpace: skill.conversationSpace,
        packageId: skill.id,
        proposalId: proposal.id,
        sourceTaskId,
      });
      return proposal;
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        this.options.onAction?.("character_owned_skill_reflection", "failed", {
          characterId: skill.characterId,
          conversationSpace: skill.conversationSpace,
          packageId: skill.id,
          sourceTaskId,
          error: errorText(error),
        });
      }
      return undefined;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private async performOwnedSkillCreation(
    characterId: string,
    sourceTaskId: string,
    taskSummary: string,
  ): Promise<CharacterOwnedSkillPackage | undefined> {
    const character = this.rpService.getCharacter(characterId);
    const now = this.clock.now().toISOString();
    const starterMarkdown = [
      "# 新 Skill 草稿",
      "",
      "## 目标",
      "从刚完成的任务中提炼一个边界清晰、可重复执行的专业工作方法。",
      "",
      "## 约束",
      "- 只描述方法，不声称拥有任何未配置的工具或权限。",
      "- 写明适用场景、执行步骤、验证方式和失败处理。",
    ].join("\n");
    const currentSkill = {
      conversationSpace: "normal",
      markdown: starterMarkdown,
    } as const;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const raw = await this.options.ownedSkillCreator!({
        characterId,
        characterName: character.name,
        soulMarkdown: character.soulMarkdown,
        currentSkill,
        taskSummary,
        sourceTaskId,
        signal: controller.signal,
      });
      if (this.disposed || controller.signal.aborted) return undefined;
      const reflection = parseCharacterSkillReflection(raw);
      if (!reflection.shouldUpdate) return undefined;
      const created = this.createOwnedSkill(characterId, {
        name: reflection.name || "新任务工作法",
        description: reflection.description ||
          `由${character.name}在完成实际任务后总结的专属工作方法，启用前需要审核。`,
        tags: reflection.tags?.length ? reflection.tags : ["character-created"],
        markdown: reflection.markdown,
        autoImprove: true,
        activate: false,
        createdBy: "character",
        sourceTaskId,
      }, "normal");
      this.options.onAction?.("character_owned_skill_draft_created", "completed", {
        characterId,
        packageId: created.id,
        sourceTaskId,
      });
      return created;
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        this.options.onAction?.("character_owned_skill_creation", "failed", {
          characterId,
          sourceTaskId,
          error: errorText(error),
        });
      }
      return undefined;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private scoreCandidate(input: {
    sourceCharacterId: string;
    worldId: string;
    characterId: string;
    characterName: string;
    availability: string;
    requiredSkillIds: string[];
    explicit: boolean;
  }): CharacterTaskRouteCandidate {
    const profile = this.ensureCollaborationProfile(input.characterId);
    const activeTasks = this.repository.countActiveTasks(input.characterId);
    const reasons: string[] = [];
    const warnings: string[] = [];
    const publicSkills = this.repository.listOwnedSkills(input.characterId, "normal")
      .filter((skill) => skill.status === "active" && skill.activeVersion);
    const matchedSkillIds = input.requiredSkillIds.filter((skillId) =>
      publicSkills.some((skill) => skill.id === skillId));
    let eligible = true;
    let score = 0;
    if (matchedSkillIds.length !== input.requiredSkillIds.length) {
      eligible = false;
      warnings.push("未拥有请求的专属 Skill");
    }
    for (const skillId of matchedSkillIds) {
      const skill = publicSkills.find((entry) => entry.id === skillId)!;
      const completed = skill.completedCount + skill.failedCount;
      const reliabilityBonus = completed
        ? Math.round((skill.completedCount / completed) * 10)
        : 0;
      const qualityBonus = skill.averageScore === undefined
        ? 0
        : Math.round(skill.averageScore / 10);
      score += 45 + Math.min(20, skill.activeVersion!.version * 2) +
        reliabilityBonus + qualityBonus;
      reasons.push(`拥有专属 Skill「${skill.name}」v${skill.activeVersion!.version}`);
    }
    if (!this.options.modelAvailable(input.characterId)) {
      eligible = false;
      warnings.push("角色模型当前不可用");
    }
    if (activeTasks >= profile.maxConcurrentTasks && !input.explicit) {
      eligible = false;
      warnings.push(`任务负载已满 ${activeTasks}/${profile.maxConcurrentTasks}`);
    } else {
      score += Math.max(0, profile.maxConcurrentTasks - activeTasks) * 4;
      reasons.push(`当前负载 ${activeTasks}/${profile.maxConcurrentTasks}`);
    }
    if (input.availability === "free") {
      score += 15;
      reasons.push("当前空闲");
    } else if (input.availability === "busy") {
      reasons.push("当前忙碌");
    } else if (!input.explicit) {
      eligible = false;
      warnings.push(input.availability === "resting" ? "正在休息" : "正在移动");
    }
    const relationship = this.worldConversationService.repository.getCharacterRelationship(
      input.worldId,
      input.sourceCharacterId,
      input.characterId,
    );
    if (relationship) {
      const relationshipAdjustment = clamp(
        Math.round((relationship.affinity + relationship.trust - 90) / 10),
        -8,
        8,
      );
      score += relationshipAdjustment;
      if (relationshipAdjustment) {
        reasons.push(`协作关系 ${relationshipAdjustment > 0 ? "+" : ""}${relationshipAdjustment}`);
      }
    }
    if (input.explicit) {
      eligible = matchedSkillIds.length === input.requiredSkillIds.length &&
        this.options.modelAvailable(input.characterId);
      reasons.unshift("调用方明确指定");
    }
    return {
      characterId: input.characterId,
      characterName: input.characterName,
      ...(profile.introduction ? { introduction: profile.introduction } : {}),
      traits: [...profile.traits],
      eligible,
      score,
      activeTasks,
      maxConcurrentTasks: profile.maxConcurrentTasks,
      availability: input.availability,
      reasons,
      warnings,
      matchedSkillIds,
    };
  }
}

function uniqueSkillIds(values: string[]): string[] {
  if (!Array.isArray(values)) {
    throw new CharacterCapabilityValidationError("requiredSkillIds must be an array");
  }
  const result: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || result.includes(value)) continue;
    if ([...value].length > 200) {
      throw new CharacterCapabilityValidationError("character Skill id is too long");
    }
    result.push(value);
  }
  return result;
}

function ownedSkillTags(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new CharacterCapabilityValidationError("Skill tags must be an array");
  }
  const result: string[] = [];
  for (const raw of values) {
    const value = boundedText(raw, OWNED_SKILL_TAG_LIMIT);
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  if (result.length > OWNED_SKILL_TAGS_MAX) {
    throw new CharacterCapabilityValidationError(
      `a character-owned Skill accepts at most ${OWNED_SKILL_TAGS_MAX} tags`,
    );
  }
  return result;
}

function collaborationTraits(values: string[]): string[] {
  if (!Array.isArray(values)) {
    throw new CharacterCapabilityValidationError("traits must be an array");
  }
  const result: string[] = [];
  for (const raw of values) {
    const value = boundedText(raw, COLLABORATION_TRAIT_LIMIT);
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  if (result.length > COLLABORATION_TRAITS_MAX) {
    throw new CharacterCapabilityValidationError(
      `a collaboration profile accepts at most ${COLLABORATION_TRAITS_MAX} traits`,
    );
  }
  return result;
}

function slugifyOwnedSkillName(name: string): string {
  return name.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function defaultOwnedSkillScore(
  outcome: CharacterCapabilityEvidenceOutcome,
): number | undefined {
  if (outcome === "completed") return 80;
  if (outcome === "failed") return 20;
  return undefined;
}

function requiredText(value: unknown, maximum: number, field: string): string {
  const normalized = boundedText(value, maximum);
  if (!normalized) throw new CharacterCapabilityValidationError(`${field} is required`);
  return normalized;
}

function boundedText(value: unknown, maximum: number): string {
  return [...String(value ?? "").trim()].slice(0, maximum).join("");
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CharacterCapabilityValidationError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function optionalScore(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new CharacterCapabilityValidationError(`${field} must be between 0 and 100`);
  }
  return parsed;
}

function optionalConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CharacterCapabilityValidationError("confidence must be between 0 and 1");
  }
  return parsed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
