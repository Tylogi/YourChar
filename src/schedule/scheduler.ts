import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { NotificationSink } from "../notifications/sink.js";
import type { ReminderMessageComposer } from "../notifications/composer.js";
import type { ScheduleRepository } from "./repository.js";
import type { ScheduleService } from "./service.js";
import type { QuietHoursPolicy } from "./quiet-hours.js";

export type SchedulerTickResult = {
  claimed: number;
  delivered: number;
  failed: number;
};

export type NotificationSessionResolver = (
  sourceSessionId?: string,
) => string | undefined | Promise<string | undefined>;

export class ScheduleScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<SchedulerTickResult>;

  constructor(
    private readonly repository: ScheduleRepository,
    private readonly service: ScheduleService,
    private readonly sink: NotificationSink,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly quietHours?: QuietHoursPolicy,
    private readonly messageComposer?: ReminderMessageComposer,
    private readonly sessionResolver?: NotificationSessionResolver,
  ) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<SchedulerTickResult> {
    if (this.running) {
      return this.running;
    }
    this.running = this.runTick();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async runTick(): Promise<SchedulerTickResult> {
    const now = this.clock.now().toISOString();
    this.repository.requeueProcessingOutbox(now);
    const due = this.repository.listDueOccurrences(now);
    this.repository.transaction(() => {
      for (const occurrence of due) {
        this.repository.createOutbox({
          id: this.idGenerator.next("outbox"),
          occurrenceId: occurrence.id,
          channel: this.sink.channel,
          status: "pending",
          attempts: 0,
          availableAt: now,
          agentGenerated: false,
          createdAt: now,
          updatedAt: now,
        });
        this.repository.setOccurrenceStatus(occurrence.id, "processing", now);
      }
    });

    let delivered = 0;
    let failed = 0;
    for (const entry of this.repository.listPendingOutbox(now)) {
      const nextAllowedAt = this.quietHours?.nextAllowedAt(this.clock.now());
      if (nextAllowedAt) {
        this.repository.deferOutbox(entry.id, nextAllowedAt.toISOString(), now);
        continue;
      }
      const occurrence = this.repository.getOccurrence(entry.occurrenceId);
      if (!occurrence) continue;
      const item = this.repository.getItem(occurrence.scheduleItemId);
      if (!item || item.status !== "scheduled") {
        this.repository.markOutboxFailed(entry.id, "failed", now, "schedule item is not active", now);
        continue;
      }
      this.repository.markOutboxProcessing(entry.id, now);
      try {
        const sourceSessionId = this.sessionResolver
          ? await this.sessionResolver(item.sourceSessionId)
          : item.sourceSessionId;
        const composed = entry.deliveryBody
          ? {
              body: entry.deliveryBody,
              agentGenerated: entry.agentGenerated,
            }
          : this.messageComposer
            ? await this.messageComposer.compose({
              outboxId: entry.id,
              occurrenceId: occurrence.id,
              scheduleItemId: item.id,
              sourceSessionId,
              title: item.title,
              notes: item.notes,
              dueAt: occurrence.dueAt,
              timezone: item.timezone,
              })
            : {
                body: item.notes || `提醒时间：${occurrence.dueAt}`,
                agentGenerated: false,
              };
        const deliveryTitle = entry.deliveryTitle ?? item.title;
        if (!entry.deliveryBody) {
          this.repository.setOutboxPayload(
            entry.id,
            deliveryTitle,
            composed.body,
            composed.agentGenerated,
            this.clock.now().toISOString(),
          );
        }
        const result = await this.sink.deliver({
          outboxId: entry.id,
          occurrenceId: occurrence.id,
          scheduleItemId: item.id,
          title: deliveryTitle,
          body: composed.body,
          dueAt: occurrence.dueAt,
          sourceSessionId,
          agentGenerated: composed.agentGenerated,
        });
        if (!result.delivered) {
          throw new Error(result.detail || "notification sink rejected delivery");
        }
        const completedAt = this.clock.now().toISOString();
        this.repository.transaction(() => {
          this.repository.markOutboxDelivered(entry.id, completedAt);
          this.repository.setOccurrenceStatus(occurrence.id, "delivered", completedAt);
          this.service.createNextRecurringOccurrence(item, occurrence.dueAt);
        });
        delivered += 1;
      } catch (error) {
        const attempts = entry.attempts + 1;
        const terminal = attempts >= 3;
        const retryAt = new Date(this.clock.now().getTime() + attempts * 60_000).toISOString();
        this.repository.markOutboxFailed(
          entry.id,
          terminal ? "failed" : "pending",
          retryAt,
          error instanceof Error ? error.message : String(error),
          this.clock.now().toISOString(),
        );
        if (terminal) {
          this.repository.setOccurrenceStatus(occurrence.id, "failed", this.clock.now().toISOString());
        }
        failed += 1;
      }
    }
    return { claimed: due.length, delivered, failed };
  }
}
