import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Api,
  type Context,
  type FauxResponseFactory,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SeededIdGenerator } from "../app/id-generator.js";
import { VirtualClock } from "../app/clock.js";
import {
  CompanionKernel,
  type CharacterCollaborationReporter,
  type ConversationWakeComposer,
} from "../domain/kernel.js";
import { CaptureNotificationSink } from "../notifications/sink.js";
import type { ReminderMessageComposer } from "../notifications/composer.js";
import type { ConversationCheckpointSummarizer } from "../pi/conversation-checkpoint.js";
import type {
  ConversationLifecycleThresholds,
  PiModelResolver,
} from "../pi/session-runtime.js";
import type { SessionCapability } from "../pi/session-capability.js";
import type {
  AgentCapabilityPackage,
  AgentRuntimeProfileDefinition,
} from "../pi/runtime-configuration.js";
import type { MemoryExtractor } from "../memory-coordinator/types.js";
import type { RelationshipExtractor } from "../relationship/types.js";
import type { VisionService } from "../vision/service.js";
import type { DocumentConversionService } from "../document/service.js";
import type { MineruService } from "../mineru/service.js";
import type { GitAccessService } from "../git/index.js";
import type { WebReaderService } from "../web-reader/service.js";
import type {
  CharacterInteractionActor,
  CharacterInteractionSceneComposer,
  CharacterInteractionSceneComposerInput,
  ProactiveMessenger,
  WorldPlanner,
} from "../world/types.js";
import type { PrivateInboxCoordinatorOptions } from "../inbox/index.js";
import type { PostTurnAnalyzer } from "../post-turn/index.js";
import type { CharacterSkillReflector } from "../organization/index.js";
import type { ImGateway } from "../im/index.js";
import type { DiaryGenerator } from "../diary/types.js";

export type ScriptedModelResponse = (
  | {
      kind: "assistant_text";
      text: string;
      thinking?: string;
      stopReason?: "stop" | "length";
      usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown>; id?: string }
  | {
      kind: "tool_calls";
      calls: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
    }
  | { kind: "provider_error"; message: string }
  | { kind: "stream_chunks"; chunks: string[] }
) & { delayMs?: number };

export type CapturedModelRequest = {
  sequence: number;
  systemPrompt: string;
  messages: unknown[];
  toolNames: string[];
  /** Effective timeout passed by Pi to the registered provider implementation. */
  providerTimeoutMs: number | undefined;
  providerPayload: { messages: unknown[]; tools: unknown[]; [key: string]: unknown };
};

export type CreateTestRuntimeOptions = {
  stateDir?: string | false;
  now?: string;
  timezone?: string;
  seed?: string;
  workspaceDir?: string;
  tavilyBaseUrl?: string;
  memoryExtractor?: MemoryExtractor;
  conversationCheckpointSummarizer?: ConversationCheckpointSummarizer | false;
  relationshipExtractor?: RelationshipExtractor;
  postTurnAnalyzer?: PostTurnAnalyzer;
  worldPlanner?: WorldPlanner;
  diaryGenerator?: DiaryGenerator;
  worldMessenger?: ProactiveMessenger;
  characterInteractionActor?: CharacterInteractionActor;
  characterInteractionSceneComposer?: CharacterInteractionSceneComposer | false;
  characterCollaborationReporter?: CharacterCollaborationReporter;
  conversationWakeComposer?: ConversationWakeComposer;
  conversationWakeRetryDelaysMs?: readonly number[];
  characterSkillReflector?: CharacterSkillReflector | false;
  visionService?: VisionService;
  documentService?: DocumentConversionService;
  mineruService?: MineruService;
  gitService?: GitAccessService;
  webReaderService?: WebReaderService;
  conversationLifecycleThresholds?: Partial<ConversationLifecycleThresholds>;
  subagentTimeoutMs?: number;
  additionalSessionCapabilities?: readonly SessionCapability[];
  agentCapabilityPackages?: readonly AgentCapabilityPackage[];
  agentRuntimeProfiles?: readonly AgentRuntimeProfileDefinition[];
  activeAgentRuntimeProfileId?: string;
  /** Keep the scripted Pi model's own window aligned with a small configured profile in budget tests. */
  scriptedModelContextWindowTokens?: number;
  privateInboxOptions?: PrivateInboxCoordinatorOptions;
  startPrivateInboxCoordinator?: boolean;
  imGateway?: ImGateway | false;
  reminderMessageComposer?: ReminderMessageComposer | false;
};

export class ScriptedModelController {
  readonly requests: CapturedModelRequest[] = [];
  readonly resolver: PiModelResolver;
  private readonly core;
  private readonly registered = new WeakSet<object>();
  private toolCallSequence = 0;

  constructor(id: string, options: { contextWindowTokens?: number } = {}) {
    const provider = `rp-test-${id}`;
    this.core = createFauxCore({
      api: provider,
      provider,
      models: [{
        id: "scripted-model",
        name: "Scripted Model",
        ...(options.contextWindowTokens === undefined
          ? {}
          : { contextWindow: options.contextWindowTokens }),
      }],
    });
    this.resolver = ({ modelRuntime }) => {
      const model = this.core.getModel() as unknown as Model<Api> | undefined;
      if (!model) return undefined;
      if (!this.registered.has(modelRuntime)) {
        modelRuntime.registerProvider(provider, {
          name: "Scripted test provider",
          api: this.core.api as Api,
          apiKey: "unused",
          streamSimple: this.core.streamSimple as never,
          models: [model],
        });
        this.registered.add(modelRuntime);
      }
      return modelRuntime.getModel(provider, model.id) ?? model;
    };
  }

  enqueue(responses: ScriptedModelResponse[]): void {
    this.core.appendResponses(responses.map((response) => this.createResponse(response)));
  }

  pendingCount(): number {
    return this.core.getPendingResponseCount();
  }

  private createResponse(response: ScriptedModelResponse): FauxResponseFactory {
    return async (context, options, _state, model) => {
      const providerPayload = {
        messages: [
          ...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []),
          ...context.messages,
        ],
        tools: context.tools ?? [],
      };
      await options?.onPayload?.(providerPayload, model as Model<Api>);
      this.captureRequest(context, providerPayload, options?.timeoutMs);
      if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      if (response.kind === "assistant_text") {
        const content = response.thinking === undefined
          ? response.text
          : [fauxThinking(response.thinking), fauxText(response.text)];
        const message = fauxAssistantMessage(
          content,
          response.stopReason ? { stopReason: response.stopReason } : {},
        );
        if (response.usage) {
          message.usage = {
            input: response.usage.input,
            output: response.usage.output,
            cacheRead: response.usage.cacheRead ?? 0,
            cacheWrite: response.usage.cacheWrite ?? 0,
            totalTokens: response.usage.input + response.usage.output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        return message;
      }
      if (response.kind === "stream_chunks") {
        return fauxAssistantMessage(response.chunks.join(""));
      }
      if (response.kind === "provider_error") {
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: response.message,
        });
      }
      if (response.kind === "tool_calls") {
        return fauxAssistantMessage(
          response.calls.map((call) => {
            this.toolCallSequence += 1;
            return fauxToolCall(call.name, call.arguments, {
              id: call.id ?? `test-tool-${this.toolCallSequence}`,
            });
          }),
          { stopReason: "toolUse" },
        );
      }
      this.toolCallSequence += 1;
      return fauxAssistantMessage(
        fauxToolCall(response.name, response.arguments, {
          id: response.id ?? `test-tool-${this.toolCallSequence}`,
        }),
        { stopReason: "toolUse" },
      );
    };
  }

  private captureRequest(
    context: Context,
    providerPayload: { messages: unknown[]; tools: unknown[] },
    providerTimeoutMs: number | undefined,
  ): void {
    this.requests.push({
      sequence: this.requests.length + 1,
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages.map(canonicalUnknownMessage),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
      providerTimeoutMs,
      providerPayload: {
        ...jsonClone(providerPayload),
        messages: providerPayload.messages.map(canonicalUnknownMessage),
        tools: Array.isArray(providerPayload.tools) ? jsonClone(providerPayload.tools) : [],
      },
    });
  }
}

export class TestRuntime {
  readonly clock: VirtualClock;
  readonly timezone: string;
  readonly model: ScriptedModelController;
  readonly notificationSink = new CaptureNotificationSink();
  readonly kernel: CompanionKernel;

  constructor(readonly id: string, options: CreateTestRuntimeOptions = {}) {
    this.clock = new VirtualClock(options.now ?? "2026-01-01T00:00:00.000Z");
    this.timezone = options.timezone ?? "Asia/Shanghai";
    this.model = new ScriptedModelController(id, {
      contextWindowTokens: options.scriptedModelContextWindowTokens,
    });
    this.kernel = new CompanionKernel({
      stateDir: options.stateDir ?? false,
      clock: this.clock,
      idGenerator: new SeededIdGenerator(options.seed ?? id),
      modelResolver: this.model.resolver,
      notificationSink: this.notificationSink,
      reminderMessageComposer: options.reminderMessageComposer ?? false,
      conversationCheckpointSummarizer: options.conversationCheckpointSummarizer ?? false,
      startScheduler: false,
      quietHours: false,
      workspaceDir: options.workspaceDir,
      tavilyBaseUrl: options.tavilyBaseUrl,
      visionService: options.visionService,
      documentService: options.documentService,
      mineruService: options.mineruService,
      gitService: options.gitService,
      webReaderService: options.webReaderService,
      memoryExtractor: options.memoryExtractor ?? (async () => ({ candidates: [] })),
      postTurnAnalyzer: options.postTurnAnalyzer,
      relationshipExtractor: options.postTurnAnalyzer
        ? undefined
        : options.relationshipExtractor ?? (async () => ({ significant: false, confidence: 0 })),
      worldPlanner: options.worldPlanner,
      diaryGenerator: options.diaryGenerator,
      worldMessenger: options.worldMessenger,
      characterInteractionActor: options.characterInteractionActor,
      ...(options.characterInteractionSceneComposer === false
        ? {}
        : {
            characterInteractionSceneComposer:
              options.characterInteractionSceneComposer ?? deterministicInteractionScene,
          }),
      characterCollaborationReporter: options.characterCollaborationReporter,
      conversationWakeComposer: options.conversationWakeComposer ??
        (async () => "我睡醒了，现在又可以继续陪你啦。"),
      conversationWakeRetryDelaysMs: options.conversationWakeRetryDelaysMs,
      characterSkillReflector: options.characterSkillReflector ?? false,
      conversationLifecycleThresholds: options.conversationLifecycleThresholds,
      subagentTimeoutMs: options.subagentTimeoutMs,
      additionalSessionCapabilities: options.additionalSessionCapabilities,
      agentCapabilityPackages: options.agentCapabilityPackages,
      agentRuntimeProfiles: options.agentRuntimeProfiles,
      activeAgentRuntimeProfileId: options.activeAgentRuntimeProfileId,
      privateInboxOptions: options.privateInboxOptions,
      startPrivateInboxCoordinator: options.startPrivateInboxCoordinator,
      imGateway: options.imGateway ?? false,
    });
    this.kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: "http://test.invalid/v1",
      model: "scripted-model",
      temperature: 0,
    });
  }

  get notifications() {
    return this.notificationSink.deliveries;
  }

  async schedulerTick() {
    return this.kernel.scheduler.tick();
  }

  async worldTick(characterId?: string) {
    return this.kernel.tickWorldAutonomy(characterId);
  }

  async snapshot() {
    const sessions = await this.kernel.listSessions();
    const conversations = this.kernel.sessionRuntime.getConversationMetadata();
    const interactionStates = conversations.flatMap((conversation) => {
      if (!conversation.characterId) return [];
      const state = this.kernel.interactionService.get(
        conversation.id,
        conversation.conversationSpace === "secret"
          ? {
              conversationSpace: "secret",
              secretOwnerCharacterId: conversation.characterId,
            }
          : { conversationSpace: "normal" },
      );
      return state ? [state] : [];
    });
    return {
      now: this.clock.now().toISOString(),
      timezone: this.timezone,
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        mode: conversation.mode,
        characterId: conversation.characterId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages.map(canonicalMessage),
      })),
      scheduleItems: this.kernel.listScheduleItems(),
      reminderOccurrences: this.kernel.listReminderOccurrences(),
      characters: this.kernel.listCharacters(),
      worlds: this.kernel.listWorlds(true),
      characterLives: this.kernel.listCharacters().map((character) =>
        this.kernel.getCharacterLife(character.id)),
      roleSessions: this.kernel.rpService.listRoleSessions(),
      scenes: this.kernel.rpService.listScenes(),
      interactionStates,
      interactionEvents: interactionStates.flatMap((state) =>
        this.kernel.interactionService.listEvents(
          state.sessionId,
          state.conversationSpace === "secret"
            ? {
                conversationSpace: "secret",
                secretOwnerCharacterId: state.secretOwnerCharacterId,
              }
            : { conversationSpace: "normal" },
          200,
        )),
      memories: this.kernel.rpService.listAllMemories().sort(byId),
      userInsights: this.kernel.getUserInsightStatus(200),
      pendingRealMutations: this.kernel.rpService.repository.listPendingMutations(),
      actions: [...this.kernel.store.actions].sort(byId),
      notifications: [...this.notifications],
      notificationOutbox: this.kernel.listNotificationHistory(),
      modelRequests: [...this.model.requests],
      pendingModelResponses: this.model.pendingCount(),
    };
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

export class TestRunRegistry {
  private sequence = 0;
  private readonly runs = new Map<string, TestRuntime>();

  create(options: CreateTestRuntimeOptions = {}): TestRuntime {
    this.sequence += 1;
    const id = `run_${String(this.sequence).padStart(4, "0")}`;
    const runtime = new TestRuntime(id, options);
    this.runs.set(id, runtime);
    return runtime;
  }

  get(runId: string): TestRuntime | undefined {
    return this.runs.get(runId);
  }

  delete(runId: string): boolean {
    const runtime = this.runs.get(runId);
    if (!runtime) {
      return false;
    }
    runtime.dispose();
    return this.runs.delete(runId);
  }

  dispose(): void {
    for (const runtime of this.runs.values()) {
      runtime.dispose();
    }
    this.runs.clear();
  }
}

export function createTestRuntime(options: CreateTestRuntimeOptions = {}): TestRuntime {
  return new TestRuntime("in-process", options);
}

async function deterministicInteractionScene(
  input: CharacterInteractionSceneComposerInput,
) {
  const sourceContribution = input.messages.find((message) =>
    message.senderCharacterId === input.source.characterId)?.content ?? "";
  const targetContribution = [...input.messages].reverse().find((message) =>
    message.senderCharacterId === input.target.characterId)?.content ?? "";
  const place = input.source.place?.name ?? input.target.place?.name ?? input.world.name;
  return {
    narrativeText: [
      `在${place}，${input.source.name}先向${input.target.name}开了口。`,
      sourceContribution ? `${input.source.name}说：“${sourceContribution}”` : "",
      targetContribution
        ? `${input.target.name}听完后答道：“${targetContribution}”`
        : `${input.target.name}安静地听完了。`,
    ].filter(Boolean).join("\n\n"),
    eventSummary: input.episode.kind === "collaboration"
      ? `${input.source.name}向${input.target.name}提出协作请求，${input.target.name}给出了回应。`
      : `${input.source.name}与${input.target.name}完成了一次私下互动。`,
    sourcePerspectiveSummary:
      `我主动找${input.target.name}进行了这次互动，并记住了对方如何回应。`,
    targetPerspectiveSummary:
      `${input.source.name}主动来找我，我按自己的判断作出了回应。`,
  };
}

function canonicalMessage(message: AgentMessage) {
  const output: Record<string, unknown> = { role: message.role };
  if ("content" in message) output.content = jsonClone(message.content);
  if ("stopReason" in message) output.stopReason = message.stopReason;
  if ("errorMessage" in message && message.errorMessage) output.errorMessage = message.errorMessage;
  return output;
}

function canonicalUnknownMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonClone(message);
  }
  const clone = jsonClone(message) as Record<string, unknown>;
  delete clone.timestamp;
  return clone;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
