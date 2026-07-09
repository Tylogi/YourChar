import type { AgentContext, AgentMessage } from "../harness/index.js";
import { runAgentLoop, textMessage, textOf } from "../harness/index.js";
import { companionModel } from "./model.js";
import { CompanionStore, type CompanionStoreOptions } from "./store.js";
import { createCompanionTools, getActionBucket } from "./tools.js";
import type {
  MessageRequest,
  MessageResponse,
  Mode,
  ModelApiConfigPatch,
  SessionRecord,
} from "./types.js";

type NormalizedMessageRequest = MessageRequest & {
  mode: Mode;
  text: string;
  timezone: string;
};

export type CompanionKernelOptions = CompanionStoreOptions & {
  store?: CompanionStore;
};

export class CompanionKernel {
  readonly store: CompanionStore;

  constructor(options: CompanionKernelOptions | CompanionStore = {}) {
    this.store = options instanceof CompanionStore ? options : options.store ?? new CompanionStore(options);
  }

  async sendMessage(sessionId: string, request: MessageRequest): Promise<MessageResponse> {
    const normalized = normalizeRequest(request);
    const session = this.store.getSession(sessionId);
    const messageCountBefore = session.messages.length;
    const prompt = textMessage("user", normalized.text, {
      sessionId,
      mode: normalized.mode,
      characterId: normalized.characterId,
    });
    const state: Record<string, unknown> = {
      store: this.store,
      sessionId,
      mode: normalized.mode,
      characterId: normalized.characterId,
      request: normalized,
      actions: [],
    };
    const context: AgentContext = {
      systemPrompt: systemPromptFor(normalized.mode),
      messages: session.messages,
      tools: createCompanionTools(),
      state,
    };

    const result = await runAgentLoop({
      prompts: [prompt],
      context,
      config: {
        model: companionModel,
        toolExecution: "sequential",
        maxTurns: 6,
      },
    });

    this.store.appendMessages(sessionId, result.messages);
    const reply = finalAssistantText(result.messages);
    const actions = getActionBucket(state);
    this.store.addContextLog({
      sessionId,
      mode: normalized.mode,
      requestText: normalized.text,
      systemPrompt: context.systemPrompt,
      messageCountBefore,
      toolNames: context.tools.map((tool) => tool.name),
      reply,
      actions,
      events: result.events,
    });
    return {
      reply,
      actions,
      events: result.events,
    };
  }

  getSession(sessionId: string): SessionRecord {
    return this.store.getSession(sessionId);
  }

  recentContextLogs(limit?: number) {
    return this.store.recentContextLogs(limit);
  }

  getModelApiConfig() {
    return this.store.getModelApiConfig();
  }

  patchModelApiConfig(patch: ModelApiConfigPatch) {
    return this.store.patchModelApiConfig(patch);
  }
}

function normalizeRequest(request: MessageRequest): NormalizedMessageRequest {
  return {
    ...request,
    mode: request.mode ?? "sms",
    text: request.text,
    timezone: request.timezone ?? "Asia/Shanghai",
  };
}

function systemPromptFor(mode: Mode): string {
  if (mode === "rp") {
    return "You are a life-narrative companion. Third-person narration; real tools remain real-world state.";
  }
  return "You are a direct-message companion. First person, concise, practical.";
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      const text = textOf(message).trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}
