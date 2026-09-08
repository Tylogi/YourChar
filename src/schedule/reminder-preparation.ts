import type { Clock } from "../app/clock.js";
import type { ReminderMessageComposer } from "../notifications/composer.js";
import type { ScheduleRepository } from "./repository.js";
import { reminderPolicy } from "./reminder-policy.js";
import type { ScheduleItem } from "./types.js";

/** Drafting is optional background work. A scheduler tick never awaits the model. */
export class ReminderPreparation {
  private stopped = false;
  private readonly jobs = new Map<string, { revision: number; controller: AbortController; timeout?: ReturnType<typeof setTimeout> }>();
  constructor(private readonly repository: ScheduleRepository, private readonly clock: Clock,
    private readonly composer?: ReminderMessageComposer, private readonly allowed: (item: ScheduleItem) => boolean = () => true) {}

  stop(): void { this.stopped = true; for (const job of this.jobs.values()) { clearTimeout(job.timeout); job.controller.abort(); } this.jobs.clear(); }
  resume(): void { this.stopped = false; }

  scan(): void {
    if (this.stopped) return;
    const now = this.clock.now().getTime();
    for (const [id, job] of this.jobs) {
      const occurrence = this.repository.getOccurrence(id);
      const item = occurrence && this.repository.getItem(occurrence.scheduleItemId);
      if (!item || item.revision !== job.revision || item.status !== "scheduled" || occurrence?.status !== "scheduled" ||
        occurrence.acknowledgedAt || Date.parse(occurrence.dueAt) <= now || !this.allowed(item)) {
        clearTimeout(job.timeout); job.controller.abort(); this.jobs.delete(id);
      }
    }
    if (!this.composer) return;
    for (const occurrence of this.repository.listUpcomingOccurrences(new Date(now + 30 * 60_000).toISOString())) {
      if (this.jobs.size >= 2) break;
      const item = this.repository.getItem(occurrence.scheduleItemId)!;
      const policy = reminderPolicy(item); const revision = item.revision ?? 0;
      const remaining = Date.parse(occurrence.dueAt) - now;
      const prior = this.repository.getDraft(occurrence.id);
      if (!policy.enabled || !this.allowed(item) || remaining <= 0 || remaining > policy.prepareMinutes * 60_000 || this.jobs.has(occurrence.id) ||
        (prior?.revision === revision && prior.status !== "preparing")) continue;
      const controller = new AbortController(); const job: { revision: number; controller: AbortController; timeout?: ReturnType<typeof setTimeout> } = { revision, controller };
      this.jobs.set(occurrence.id, job);
      this.repository.saveDraft(occurrence.id, revision, "preparing", this.clock.now().toISOString());
      const timeout = setTimeout(() => { controller.abort(); if (this.jobs.get(occurrence.id) === job) {
        this.jobs.delete(occurrence.id); this.repository.saveDraft(occurrence.id,revision,"failed",this.clock.now().toISOString());
      } }, Math.min(120_000, remaining)); timeout.unref(); job.timeout = timeout;
      void Promise.resolve().then(() => this.composer!.compose({ outboxId: "draft:" + occurrence.id,
        occurrenceId: occurrence.id, scheduleItemId: item.id, title: item.title, notes: item.notes,
        dueAt: occurrence.dueAt, eventAt: occurrence.eventAt, timezone: item.timezone, sourceSessionId: item.sourceSessionId }, controller.signal))
        .then(result => {
          const current = this.repository.getItem(item.id); const active = this.repository.getOccurrence(occurrence.id);
          if (controller.signal.aborted || this.jobs.get(occurrence.id) !== job || current?.revision !== revision ||
            current.status !== "scheduled" || active?.status !== "scheduled" || active.acknowledgedAt ||
            Date.parse(active.dueAt) <= this.clock.now().getTime() || !this.allowed(current)) return;
          const body = String(result.body || "").trim().slice(0, 2000);
          this.repository.saveDraft(occurrence.id, revision, body ? "ready" : "failed", this.clock.now().toISOString(), body || undefined, result.agentGenerated);
        }).catch(() => {
          if (!controller.signal.aborted && this.jobs.get(occurrence.id) === job) this.repository.saveDraft(occurrence.id, revision, "failed", this.clock.now().toISOString());
        }).finally(() => { clearTimeout(timeout); if (this.jobs.get(occurrence.id) === job) this.jobs.delete(occurrence.id); });
    }
  }
}
