import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { NotificationDelivery, NotificationSink } from "../notifications/sink.js";
import type { ReminderMessageComposer } from "../notifications/composer.js";
import type { ScheduleRepository } from "./repository.js";
import type { ScheduleService } from "./service.js";
import type { QuietHoursPolicy } from "./quiet-hours.js";
import type { NotificationOutboxEntry, ScheduleItem } from "./types.js";
import { reminderPolicy } from "./reminder-policy.js";
import { ReminderPreparation } from "./reminder-preparation.js";

export type SchedulerTickResult = { claimed: number; delivered: number; failed: number };
export type NotificationSessionResolver = (sourceSessionId?: string) => string | undefined | Promise<string | undefined>;
export type ReminderDeliveryOptions = {
  additionalSinks?: NotificationSink[];
  allowed?: (item: ScheduleItem, channel: string) => boolean;
  onDelivered?: (notification: NotificationDelivery) => void;
};

export class ScheduleScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<SchedulerTickResult>;
  private readonly preparation: ReminderPreparation;
  private readonly sinks: Map<string, NotificationSink>;
  private recoverProcessing = true;
  get isBusy(): boolean { return Boolean(this.running); }

  constructor(private readonly repository: ScheduleRepository, private readonly service: ScheduleService,
    private readonly sink: NotificationSink, private readonly clock: Clock, private readonly idGenerator: IdGenerator,
    private readonly quietHours?: QuietHoursPolicy, messageComposer?: ReminderMessageComposer,
    private readonly sessionResolver?: NotificationSessionResolver, private readonly options: ReminderDeliveryOptions = {}) {
    this.sinks = new Map([sink, ...(options.additionalSinks ?? [])].map(entry => [entry.channel, entry]));
    this.preparation = new ReminderPreparation(repository, clock, messageComposer, item => options.allowed?.(item, "in_app") !== false);
    service.onMutation(() => this.preparation.scan());
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.preparation.resume();
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.preparation.stop(); }
  async tick(): Promise<SchedulerTickResult> {
    if (this.running) return this.running;
    this.running = this.runTick();
    try { return await this.running; } finally { this.running = undefined; }
  }

  private async runTick(): Promise<SchedulerTickResult> {
    const now = this.clock.now().toISOString();
    if (this.recoverProcessing) { this.repository.requeueProcessingOutbox(now); this.recoverProcessing = false; }
    this.preparation.scan();
    const due = this.repository.listUpcomingOccurrences(now);
    this.repository.transaction(() => {
      for (const occurrence of due) {
        const item = this.repository.getItem(occurrence.scheduleItemId)!;
        const policy = reminderPolicy(item);
        if (!policy.enabled) continue;
        const channels = new Set([this.sink.channel, ...policy.channels.filter(channel => channel !== "in_app" && this.sinks.has(channel))]);
        for (const channel of channels) this.repository.createOutbox({ id: this.idGenerator.next("outbox"), occurrenceId: occurrence.id,
          channel, status: "pending", attempts: 0, availableAt: now, agentGenerated: false, createdAt: now, updatedAt: now });
        this.repository.setOccurrenceStatus(occurrence.id, "processing", now);
      }
    });
    const outcomes = await Promise.all(this.repository.listPendingOutbox(now).map(entry => this.deliver(entry)));
    return { claimed: due.length, delivered: outcomes.filter(result => result === "delivered").length, failed: outcomes.filter(result => result === "failed").length };
  }

  private async deliver(entry: NotificationOutboxEntry): Promise<string> {
    const now = this.clock.now().toISOString();
    const occurrence = this.repository.getOccurrence(entry.occurrenceId);
    const item = occurrence && this.repository.getItem(occurrence.scheduleItemId);
    if (!occurrence || !item) return "skipped";
    const active = () => {
      const current = this.repository.getOccurrence(occurrence.id); const schedule = this.repository.getItem(item.id);
      return current && schedule?.status === "scheduled" && schedule.revision === item.revision && !current.acknowledgedAt &&
        !["cancelled", "snoozed"].includes(current.status) && !this.repository.getOutbox(entry.id)?.suppressedAt && this.options.allowed?.(schedule, entry.channel) !== false;
    };
    if (!active()) { this.repository.suppressOccurrence(occurrence.id, now); return "skipped"; }
    const nextAllowedAt = this.quietHours?.nextAllowedAt(this.clock.now());
    if (nextAllowedAt) { this.repository.deferOutbox(entry.id,nextAllowedAt.toISOString(),now); return "pending"; }
    this.repository.markOutboxProcessing(entry.id,now);
    try {
      const sourceSessionId = this.sessionResolver ? await this.sessionResolver(item.sourceSessionId) : item.sourceSessionId;
      if (!active()) return "skipped";
      const draft = this.repository.getDraft(occurrence.id);
      const ready = draft?.revision === (item.revision ?? 0) && draft.status === "ready" && draft.body;
      const body = entry.deliveryBody ?? (ready ? draft.body! : fallbackReminder(item, occurrence.eventAt ?? occurrence.dueAt));
      const generated = entry.deliveryBody ? entry.agentGenerated : Boolean(ready && draft.agentGenerated);
      if (!entry.deliveryBody) this.repository.setOutboxPayload(entry.id,item.title,body,generated,now);
      const notification: NotificationDelivery = { outboxId: entry.id, occurrenceId: occurrence.id, scheduleItemId: item.id,
        title: entry.deliveryTitle ?? item.title, body, dueAt: occurrence.dueAt, eventAt: occurrence.eventAt, timezone: item.timezone, sourceSessionId, agentGenerated: generated };
      const sink = this.sinks.get(entry.channel);
      if (!sink) throw new Error("notification channel unavailable");
      const result = await withDeliveryTimeout(sink.deliver(notification));
      if (result.pending) { this.repository.setPendingDetail(entry.id,result.detail); this.repository.deferOutbox(entry.id,new Date(this.clock.now().getTime()+1000).toISOString(),now); return "pending"; }
      if (!result.delivered) throw new Error(result.detail || "notification rejected");
      const completedAt = this.clock.now().toISOString();
      this.repository.transaction(() => {
        this.repository.markOutboxDelivered(entry.id,completedAt);
        const current = this.repository.getOccurrence(occurrence.id);
        const schedule = this.repository.getItem(item.id);
        if (current && schedule?.status === "scheduled" && schedule.revision === item.revision &&
          !["snoozed", "cancelled"].includes(current.status)) {
          this.repository.setOccurrenceStatus(occurrence.id,"delivered",completedAt);
          this.service.createNextRecurringOccurrence(item,occurrence.dueAt);
        }
      });
      if (entry.channel === this.sink.channel) { try { this.options.onDelivered?.(notification); } catch { /* Optional chat mirror cannot undo a delivery. */ } }
      return "delivered";
    } catch (error) {
      if (!active()) return "skipped";
      const terminal = entry.attempts + 1 >= 3;
      this.repository.markOutboxFailed(entry.id,terminal ? "failed" : "pending",new Date(this.clock.now().getTime()+(entry.attempts+1)*60000).toISOString(),
        error instanceof Error ? error.message : String(error),this.clock.now().toISOString());
      const channels = this.repository.listOutbox().filter(row => row.occurrenceId === occurrence.id && !row.suppressedAt);
      if (channels.every(row => row.status === "failed")) this.repository.setOccurrenceStatus(occurrence.id,"failed",now);
      return "failed";
    }
  }
}

function fallbackReminder(item: ScheduleItem, eventAt: string): string {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: item.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(eventAt));
  return "提醒：" + item.title + "\n事项时间：" + time + (item.notes ? "\n" + item.notes : "");
}

async function withDeliveryTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("notification delivery timed out")), 5000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
