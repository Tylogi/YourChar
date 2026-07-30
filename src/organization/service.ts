import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { AgentModule } from "../modules/types.js";
import type { RpService } from "../rp/service.js";
import type { WorldConversationService } from "../world/conversation-service.js";
import type { WorldService } from "../world/service.js";
import {
  characterCapabilityCatalog,
  characterCapabilityDefinition,
} from "./catalog.js";
import {
  characterSkillContentHash,
  characterSoulHash,
  parseCharacterFunctionInference,
  parseCharacterSkillReflection,
  validateCharacterSkillMarkdown,
} from "./inference.js";
import type { CharacterCapabilityRepository } from "./repository.js";
import {
  isCharacterCapabilityId,
  type CharacterCapability,
  type CharacterCapabilityEvidence,
  type CharacterCapabilityEvidenceOutcome,
  type CharacterCapabilityEvidenceSummary,
  type CharacterCapabilityEvolution,
  type CharacterCapabilityId,
  type CharacterFunctionInferer,
  type CharacterFunctionProfile,
  type CharacterFunctionProfileUpdate,
  type CharacterFunctionSnapshot,
  type CharacterSkillReflector,
  type CharacterSkillVersion,
  type CharacterTaskIdentity,
  type CharacterTaskRoute,
  type CharacterTaskRouteCandidate,
  type CharacterTaskSkill,
  type PublicCharacterFunctionSummary,
} from "./types.js";

const PUBLIC_ROLE_LIMIT = 120;
const TASK_BOUNDARY_LIMIT = 1_000;
const CAPABILITY_NOTES_LIMIT = 500;
const TASK_LIMIT = 2_000;
const EVIDENCE_SUMMARY_LIMIT = 1_000;
const MAX_MODULES_PER_CAPABILITY = 12;
const SKILL_REFLECTION_MILESTONES = new Set([1, 3, 6, 10]);

type OrganizationActionStatus = "completed" | "failed" | "blocked";

export type CharacterCapabilityServiceOptions = {
  listModules: () => AgentModule[];
  modelAvailable: (characterId: string) => boolean;
  inferer?: CharacterFunctionInferer;
  skillReflector?: CharacterSkillReflector;
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

export class CharacterFunctionInferenceUnavailableError extends Error {
  readonly code = "CHARACTER_FUNCTION_INFERENCE_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "CharacterFunctionInferenceUnavailableError";
  }
}

export class CharacterCapabilityService {
  private readonly inferenceJobs = new Map<string, Promise<CharacterFunctionSnapshot>>();
  private readonly skillJobs = new Map<string, Promise<CharacterSkillVersion | undefined>>();
  private readonly controllers = new Set<AbortController>();
  private inferenceTail: Promise<unknown> = Promise.resolve();
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
      const profile = this.ensureProfile(character.id);
      if (!profile.manualLocked && profile.inferenceStatus === "pending") {
        this.repository.upsertProfile({
          ...profile,
          inferenceStatus: "uninitialized",
          inferenceError: "上次自动分析未完成，已重新排队。",
          updatedAt: this.clock.now().toISOString(),
        });
      }
      this.scheduleInference(character.id, "startup");
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
    while (this.inferenceJobs.size || this.skillJobs.size) {
      await Promise.allSettled([
        ...this.inferenceJobs.values(),
        ...this.skillJobs.values(),
      ]);
    }
  }

  ensureProfile(characterId: string): CharacterFunctionProfile {
    const character = this.rpService.getCharacter(characterId);
    const existing = this.repository.getProfile(characterId);
    if (existing) return existing;
    const now = this.clock.now().toISOString();
    return this.repository.upsertProfile({
      characterId,
      publicRole: "",
      taskPreferences: "",
      avoidedTasks: "",
      maxConcurrentTasks: 1,
      manualLocked: false,
      inferenceStatus: "uninitialized",
      sourceSoulHash: "",
      inferenceError: "",
      createdAt: character.createdAt || now,
      updatedAt: now,
    });
  }

  getSnapshot(characterId: string): CharacterFunctionSnapshot {
    const character = this.rpService.getCharacter(characterId);
    const profile = this.ensureProfile(characterId);
    const capabilities = this.repository.listCapabilities(characterId);
    const evidence = this.repository.summarizeEvidence(characterId);
    const activeSkill = this.repository.getActiveSkill(characterId);
    const evolution = capabilities.map((capability) =>
      capabilityEvolution(
        capability,
        evidence.find((entry) => entry.capabilityId === capability.capabilityId),
        activeSkill,
      ));
    const snapshot: CharacterFunctionSnapshot = {
      profile,
      capabilities,
      catalog: characterCapabilityCatalog.map((entry) => ({
        ...entry,
        recommendedModuleIds: [...entry.recommendedModuleIds],
      })),
      modules: this.options.listModules().map((module) => ({
        id: module.id,
        name: module.name,
        type: module.type,
        enabled: module.enabled,
        estimatedTokens: module.estimatedTokens,
      })),
      evidence,
      evolution,
      activeSkills: activeSkill ? [activeSkill] : [],
      soulOutdated: Boolean(
        profile.sourceSoulHash &&
        profile.sourceSoulHash !== characterSoulHash(character.name, character.soulMarkdown),
      ),
    };
    if (!profile.manualLocked && profile.inferenceStatus === "uninitialized") {
      this.scheduleInference(characterId, "snapshot");
    }
    return snapshot;
  }

  updateProfile(
    characterId: string,
    update: CharacterFunctionProfileUpdate,
  ): CharacterFunctionSnapshot {
    const character = this.rpService.getCharacter(characterId);
    const current = this.ensureProfile(characterId);
    const now = this.clock.now().toISOString();
    const knownModules = new Set(this.options.listModules().map((module) => module.id));
    const existingCapabilities = new Map(
      this.repository.listCapabilities(characterId)
        .map((capability) => [capability.capabilityId, capability]),
    );
    const seen = new Set<CharacterCapabilityId>();
    const capabilities = update.capabilities.map((entry) => {
      if (!isCharacterCapabilityId(entry.capabilityId)) {
        throw new CharacterCapabilityValidationError(
          `unknown character capability: ${String(entry.capabilityId)}`,
        );
      }
      if (seen.has(entry.capabilityId)) {
        throw new CharacterCapabilityValidationError(
          `duplicate character capability: ${entry.capabilityId}`,
        );
      }
      seen.add(entry.capabilityId);
      const level = boundedInteger(entry.level, 1, 5, `${entry.capabilityId} level`);
      if (entry.responsibility !== "primary" && entry.responsibility !== "support") {
        throw new CharacterCapabilityValidationError(
          `${entry.capabilityId} responsibility must be primary or support`,
        );
      }
      if (typeof entry.autoAccept !== "boolean") {
        throw new CharacterCapabilityValidationError(
          `${entry.capabilityId} autoAccept must be boolean`,
        );
      }
      const moduleIds = uniqueStrings(entry.moduleIds ?? [], MAX_MODULES_PER_CAPABILITY);
      const unknownModule = moduleIds.find((moduleId) => !knownModules.has(moduleId));
      if (unknownModule) {
        throw new CharacterCapabilityValidationError(`unknown agent module: ${unknownModule}`);
      }
      const existing = existingCapabilities.get(entry.capabilityId);
      return {
        characterId,
        capabilityId: entry.capabilityId,
        level,
        responsibility: entry.responsibility,
        autoAccept: entry.autoAccept,
        moduleIds,
        notes: boundedText(entry.notes, CAPABILITY_NOTES_LIMIT),
        source: entry.source ?? "manual",
        confidence: optionalConfidence(entry.confidence) ?? existing?.confidence ?? 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies CharacterCapability;
    });
    const profile: CharacterFunctionProfile = {
      ...current,
      publicRole: boundedText(update.publicRole, PUBLIC_ROLE_LIMIT),
      taskPreferences: boundedText(update.taskPreferences, TASK_BOUNDARY_LIMIT),
      avoidedTasks: boundedText(update.avoidedTasks, TASK_BOUNDARY_LIMIT),
      maxConcurrentTasks: boundedInteger(
        update.maxConcurrentTasks ?? current.maxConcurrentTasks,
        1,
        5,
        "maxConcurrentTasks",
      ),
      manualLocked: update.manualLocked ?? true,
      inferenceStatus: "ready",
      sourceSoulHash: characterSoulHash(character.name, character.soulMarkdown),
      inferenceError: "",
      updatedAt: now,
    };
    this.repository.transaction(() => {
      this.repository.upsertProfile(profile);
      this.repository.replaceCapabilities(characterId, capabilities);
    });
    this.ensureStarterSkill(characterId, "manual");
    return this.getSnapshot(characterId);
  }

  async setAutomaticManagement(
    characterId: string,
    automatic: boolean,
  ): Promise<CharacterFunctionSnapshot> {
    const current = this.ensureProfile(characterId);
    const now = this.clock.now().toISOString();
    this.repository.upsertProfile({
      ...current,
      manualLocked: !automatic,
      inferenceStatus: automatic ? "uninitialized" : current.inferenceStatus,
      inferenceError: automatic ? "" : current.inferenceError,
      updatedAt: now,
    });
    if (!automatic) {
      this.options.onAction?.("character_function_automation", "completed", {
        characterId,
        automatic: false,
      });
      return this.getSnapshot(characterId);
    }
    return this.requestInference(characterId, { reason: "automation_enabled", force: true });
  }

  notifyCharacterChanged(characterId: string): void {
    const character = this.rpService.getCharacter(characterId);
    const current = this.ensureProfile(characterId);
    const currentHash = characterSoulHash(character.name, character.soulMarkdown);
    if (current.sourceSoulHash === currentHash) return;
    if (current.manualLocked) return;
    this.repository.upsertProfile({
      ...current,
      inferenceStatus: "uninitialized",
      inferenceError: "",
      updatedAt: this.clock.now().toISOString(),
    });
    this.scheduleInference(characterId, "soul_changed");
  }

  retryAutomaticInferences(): void {
    for (const character of this.rpService.listCharacters()) {
      const profile = this.ensureProfile(character.id);
      if (profile.manualLocked || profile.inferenceStatus === "ready") continue;
      this.scheduleInference(character.id, "model_configuration_changed");
    }
  }

  requestInference(
    characterId: string,
    input: { reason: string; force?: boolean },
  ): Promise<CharacterFunctionSnapshot> {
    if (this.disposed) {
      return Promise.reject(new CharacterFunctionInferenceUnavailableError(
        "character function inference service is disposed",
      ));
    }
    const existing = this.inferenceJobs.get(characterId);
    if (existing) return existing;
    if (!this.options.inferer || !this.options.modelAvailable(characterId)) {
      return Promise.reject(new CharacterFunctionInferenceUnavailableError(
        "character function inference model is unavailable",
      ));
    }
    const profile = this.ensureProfile(characterId);
    if (profile.manualLocked && !input.force) {
      return Promise.resolve(this.getSnapshot(characterId));
    }
    const job = this.inferenceTail
      .catch(() => undefined)
      .then(() => this.performInference(characterId, input.reason, Boolean(input.force)));
    this.inferenceTail = job.catch(() => undefined);
    this.inferenceJobs.set(characterId, job);
    void job.finally(() => {
      if (this.inferenceJobs.get(characterId) === job) this.inferenceJobs.delete(characterId);
    }).catch(() => undefined);
    return job;
  }

  listSkillVersions(characterId: string, limit?: number): CharacterSkillVersion[] {
    this.rpService.getCharacter(characterId);
    return this.repository.listSkillVersions(characterId, limit);
  }

  rollbackSkill(characterId: string, version: number): CharacterSkillVersion {
    this.rpService.getCharacter(characterId);
    const target = this.repository.listSkillVersions(characterId, 200)
      .find((entry) => entry.version === version);
    if (!target || target.status === "rejected") {
      throw new CharacterCapabilityValidationError(
        `character Skill version is unavailable: ${version}`,
      );
    }
    if (target.status === "active") return target;
    const now = this.clock.now().toISOString();
    this.repository.transaction(() => {
      this.repository.supersedeActiveSkill(characterId, now);
      this.repository.activateSkillVersion(characterId, target.id, now);
    });
    this.options.onAction?.("character_skill_rollback", "completed", {
      characterId,
      version,
    });
    return this.repository.getActiveSkill(characterId)!;
  }

  getPublicSummary(characterId: string): PublicCharacterFunctionSummary {
    const profile = this.ensureProfile(characterId);
    const evolution = evolutionMap(
      this.repository.listCapabilities(characterId),
      this.repository.summarizeEvidence(characterId),
      this.repository.getActiveSkill(characterId),
    );
    return {
      ...(profile.publicRole ? { publicRole: profile.publicRole } : {}),
      capabilities: this.repository.listCapabilities(characterId).map((capability) => {
        const learned = evolution.get(capability.capabilityId)!;
        return {
          id: capability.capabilityId,
          label: characterCapabilityDefinition(capability.capabilityId).label,
          level: learned.effectiveLevel,
          baseLevel: capability.level,
          responsibility: capability.responsibility,
          autoAccept: capability.autoAccept,
          source: capability.source,
          evolutionStage: learned.stage,
        };
      }),
    };
  }

  getTaskIdentity(characterId: string): CharacterTaskIdentity {
    const profile = this.ensureProfile(characterId);
    const capabilities = this.repository.listCapabilities(characterId);
    const evolution = evolutionMap(
      capabilities,
      this.repository.summarizeEvidence(characterId),
      this.repository.getActiveSkill(characterId),
    );
    return {
      ...(profile.publicRole ? { publicRole: profile.publicRole } : {}),
      ...(profile.taskPreferences ? { taskPreferences: profile.taskPreferences } : {}),
      ...(profile.avoidedTasks ? { avoidedTasks: profile.avoidedTasks } : {}),
      capabilities: capabilities.map((capability) => {
        const learned = evolution.get(capability.capabilityId)!;
        return {
          id: capability.capabilityId,
          label: characterCapabilityDefinition(capability.capabilityId).label,
          level: learned.effectiveLevel,
          baseLevel: capability.level,
          responsibility: capability.responsibility,
          evolutionStage: learned.stage,
        };
      }),
    };
  }

  getTaskSkill(characterId: string): CharacterTaskSkill | undefined {
    const skill = this.repository.getActiveSkill(characterId);
    return skill ? { version: skill.version, markdown: skill.markdown } : undefined;
  }

  routeTask(input: {
    sourceCharacterId: string;
    task: string;
    requiredCapabilityIds?: CharacterCapabilityId[];
    targetCharacterId?: string;
  }): CharacterTaskRoute {
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const membership = this.worldService.repository.getMembership(source.id);
    if (!membership) {
      throw new CharacterTaskRoutingError("source character is not assigned to a shared world");
    }
    const task = requiredText(input.task, TASK_LIMIT, "task");
    const requiredCapabilityIds = uniqueCapabilityIds(input.requiredCapabilityIds ?? []);
    const selectionMode = input.targetCharacterId ? "explicit" as const : "automatic" as const;
    if (selectionMode === "automatic" && requiredCapabilityIds.length === 0) {
      throw new CharacterCapabilityValidationError(
        "automatic character routing requires at least one required capability",
      );
    }
    if (requiredCapabilityIds.length > 3) {
      throw new CharacterCapabilityValidationError(
        "character routing accepts at most three required capabilities",
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
      requiredCapabilityIds,
      explicit: entry.characterId === input.targetCharacterId,
    })).sort((left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      right.score - left.score ||
      left.characterId.localeCompare(right.characterId));
    const selected = input.targetCharacterId
      ? candidates.find((candidate) => candidate.characterId === input.targetCharacterId)
      : candidates.find((candidate) => candidate.eligible);
    const route: CharacterTaskRoute = {
      sourceCharacterId: source.id,
      worldId: membership.worldId,
      task,
      requiredCapabilityIds,
      selectionMode,
      ...(selected ? { selected } : {}),
      candidates,
    };
    if (!selected) {
      throw new CharacterTaskRoutingError(
        "no same-world character is currently eligible for the requested capabilities",
        route,
      );
    }
    return route;
  }

  recordTaskEvidence(input: {
    characterId: string;
    capabilityIds: CharacterCapabilityId[];
    sourceTaskId: string;
    outcome: CharacterCapabilityEvidenceOutcome;
    summary: string;
    functionalScore?: number;
    judgeScore?: number;
  }): CharacterCapabilityEvidence[] {
    const declared = new Set(
      this.repository.listCapabilities(input.characterId)
        .map((capability) => capability.capabilityId),
    );
    const capabilityIds = uniqueCapabilityIds(input.capabilityIds)
      .filter((capabilityId) => declared.has(capabilityId));
    const functionalScore = optionalScore(input.functionalScore, "functionalScore");
    const judgeScore = optionalScore(input.judgeScore, "judgeScore");
    const sourceTaskId = requiredText(input.sourceTaskId, 300, "sourceTaskId");
    const summary = boundedText(input.summary, EVIDENCE_SUMMARY_LIMIT);
    const createdAt = this.clock.now().toISOString();
    const evidence = capabilityIds.map((capabilityId) => this.repository.createEvidence({
      id: this.idGenerator.next("character-capability-evidence"),
      characterId: input.characterId,
      capabilityId,
      sourceTaskId,
      outcome: input.outcome,
      ...(functionalScore === undefined ? {} : { functionalScore }),
      ...(judgeScore === undefined ? {} : { judgeScore }),
      summary,
      lesson: "",
      createdAt,
    }));
    if (input.outcome === "completed" && evidence.length) {
      const completedTasks = this.repository.countCompletedTasks(input.characterId);
      if (shouldReflectAt(completedTasks)) {
        this.scheduleSkillReflection(input.characterId, sourceTaskId, summary);
      }
    }
    return evidence;
  }

  enabledBindings(characterId: string): string[] {
    const enabled = new Set(
      this.options.listModules().filter((module) => module.enabled).map((module) => module.id),
    );
    return [...new Set(
      this.repository.listCapabilities(characterId)
        .flatMap((capability) => capability.moduleIds)
        .filter((moduleId) => enabled.has(moduleId)),
    )].sort();
  }

  private scheduleInference(characterId: string, reason: string): void {
    const profile = this.ensureProfile(characterId);
    if (
      this.disposed ||
      profile.manualLocked ||
      profile.inferenceStatus === "pending" ||
      !this.options.inferer ||
      !this.options.modelAvailable(characterId)
    ) return;
    void this.requestInference(characterId, { reason }).catch(() => undefined);
  }

  private async performInference(
    characterId: string,
    reason: string,
    force: boolean,
  ): Promise<CharacterFunctionSnapshot> {
    const character = this.rpService.getCharacter(characterId);
    const startHash = characterSoulHash(character.name, character.soulMarkdown);
    const current = this.ensureProfile(characterId);
    if (current.manualLocked && !force) return this.getSnapshot(characterId);
    const startedAt = this.clock.now().toISOString();
    this.repository.upsertProfile({
      ...current,
      manualLocked: force ? false : current.manualLocked,
      inferenceStatus: "pending",
      inferenceError: "",
      inferenceStartedAt: startedAt,
      updatedAt: startedAt,
    });
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const raw = await this.options.inferer!({
        characterId,
        characterName: character.name,
        soulMarkdown: character.soulMarkdown,
        catalog: characterCapabilityCatalog,
        signal: controller.signal,
      });
      if (this.disposed || controller.signal.aborted) {
        throw new CharacterFunctionInferenceUnavailableError("character function inference was cancelled");
      }
      const inferred = parseCharacterFunctionInference(raw);
      const latestCharacter = this.rpService.getCharacter(characterId);
      const latestProfile = this.ensureProfile(characterId);
      const latestHash = characterSoulHash(latestCharacter.name, latestCharacter.soulMarkdown);
      if (latestProfile.manualLocked || latestHash !== startHash) {
        this.repository.upsertProfile({
          ...latestProfile,
          inferenceStatus: latestProfile.manualLocked ? "ready" : "uninitialized",
          inferenceError: "",
          updatedAt: this.clock.now().toISOString(),
        });
        if (!latestProfile.manualLocked) {
          queueMicrotask(() => this.scheduleInference(characterId, "stale_retry"));
        }
        return this.getSnapshot(characterId);
      }
      const now = this.clock.now().toISOString();
      const knownModules = new Set(this.options.listModules().map((module) => module.id));
      const existingCapabilities = new Map(
        this.repository.listCapabilities(characterId)
          .map((capability) => [capability.capabilityId, capability]),
      );
      const capabilities = inferred.capabilities.map((entry) => ({
        characterId,
        capabilityId: entry.capabilityId,
        level: entry.level,
        responsibility: entry.responsibility,
        autoAccept: entry.confidence >= 0.65,
        moduleIds: characterCapabilityDefinition(entry.capabilityId).recommendedModuleIds
          .filter((moduleId) => knownModules.has(moduleId)),
        notes: entry.rationale,
        source: "inferred" as const,
        confidence: entry.confidence,
        createdAt: existingCapabilities.get(entry.capabilityId)?.createdAt ?? now,
        updatedAt: now,
      }));
      this.repository.transaction(() => {
        this.repository.upsertProfile({
          ...latestProfile,
          publicRole: boundedText(inferred.publicRole, PUBLIC_ROLE_LIMIT),
          taskPreferences: boundedText(inferred.taskPreferences, TASK_BOUNDARY_LIMIT),
          avoidedTasks: boundedText(inferred.avoidedTasks, TASK_BOUNDARY_LIMIT),
          maxConcurrentTasks: 1,
          manualLocked: false,
          inferenceStatus: "ready",
          sourceSoulHash: latestHash,
          inferenceError: "",
          inferenceStartedAt: startedAt,
          inferredAt: now,
          updatedAt: now,
        });
        this.repository.replaceCapabilities(characterId, capabilities);
      });
      const activeSkill = this.repository.getActiveSkill(characterId);
      if (
        !activeSkill ||
        activeSkill.source === "bootstrap" ||
        activeSkill.source === "manual"
      ) {
        this.activateSkillVersion({
          characterId,
          markdown: inferred.skillMarkdown,
          changeSummary: activeSkill ? "根据更新后的人设重建初始工作方法" : "根据人设生成初始工作方法",
          source: "bootstrap",
        });
      }
      this.options.onAction?.("character_function_inference", "completed", {
        characterId,
        reason,
        capabilityIds: capabilities.map((entry) => entry.capabilityId),
        skillVersion: this.repository.getActiveSkill(characterId)?.version,
      });
      return this.getSnapshot(characterId);
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        const profile = this.ensureProfile(characterId);
        this.repository.upsertProfile({
          ...profile,
          inferenceStatus: "failed",
          inferenceError: boundedText(errorText(error), 500),
          updatedAt: this.clock.now().toISOString(),
        });
        this.options.onAction?.("character_function_inference", "failed", {
          characterId,
          reason,
          error: errorText(error),
        });
      }
      throw error;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private ensureStarterSkill(
    characterId: string,
    source: "manual" | "bootstrap",
  ): CharacterSkillVersion {
    const active = this.repository.getActiveSkill(characterId);
    if (active) return active;
    const character = this.rpService.getCharacter(characterId);
    const profile = this.ensureProfile(characterId);
    const capabilities = this.repository.listCapabilities(characterId);
    const labels = capabilities.map((entry) =>
      characterCapabilityDefinition(entry.capabilityId).label);
    const markdown = [
      `# ${character.name} 的 SKILL.md`,
      "",
      "## 当前职责",
      profile.publicRole || "在明确边界内完成被委托的任务。",
      "",
      "## 工作方法",
      labels.length
        ? `- 围绕${labels.join("、")}先确认目标、约束和可验证的交付结果。`
        : "- 先确认目标、约束和可验证的交付结果。",
      "- 不声称未实际执行的工具调用或外部操作。",
      "- 完成后检查遗漏、不确定性和下一步。",
    ].join("\n");
    return this.activateSkillVersion({
      characterId,
      markdown,
      changeSummary: source === "manual" ? "根据手动职能生成初始工作方法" : "生成初始工作方法",
      source,
    });
  }

  private scheduleSkillReflection(
    characterId: string,
    sourceTaskId: string,
    taskSummary: string,
  ): void {
    if (
      this.disposed ||
      !this.options.skillReflector ||
      !this.options.modelAvailable(characterId) ||
      this.repository.findSkillBySourceTask(characterId, sourceTaskId)
    ) return;
    const key = `${characterId}:${sourceTaskId}`;
    if (this.skillJobs.has(key)) return;
    const job = this.skillTail
      .catch(() => undefined)
      .then(() => this.performSkillReflection(characterId, sourceTaskId, taskSummary));
    this.skillTail = job.catch(() => undefined);
    this.skillJobs.set(key, job);
    void job.finally(() => {
      if (this.skillJobs.get(key) === job) this.skillJobs.delete(key);
    }).catch(() => undefined);
  }

  private async performSkillReflection(
    characterId: string,
    sourceTaskId: string,
    taskSummary: string,
  ): Promise<CharacterSkillVersion | undefined> {
    const character = this.rpService.getCharacter(characterId);
    const capabilities = this.repository.listCapabilities(characterId);
    if (!capabilities.length) return undefined;
    const currentSkill = this.ensureStarterSkill(characterId, "bootstrap");
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const raw = await this.options.skillReflector!({
        characterId,
        characterName: character.name,
        soulMarkdown: character.soulMarkdown,
        capabilities,
        capabilityDefinitions: capabilities.map((entry) =>
          characterCapabilityDefinition(entry.capabilityId)),
        currentSkill,
        taskSummary,
        sourceTaskId,
        signal: controller.signal,
      });
      if (this.disposed || controller.signal.aborted) return undefined;
      const reflection = parseCharacterSkillReflection(raw);
      if (!reflection.shouldUpdate) {
        this.repository.setEvidenceLesson(
          sourceTaskId,
          boundedText(reflection.changeSummary || "本轮没有形成可复用的工作方法。", 300),
        );
        this.options.onAction?.("character_skill_reflection", "blocked", {
          characterId,
          sourceTaskId,
          reason: "no_reusable_change",
        });
        return undefined;
      }
      const next = this.activateSkillVersion({
        characterId,
        markdown: reflection.markdown,
        changeSummary: reflection.changeSummary || "角色根据任务复盘更新了工作方法",
        source: "character_reflection",
        sourceTaskId,
      });
      this.repository.setEvidenceLesson(sourceTaskId, next.changeSummary);
      this.options.onAction?.("character_skill_reflection", "completed", {
        characterId,
        sourceTaskId,
        version: next.version,
      });
      return next;
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        this.options.onAction?.("character_skill_reflection", "failed", {
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

  private activateSkillVersion(input: {
    characterId: string;
    markdown: string;
    changeSummary: string;
    source: CharacterSkillVersion["source"];
    sourceTaskId?: string;
  }): CharacterSkillVersion {
    const markdown = validateCharacterSkillMarkdown(input.markdown);
    const contentHash = characterSkillContentHash(markdown);
    const active = this.repository.getActiveSkill(input.characterId);
    if (active?.contentHash === contentHash) return active;
    if (input.sourceTaskId) {
      const existing = this.repository.findSkillBySourceTask(
        input.characterId,
        input.sourceTaskId,
      );
      if (existing) return existing;
    }
    const now = this.clock.now().toISOString();
    let created: CharacterSkillVersion | undefined;
    this.repository.transaction(() => {
      this.repository.supersedeActiveSkill(input.characterId, now);
      created = this.repository.insertSkillVersion({
        id: this.idGenerator.next("character-skill-version"),
        characterId: input.characterId,
        version: this.repository.nextSkillVersion(input.characterId),
        status: "active",
        markdown,
        changeSummary: boundedText(input.changeSummary, 300),
        source: input.source,
        ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
        contentHash,
        createdAt: now,
        activatedAt: now,
      });
    });
    return created!;
  }

  private scoreCandidate(input: {
    sourceCharacterId: string;
    worldId: string;
    characterId: string;
    characterName: string;
    availability: string;
    requiredCapabilityIds: CharacterCapabilityId[];
    explicit: boolean;
  }): CharacterTaskRouteCandidate {
    const profile = this.ensureProfile(input.characterId);
    const capabilityList = this.repository.listCapabilities(input.characterId);
    const capabilities = new Map(
      capabilityList.map((capability) => [capability.capabilityId, capability]),
    );
    const evolution = evolutionMap(
      capabilityList,
      this.repository.summarizeEvidence(input.characterId),
      this.repository.getActiveSkill(input.characterId),
    );
    const activeTasks = this.repository.countActiveTasks(input.characterId);
    const reasons: string[] = [];
    const warnings: string[] = [];
    let eligible = true;
    let score = 0;
    for (const required of input.requiredCapabilityIds) {
      const capability = capabilities.get(required);
      if (!capability) {
        eligible = false;
        warnings.push(`未声明${characterCapabilityDefinition(required).label}`);
        continue;
      }
      if (!capability.autoAccept && !input.explicit) {
        eligible = false;
        warnings.push(`${characterCapabilityDefinition(required).label}未开放自动分派`);
      }
      const learned = evolution.get(required)!;
      score += learned.effectiveLevel * 20 + learned.routingAdjustment;
      score += capability.responsibility === "primary" ? 12 : 5;
      reasons.push(
        `${characterCapabilityDefinition(required).label} ${learned.effectiveLevel}级` +
        (capability.responsibility === "primary" ? "主责" : "协助") +
        (learned.learnedAdjustment
          ? `（成长${learned.learnedAdjustment > 0 ? "+" : ""}${learned.learnedAdjustment}）`
          : ""),
      );
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
      eligible = true;
      reasons.unshift("调用方明确指定");
    }
    return {
      characterId: input.characterId,
      characterName: input.characterName,
      ...(profile.publicRole ? { publicRole: profile.publicRole } : {}),
      eligible,
      score,
      activeTasks,
      maxConcurrentTasks: profile.maxConcurrentTasks,
      availability: input.availability,
      reasons,
      warnings,
    };
  }
}

function evolutionMap(
  capabilities: CharacterCapability[],
  evidence: CharacterCapabilityEvidenceSummary[],
  activeSkill?: CharacterSkillVersion,
): Map<CharacterCapabilityId, CharacterCapabilityEvolution> {
  return new Map(capabilities.map((capability) => [
    capability.capabilityId,
    capabilityEvolution(
      capability,
      evidence.find((entry) => entry.capabilityId === capability.capabilityId),
      activeSkill,
    ),
  ]));
}

function capabilityEvolution(
  capability: CharacterCapability,
  evidence: CharacterCapabilityEvidenceSummary | undefined,
  activeSkill: CharacterSkillVersion | undefined,
): CharacterCapabilityEvolution {
  const completed = evidence?.completed ?? 0;
  const failed = evidence?.failed ?? 0;
  const operational = completed + failed;
  const completionRate = operational ? completed / operational : undefined;
  const quality = evidence?.averageQualityScore;
  let learnedAdjustment = 0;
  if (
    (evidence?.scored ?? 0) >= 8 &&
    (quality ?? 0) >= 92 &&
    (completionRate ?? 0) >= 0.8
  ) {
    learnedAdjustment = 2;
  } else if (
    ((evidence?.scored ?? 0) >= 3 && (quality ?? 0) >= 82 && (completionRate ?? 0) >= 0.75) ||
    (completed >= 3 && (activeSkill?.version ?? 0) >= 3 && (completionRate ?? 0) >= 0.7)
  ) {
    learnedAdjustment = 1;
  }
  if (
    ((evidence?.scored ?? 0) >= 3 && quality !== undefined && quality < 45) ||
    (operational >= 4 && (completionRate ?? 1) < 0.4)
  ) {
    learnedAdjustment = -1;
  }
  if (
    learnedAdjustment > 0 &&
    completed >= 8 &&
    (activeSkill?.version ?? 0) >= 5 &&
    (completionRate ?? 0) >= 0.8
  ) {
    learnedAdjustment = Math.max(learnedAdjustment, 2);
  }
  const reliability = operational
    ? (completed + 2) / (operational + 3)
    : 2 / 3;
  const sampleConfidence = Math.min(1, operational / 8);
  const routingAdjustment = clamp(
    Math.round((reliability - 2 / 3) * 12 * sampleConfidence),
    -6,
    6,
  );
  const effectiveLevel = clamp(capability.level + learnedAdjustment, 1, 5);
  const stage = learnedAdjustment < 0
    ? "needs_review" as const
    : learnedAdjustment >= 2
      ? "advanced" as const
      : learnedAdjustment === 1
        ? "improving" as const
        : (evidence?.total ?? 0) > 0
          ? "practicing" as const
          : "new" as const;
  return {
    capabilityId: capability.capabilityId,
    baseLevel: capability.level,
    effectiveLevel,
    learnedAdjustment,
    routingAdjustment,
    stage,
    totalEvidence: evidence?.total ?? 0,
    scoredEvidence: evidence?.scored ?? 0,
    ...(completionRate === undefined ? {} : { completionRate }),
    ...(quality === undefined ? {} : { averageQualityScore: quality }),
  };
}

function shouldReflectAt(completedTasks: number): boolean {
  return SKILL_REFLECTION_MILESTONES.has(completedTasks) ||
    (completedTasks > 10 && completedTasks % 5 === 0);
}

function uniqueCapabilityIds(values: CharacterCapabilityId[]): CharacterCapabilityId[] {
  const result: CharacterCapabilityId[] = [];
  for (const value of values) {
    if (!isCharacterCapabilityId(value)) {
      throw new CharacterCapabilityValidationError(
        `unknown character capability: ${String(value)}`,
      );
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function uniqueStrings(values: string[], maximum: number): string[] {
  if (!Array.isArray(values)) {
    throw new CharacterCapabilityValidationError("moduleIds must be an array");
  }
  const result: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  if (result.length > maximum) {
    throw new CharacterCapabilityValidationError(
      `a capability accepts at most ${maximum} module bindings`,
    );
  }
  return result;
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
