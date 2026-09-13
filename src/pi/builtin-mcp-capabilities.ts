import type { CompanionStore } from "../domain/store.js";
import type { Clock } from "../app/clock.js";
import type { ConversationMetadata } from "./session-runtime.js";
import type { CompanionToolRuntimeState } from "../domain/tools.js";
import type { ScheduleService } from "../schedule/service.js";
import type { RpService } from "../rp/service.js";
import type { UserProfileService } from "../profile/service.js";
import type { TavilyService } from "../tavily/service.js";
import type { WebReaderService } from "../web-reader/service.js";
import type { VisionService } from "../vision/service.js";
import type { MineruService } from "../mineru/service.js";
import type { GitAccessService } from "../git/index.js";
import type { RelationshipService } from "../relationship/service.js";
import type { WorldService } from "../world/service.js";
import type { WorldAutonomyCoordinator } from "../world/coordinator.js";
import type { CharacterInteractionCoordinator } from "../world/character-interaction-coordinator.js";
import type { InteractionService } from "../interaction/service.js";
import type { CharacterCapabilityService } from "../organization/service.js";
import type { CharacterAgentSkillPackageService } from "../modules/character-skill-packages.js";
import type { MemoryLifecycleService } from "../memory-coordinator/lifecycle.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import type { AgentPermissions } from "../modules/types.js";
import type { SubagentJobDetail, SubagentJobSummary } from "../modules/subagent-jobs.js";
import type { ScopedWorkspace } from "../workspace/scope.js";
import {
  gitMcpModuleId,
  interactionStateMcpModuleId,
  memoryCoordinatorMcpModuleId,
  mineruMcpModuleId,
  relationshipStateMcpModuleId,
  scheduleMcpModuleId,
  subagentMcpModuleId,
  tavilySearchMcpModuleId,
  userProfileMcpModuleId,
  visionMcpModuleId,
  webReaderMcpModuleId,
  worldStateMcpModuleId,
} from "../modules/catalog.js";
import {
  createCharacterSkillMcpBridge,
  createCharacterSoulMcpBridge,
  createGitMcpBridge,
  createInteractionMcpBridge,
  createMemoryMcpBridge,
  createMineruMcpBridge,
  createRelationshipMcpBridge,
  createScheduleMcpBridge,
  createSubagentMcpBridge,
  createTavilyMcpBridge,
  createUserProfileMcpBridge,
  createVisionMcpBridge,
  createWebReaderMcpBridge,
  createWorldMcpBridge,
  type SubagentRequest,
  type SubagentResult,
} from "../mcp/index.js";
import {
  beginCharacterSkillRemoteInstall,
  finishCharacterSkillRemoteInstall,
} from "../modules/character-skill-turn-policy.js";
import type {
  SessionCapability,
  SessionCapabilityDescriptor,
} from "./session-capability.js";

export const builtinSessionCapabilityDescriptors = Object.freeze({
  schedule: descriptor("builtin:mcp:schedule", 100, scheduleMcpModuleId),
  userProfile: descriptor("builtin:mcp:user-profile", 200, userProfileMcpModuleId),
  tavilySearch: descriptor("builtin:mcp:tavily-search", 300, tavilySearchMcpModuleId),
  webReader: descriptor("builtin:mcp:web-reader", 400, webReaderMcpModuleId),
  vision: descriptor("builtin:mcp:vision", 500, visionMcpModuleId),
  mineru: descriptor("builtin:mcp:mineru", 600, mineruMcpModuleId),
  git: descriptor("builtin:mcp:git", 700, gitMcpModuleId),
  subagent: descriptor("builtin:mcp:subagent", 800, subagentMcpModuleId),
  relationshipState: descriptor(
    "builtin:mcp:relationship-state",
    900,
    relationshipStateMcpModuleId,
  ),
  worldState: descriptor("builtin:mcp:world-state", 1_000, worldStateMcpModuleId),
  interactionState: descriptor(
    "builtin:mcp:interaction-state",
    1_100,
    interactionStateMcpModuleId,
  ),
  characterSkill: descriptor("builtin:mcp:character-skill", 1_200),
  memoryCoordinator: descriptor(
    "builtin:mcp:memory-coordinator",
    1_300,
    memoryCoordinatorMcpModuleId,
  ),
  characterSoul: descriptor("builtin:mcp:character-soul", 1_400),
});

export const builtinSessionCapabilityDescriptorList: readonly SessionCapabilityDescriptor[] =
  Object.freeze(Object.values(builtinSessionCapabilityDescriptors));

export type BuiltinMcpCapabilityOptions = Readonly<{
  store: CompanionStore;
  clock: Clock;
  scheduleService: ScheduleService;
  rpService: RpService;
  profileService: UserProfileService;
  tavilyService: TavilyService;
  webReaderService: WebReaderService;
  visionService: VisionService;
  mineruService: MineruService;
  gitService?: GitAccessService;
  relationshipService: RelationshipService;
  worldService: WorldService;
  worldCoordinator: WorldAutonomyCoordinator;
  characterInteractionCoordinator: CharacterInteractionCoordinator;
  interactionService: InteractionService;
  characterCapabilities?: CharacterCapabilityService;
  characterSkillPackages?: CharacterAgentSkillPackageService;
  memoryLifecycle: MemoryLifecycleService;
  moduleCatalog: AgentModuleCatalog;
  metadata: ConversationMetadata;
  workspace: ScopedWorkspace;
  permissions: Readonly<AgentPermissions>;
  toolState: CompanionToolRuntimeState;
  incognitoChild: boolean;
  subagentRuntimeTimeoutMs: () => number;
  runSubagent: (request: SubagentRequest, signal?: AbortSignal) => Promise<SubagentResult>;
  startSubagentJob: (request: SubagentRequest) => SubagentJobSummary;
  interruptSubagentJob: (jobId: string) => Promise<SubagentJobSummary>;
  sendSubagentMessage: (jobId: string, prompt: string) => SubagentJobSummary;
  listSubagentJobs: (limit: number) => readonly SubagentJobSummary[];
  getSubagentJob: (jobId: string) => SubagentJobDetail | undefined;
  requestCharacterSkillCapabilityRefresh: () => void;
}>;

/**
 * Built-in adapters for the current MCP surface. Keeping these definitions in
 * one composition module lets PiSessionRuntime depend on a registry instead of
 * every individual MCP bridge. Later slices can move each definition beside
 * its module manifest without changing the session assembly contract.
 */
export function createBuiltinMcpCapabilities(
  options: BuiltinMcpCapabilityOptions,
): readonly SessionCapability[] {
  const {
    metadata,
    workspace,
    permissions,
    toolState,
    moduleCatalog,
    incognitoChild,
  } = options;
  const isSecret = metadata.conversationSpace === "secret";
  const actions = () => toolState.actions;
  const currentUserText = () => toolState.currentUserText;

  return [
    defineCapability(builtinSessionCapabilityDescriptors.schedule, async (context) => {
      if (incognitoChild || isSecret) return undefined;
      return createScheduleMcpBridge({
        scheduleService: options.scheduleService,
        store: options.store,
        clock: options.clock,
        sessionId: metadata.id,
        mode: metadata.mode,
        characterId: metadata.characterId,
        worldCoordinator: metadata.mode === "sms" &&
            Boolean(metadata.characterId) &&
            context.moduleEnabled(worldStateMcpModuleId) &&
            Boolean(metadata.characterId && options.worldService.repository.getMembership(metadata.characterId))
          ? options.worldCoordinator
          : undefined,
        currentUserText,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.userProfile, async () => {
      if (incognitoChild || isSecret) return undefined;
      return createUserProfileMcpBridge({
        profileService: options.profileService,
        store: options.store,
        sessionId: metadata.id,
        actions,
        allowWrite: permissions.userProfileWriteEnabled,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.tavilySearch, async () => {
      if (
        incognitoChild ||
        !options.tavilyService.isConfigured()
      ) return undefined;
      return createTavilyMcpBridge({
        tavilyService: options.tavilyService,
        store: options.store,
        sessionId: metadata.id,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.webReader, async () => {
      if (incognitoChild) return undefined;
      return createWebReaderMcpBridge({
        webReaderService: options.webReaderService,
        store: options.store,
        sessionId: metadata.id,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.vision, async () => {
      if (
        incognitoChild ||
        !options.visionService.isConfigured() ||
        options.visionService.getConfig().mode === "off"
      ) return undefined;
      return createVisionMcpBridge({
        visionService: options.visionService,
        workspaceFiles: workspace.files,
        cacheNamespace: workspace.cacheNamespace,
        store: options.store,
        sessionId: metadata.id,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.mineru, async () => {
      if (
        incognitoChild ||
        !options.mineruService.isConfigured() ||
        permissions.workspaceAccess === "off"
      ) return undefined;
      return createMineruMcpBridge({
        mineruService: options.mineruService,
        workspaceFiles: workspace.files,
        cacheNamespace: workspace.cacheNamespace,
        store: options.store,
        sessionId: metadata.id,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.git, async () => {
      if (
        incognitoChild ||
        isSecret ||
        !metadata.characterId ||
        !options.gitService?.isConfigured() ||
        permissions.workspaceAccess !== "read_write"
      ) return undefined;
      const character = options.rpService.getCharacter(metadata.characterId);
      return createGitMcpBridge({
        gitService: options.gitService,
        store: options.store,
        sessionId: metadata.id,
        characterId: metadata.characterId,
        characterName: character.name,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.subagent, async () => {
      if (incognitoChild) return undefined;
      return createSubagentMcpBridge({
        store: options.store,
        sessionId: metadata.id,
        runtimeTimeoutMs: options.subagentRuntimeTimeoutMs(),
        actions,
        run: options.runSubagent,
        startJob: options.startSubagentJob,
        interruptJob: options.interruptSubagentJob,
        sendMessage: options.sendSubagentMessage,
        listJobs: options.listSubagentJobs,
        getJob: options.getSubagentJob,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.relationshipState, async () => {
      if (
        incognitoChild ||
        isSecret ||
        !metadata.characterId
      ) return undefined;
      return createRelationshipMcpBridge({
        relationshipService: options.relationshipService,
        sessionId: metadata.id,
        characterId: metadata.characterId,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.worldState, async () => {
      if (
        incognitoChild ||
        isSecret ||
        metadata.mode !== "sms" ||
        !metadata.characterId ||
        !options.worldService.repository.getMembership(metadata.characterId)
      ) return undefined;
      return createWorldMcpBridge({
        worldService: options.worldService,
        coordinator: options.worldCoordinator,
        interactionCoordinator: options.characterInteractionCoordinator,
        store: options.store,
        sessionId: metadata.id,
        characterId: metadata.characterId,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.interactionState, async () => {
      if (
        metadata.mode !== "sms" ||
        !metadata.characterId
      ) return undefined;
      return createInteractionMcpBridge({
        interactionService: options.interactionService,
        store: options.store,
        sessionId: metadata.id,
        characterId: metadata.characterId,
        scope: isSecret
          ? {
              conversationSpace: "secret",
              secretOwnerCharacterId: metadata.characterId,
            }
          : { conversationSpace: "normal" },
        currentUserText,
        actions,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.characterSkill, async () => {
      if (
        incognitoChild ||
        !metadata.characterId ||
        !options.characterCapabilities ||
        !options.characterSkillPackages ||
        !permissions.characterSkillManageEnabled
      ) return undefined;
      return createCharacterSkillMcpBridge({
        characterCapabilities: options.characterCapabilities,
        privatePackageService: options.characterSkillPackages,
        moduleCatalog,
        store: options.store,
        sessionId: metadata.id,
        characterId: metadata.characterId,
        conversationSpace: metadata.conversationSpace,
        actions,
        beginRemoteInstall: (sourceUrl) => {
          beginCharacterSkillRemoteInstall(toolState, sourceUrl);
        },
        finishRemoteInstall: (sourceUrl, success) => {
          finishCharacterSkillRemoteInstall(toolState, sourceUrl, success);
        },
        requestCapabilityRefresh: options.requestCharacterSkillCapabilityRefresh,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.memoryCoordinator, async () => {
      if (incognitoChild) return undefined;
      const realm = metadata.mode === "rp" ? "roleplay" as const : "reality" as const;
      if (realm !== "reality" && !metadata.characterId) return undefined;
      return createMemoryMcpBridge({
        lifecycle: options.memoryLifecycle,
        store: options.store,
        sessionId: metadata.id,
        conversationSpace: metadata.conversationSpace,
        ...(isSecret && metadata.characterId
          ? { secretOwnerCharacterId: metadata.characterId }
          : {}),
        realm,
        ...(metadata.characterId ? { characterId: metadata.characterId } : {}),
        actions,
        allowPropose: realm === "reality"
          ? permissions.realityMemoryWriteEnabled
          : permissions.characterMemoryWriteEnabled,
      });
    }),
    defineCapability(builtinSessionCapabilityDescriptors.characterSoul, async () => {
      if (
        incognitoChild ||
        isSecret ||
        !metadata.characterId ||
        !permissions.characterSoulWriteEnabled
      ) return undefined;
      return createCharacterSoulMcpBridge({
        rpService: options.rpService,
        store: options.store,
        sessionId: metadata.id,
        characterId: metadata.characterId,
        actions,
      });
    }),
  ];
}

function defineCapability(
  capability: SessionCapabilityDescriptor,
  mount: SessionCapability["mount"],
): SessionCapability {
  return Object.freeze({
    ...capability,
    mount,
  });
}

function descriptor(
  id: string,
  order: number,
  moduleId?: string,
): SessionCapabilityDescriptor {
  return Object.freeze({
    id,
    order,
    ...(moduleId === undefined ? {} : { moduleId }),
  });
}
