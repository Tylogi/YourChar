import type { AgentTool } from "../harness/index.js";
import type { CompanionStore } from "./store.js";
import type { Memory, Mode, Reminder } from "./types.js";

type RuntimeState = {
  store: CompanionStore;
  sessionId: string;
  mode: Mode;
  characterId?: string;
};

export function createCompanionTools(): AgentTool<any, any>[] {
  return [createReminderTool(), writeMemoryTool()];
}

function createReminderTool(): AgentTool<{ title: string; remindAt: string; timezone: string }, Reminder> {
  return {
    name: "create_reminder",
    description: "Create a real-world reminder in the shared companion timeline.",
    executionMode: "sequential",
    validate(input) {
      const title = requiredString(input.title, "title");
      const remindAt = requiredString(input.remindAt, "remindAt");
      const timezone = typeof input.timezone === "string" ? input.timezone : "Asia/Shanghai";
      return { title, remindAt, timezone };
    },
    async execute(input, context) {
      const state = context.state as RuntimeState;
      const reminder = state.store.createReminder({
        ...input,
        metadata: {
          sessionId: state.sessionId,
          mode: state.mode,
          characterId: state.characterId,
        },
      });
      const action = state.store.addAction("create_reminder", "completed", {
        reminderId: reminder.id,
        title: reminder.title,
        remindAt: reminder.remindAt,
      });
      const actions = getActionBucket(context.state);
      actions.push(action);
      return {
        content: reminder,
        metadata: { action },
      };
    },
  };
}

function writeMemoryTool(): AgentTool<{ content: string; tags: string[] }, Memory> {
  return {
    name: "write_memory",
    description: "Write companion memory. RP memory is not automatically real-world state.",
    executionMode: "sequential",
    validate(input) {
      return {
        content: requiredString(input.content, "content"),
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      };
    },
    async execute(input, context) {
      const state = context.state as RuntimeState;
      const memory = state.store.addMemory({
        mode: state.mode,
        sessionId: state.sessionId,
        characterId: state.characterId,
        content: input.content,
        tags: input.tags,
      });
      const action = state.store.addAction("write_memory", "completed", {
        memoryId: memory.id,
        mode: memory.mode,
        tags: memory.tags,
      });
      getActionBucket(context.state).push(action);
      return {
        content: memory,
        metadata: { action },
      };
    },
  };
}

export function getActionBucket(state: Record<string, unknown>) {
  const existing = state.actions;
  if (Array.isArray(existing)) {
    return existing as ReturnType<CompanionStore["addAction"]>[];
  }
  const actions: ReturnType<CompanionStore["addAction"]>[] = [];
  state.actions = actions;
  return actions;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
