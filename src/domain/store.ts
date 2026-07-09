import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../harness/index.js";
import type { ActionRecord, Memory, Mode, Reminder, SessionRecord } from "./types.js";

export class CompanionStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly reminders = new Map<string, Reminder>();
  readonly memories: Memory[] = [];
  readonly actions: ActionRecord[] = [];

  getSession(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created: SessionRecord = {
      id: sessionId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  appendMessages(sessionId: string, messages: AgentMessage[]): void {
    const session = this.getSession(sessionId);
    session.messages.push(...messages);
    session.updatedAt = new Date().toISOString();
  }

  createReminder(input: {
    title: string;
    remindAt: string;
    timezone: string;
    metadata?: Record<string, unknown>;
  }): Reminder {
    const now = new Date().toISOString();
    const reminder: Reminder = {
      id: randomUUID(),
      title: input.title,
      remindAt: input.remindAt,
      timezone: input.timezone,
      status: "scheduled",
      metadata: input.metadata ?? {},
      createdAt: now,
    };
    this.reminders.set(reminder.id, reminder);
    return reminder;
  }

  addMemory(input: {
    mode: Mode;
    sessionId: string;
    characterId?: string;
    content: string;
    tags?: string[];
  }): Memory {
    const memory: Memory = {
      id: randomUUID(),
      mode: input.mode,
      sessionId: input.sessionId,
      characterId: input.characterId,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    this.memories.push(memory);
    return memory;
  }

  addAction(actionType: string, status: ActionRecord["status"], payload: Record<string, unknown>): ActionRecord {
    const action: ActionRecord = {
      id: randomUUID(),
      actionType,
      status,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.actions.push(action);
    return action;
  }
}
