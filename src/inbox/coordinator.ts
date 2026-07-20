import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { MessageAttachment, MessageResponse, Mode } from "../domain/types.js";
import type { PrivateInboxRepository } from "./repository.js";
import type { PrivateInboxEvent, PrivateInboxMessage, PrivateInboxSnapshot, PrivateMessageBurst } from "./types.js";

export type PrivateInboxCoordinatorOptions = {
  initialWaitMs?: number;
  quietWindowMs?: number;
  maximumWaitMs?: number;
  afterTurnQuietMs?: number;
  maximumMessagesPerBurst?: number;
  maximumCharactersPerBurst?: number;
};

type Processor = (
  burst: PrivateMessageBurst,
  onEvent: (event: PrivateInboxEvent) => void,
) => Promise<MessageResponse>;

export class PrivateInboxCoordinator {
  private readonly initialWaitMs: number;
  private readonly quietWindowMs: number;
  private readonly maximumWaitMs: number;
  private readonly afterTurnQuietMs: number;
  private readonly maximumMessagesPerBurst: number;
  private readonly maximumCharactersPerBurst: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly firstQueuedAt = new Map<string, number>();
  private readonly lastQueuedAt = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<(event: PrivateInboxEvent) => void>>();
  private started = false;

  constructor(
    readonly repository: PrivateInboxRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly processor: Processor,
    options: PrivateInboxCoordinatorOptions = {},
  ) {
    this.initialWaitMs = boundedDelay(options.initialWaitMs, 5_000);
    this.quietWindowMs = boundedDelay(options.quietWindowMs, 1_000);
    this.maximumWaitMs = Math.max(
      this.initialWaitMs,
      this.quietWindowMs,
      boundedDelay(options.maximumWaitMs, 7_000),
    );
    this.afterTurnQuietMs = boundedDelay(options.afterTurnQuietMs, 700);
    this.maximumMessagesPerBurst = boundedInteger(options.maximumMessagesPerBurst, 10, 1, 50);
    this.maximumCharactersPerBurst = boundedInteger(options.maximumCharactersPerBurst, 12_000, 256, 100_000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.repository.recoverInterrupted(this.clock.now().toISOString());
    for (const sessionId of this.repository.queuedSessionIds()) this.schedule(sessionId, 0);
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.firstQueuedAt.clear();
    this.lastQueuedAt.clear();
    this.listeners.clear();
  }

  enqueue(input: {
    clientMessageId: string;
    sessionId: string;
    characterId: string;
    mode: Mode;
    text: string;
    timezone: string;
    attachments: MessageAttachment[];
  }): PrivateInboxMessage {
    const existing = this.repository.getByClientMessageId(input.sessionId, input.clientMessageId);
    if (existing) {
      if (existing.status === "queued") this.schedule(input.sessionId);
      return existing;
    }
    const now = this.clock.now().toISOString();
    const message = this.repository.create({
      id: this.idGenerator.next("private-message"),
      ...input,
      now,
    });
    this.emit(input.sessionId, { type: "message_queued", message });
    const wallNow = Date.now();
    if (!this.firstQueuedAt.has(input.sessionId)) this.firstQueuedAt.set(input.sessionId, wallNow);
    this.lastQueuedAt.set(input.sessionId, wallNow);
    this.schedule(input.sessionId);
    return message;
  }

  updateQueued(sessionId: string, id: string, text: string, attachments: MessageAttachment[]): PrivateInboxMessage | undefined {
    const message = this.repository.updateQueued(
      sessionId,
      id,
      { text, attachments },
      this.clock.now().toISOString(),
    );
    if (!message) return undefined;
    this.lastQueuedAt.set(sessionId, Date.now());
    this.emit(sessionId, { type: "message_updated", message });
    this.schedule(sessionId);
    return message;
  }

  retractQueued(sessionId: string, id: string): PrivateInboxMessage | undefined {
    const message = this.repository.retractQueued(sessionId, id);
    if (!message) return undefined;
    this.emit(sessionId, {
      type: "message_retracted",
      messageId: message.id,
      clientMessageId: message.clientMessageId,
    });
    this.schedule(sessionId);
    return message;
  }

  snapshot(sessionId: string): PrivateInboxSnapshot {
    return {
      messages: this.repository.listActive(sessionId),
      running: this.running.has(sessionId),
    };
  }

  subscribe(sessionId: string, listener: (event: PrivateInboxEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  async flush(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const active = this.running.get(sessionId);
    if (active) {
      await active;
      if (!this.repository.listQueued(sessionId).length) return;
    }
    const run = this.processOne(sessionId);
    this.running.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.running.get(sessionId) === run) this.running.delete(sessionId);
      if (this.started && this.repository.listQueued(sessionId).length) {
        this.schedule(sessionId, this.afterTurnQuietMs);
      }
    }
  }

  private schedule(sessionId: string, minimumDelay = this.quietWindowMs): void {
    if (!this.started || this.running.has(sessionId)) return;
    const queued = this.repository.listQueued(sessionId);
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    if (!queued.length) {
      this.timers.delete(sessionId);
      this.firstQueuedAt.delete(sessionId);
      this.lastQueuedAt.delete(sessionId);
      return;
    }
    const now = Date.now();
    const first = this.firstQueuedAt.get(sessionId) ?? earliestMessageTime(queued, "createdAt", now);
    const last = this.lastQueuedAt.get(sessionId) ?? latestMessageTime(queued, now);
    this.firstQueuedAt.set(sessionId, first);
    this.lastQueuedAt.set(sessionId, last);
    const capReached = queued.length >= this.maximumMessagesPerBurst ||
      queued.reduce((total, message) => total + [...message.text].length, 0) >= this.maximumCharactersPerBurst;
    const initialRemaining = Math.max(0, this.initialWaitMs - (now - first));
    const quietRemaining = Math.max(0, minimumDelay - (now - last));
    const maximumRemaining = Math.max(0, this.maximumWaitMs - (now - first));
    const delay = capReached ? 0 : Math.min(Math.max(initialRemaining, quietRemaining), maximumRemaining);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.flush(sessionId).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private async processOne(sessionId: string): Promise<void> {
    const burst = this.repository.claimBurst({
      sessionId,
      burstId: this.idGenerator.next("private-burst"),
      now: this.clock.now().toISOString(),
      maximumMessages: this.maximumMessagesPerBurst,
      maximumCharacters: this.maximumCharactersPerBurst,
    });
    if (!burst) return;
    this.firstQueuedAt.delete(sessionId);
    this.lastQueuedAt.delete(sessionId);
    this.emit(sessionId, { type: "burst_started", burst });
    const relay = (event: PrivateInboxEvent) => this.emit(sessionId, event);
    try {
      const response = await this.processor(burst, relay);
      const status = response.status === "cancelled"
        ? "cancelled"
        : response.status === "failed" ? "failed" : "completed";
      this.repository.finishBurst(burst.id, status, this.clock.now().toISOString(),
        status === "failed" ? response.reply : undefined);
      this.emit(sessionId, {
        type: "burst_done",
        burstId: burst.id,
        messageIds: burst.messages.map((message) => message.id),
        response,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.finishBurst(burst.id, "failed", this.clock.now().toISOString(), message);
      this.emit(sessionId, {
        type: "burst_failed",
        burstId: burst.id,
        messageIds: burst.messages.map((entry) => entry.id),
        error: message,
      });
    } finally {
      // flush() schedules anything that arrived while this turn held the session lock.
    }
  }

  private emit(sessionId: string, event: PrivateInboxEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected UI listener must not affect durable queue processing.
      }
    }
  }
}

function boundedDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(30_000, Math.floor(value)))
    : fallback;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function earliestMessageTime(
  messages: readonly PrivateInboxMessage[],
  field: "createdAt" | "updatedAt",
  fallback: number,
): number {
  let earliest = fallback;
  for (const message of messages) {
    const value = Date.parse(message[field]);
    if (Number.isFinite(value)) earliest = Math.min(earliest, value);
  }
  return earliest;
}

function latestMessageTime(messages: readonly PrivateInboxMessage[], fallback: number): number {
  let latest = 0;
  for (const message of messages) {
    const value = Date.parse(message.updatedAt || message.createdAt);
    if (Number.isFinite(value)) latest = Math.max(latest, value);
  }
  return latest || fallback;
}
