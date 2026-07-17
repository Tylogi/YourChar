import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { SeededIdGenerator } from "../app/id-generator.js";
import { VirtualClock } from "../app/clock.js";
import { CompanionKernel } from "../domain/kernel.js";
import { CaptureNotificationSink } from "../notifications/sink.js";
import type { PiModelResolver } from "../pi/session-runtime.js";
import type { MemoryExtractor } from "../memory-coordinator/types.js";
import type { RelationshipExtractor } from "../relationship/types.js";
import type { VisionService } from "../vision/service.js";

export type ScriptedModelResponse =
  | {
      kind: "assistant_text";
      text: string;
      usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown>; id?: string }
  | { kind: "provider_error"; message: string }
  | { kind: "stream_chunks"; chunks: string[] };

export type CapturedModelRequest = {
  sequence: number;
  systemPrompt: string;
  messages: unknown[];
  toolNames: string[];
  providerPayload: { messages: unknown[]; tools: unknown[] };
};

export type CreateTestRuntimeOptions = {
  stateDir?: string | false;
  now?: string;
  timezone?: string;
  seed?: string;
  workspaceDir?: string;
  tavilyBaseUrl?: string;
  memoryExtractor?: MemoryExtractor;
  relationshipExtractor?: RelationshipExtractor;
  visionService?: VisionService;
};

export class ScriptedModelController {
  readonly requests: CapturedModelRequest[] = [];
  readonly resolver: PiModelResolver;
  private readonly core;
  private readonly registered = new WeakSet<object>();
  private toolCallSequence = 0;

  constructor(id: string) {
    const provider = `rp-test-${id}`;
    this.core = createFauxCore({
      api: provider,
      provider,
      models: [{ id: "scripted-model", name: "Scripted Model" }],
    });
    this.resolver = ({ authStorage, modelRegistry }) => {
      if (!this.registered.has(modelRegistry)) {
        modelRegistry.registerProvider(provider, {
          api: this.core.api as Api,
          streamSimple: this.core.streamSimple as never,
        });
        this.registered.add(modelRegistry);
      }
      authStorage.setRuntimeApiKey(provider, "unused");
      return this.core.getModel() as unknown as Model<Api>;
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
      this.captureRequest(context, providerPayload);
      if (response.kind === "assistant_text") {
        const message = fauxAssistantMessage(response.text);
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
  ): void {
    this.requests.push({
      sequence: this.requests.length + 1,
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages.map(canonicalUnknownMessage),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
      providerPayload: {
        messages: providerPayload.messages.map(canonicalUnknownMessage),
        tools: jsonClone(providerPayload.tools),
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
    this.model = new ScriptedModelController(id);
    this.kernel = new CompanionKernel({
      stateDir: options.stateDir ?? false,
      clock: this.clock,
      idGenerator: new SeededIdGenerator(options.seed ?? id),
      modelResolver: this.model.resolver,
      notificationSink: this.notificationSink,
      startScheduler: false,
      quietHours: false,
      workspaceDir: options.workspaceDir,
      tavilyBaseUrl: options.tavilyBaseUrl,
      visionService: options.visionService,
      memoryExtractor: options.memoryExtractor ?? (async () => ({ candidates: [] })),
      relationshipExtractor: options.relationshipExtractor ?? (async () => ({ significant: false, confidence: 0 })),
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

  async snapshot() {
    const sessions = await this.kernel.listSessions();
    return {
      now: this.clock.now().toISOString(),
      timezone: this.timezone,
      conversations: this.kernel.sessionRuntime.getConversationMetadata().map((conversation) => ({
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
      roleSessions: this.kernel.rpService.listRoleSessions(),
      scenes: this.kernel.rpService.listScenes(),
      memories: this.kernel.rpService.listAllMemories().sort(byId),
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
