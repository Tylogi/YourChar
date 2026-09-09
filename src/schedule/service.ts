import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import { addZonedCalendarDays, TimeResolutionError } from "../domain/time.js";
import type { ScheduleRepository } from "./repository.js";
import { normalizeReminderPolicy, reminderPolicy } from "./reminder-policy.js";
import type {
  CreateScheduleItemInput,
  ReminderOccurrence,
  ScheduleItem,
  ScheduleListFilter,
  ScheduleMutationEvent,
  ScheduleMutationListener,
  ScheduleMutationResult,
  UpdateScheduleItemInput,
} from "./types.js";

export class ScheduleNotFoundError extends Error {
  constructor(kind: "schedule item" | "occurrence" | "notification", id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export class ScheduleService {
  private readonly mutationListeners = new Set<ScheduleMutationListener>();

  constructor(
    readonly repository: ScheduleRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  onMutation(listener: ScheduleMutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  create(input: CreateScheduleItemInput): ScheduleMutationResult {
    validateCreateInput(input);
    if (input.idempotencyKey) {
      const existing = this.repository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return {
          item: existing,
          occurrence: this.repository.listOccurrences(existing.id)[0],
          warnings: [],
        };
      }
    }

    const now = this.clock.now().toISOString();
    const item: ScheduleItem = {
      id: this.idGenerator.next("schedule"),
      kind: input.kind,
      title: input.title.trim(),
      notes: cleanOptional(input.notes),
      startAt: normalizeInstant(input.startAt),
      endAt: normalizeInstant(input.endAt),
      timezone: input.timezone,
      allDay: Boolean(input.allDay),
      recurrenceRule: normalizeRecurrence(input.recurrenceRule),
      status: "scheduled",
      ownerType: input.ownerType ?? "user",
      characterId: cleanOptional(input.characterId),
      sourceSessionId: cleanOptional(input.sourceSessionId),
      createdAt: now,
      updatedAt: now,
    };
    item.reminder = normalizeReminderPolicy(input.reminder, item);
    validateScheduleItem(item);
    assertFutureReminder(item, this.clock.now());
    const warnings = this.overlapWarnings(item);
    const result = this.repository.transaction(() => {
      this.repository.createItem(item, input.idempotencyKey);
      const occurrence = reminderPolicy(item).enabled ? this.createOccurrence(item, notificationTime(item)) : undefined;
      return { item, occurrence, warnings };
    });
    this.emitMutation({ type: "created", item: result.item, occurrence: result.occurrence });
    return result;
  }

  list(filter: ScheduleListFilter = {}): ScheduleItem[] {
    return this.repository.listItems(filter);
  }

  get(id: string): ScheduleItem {
    const item = this.repository.getItem(id);
    if (!item) {
      throw new ScheduleNotFoundError("schedule item", id);
    }
    return item;
  }

  update(id: string, patch: UpdateScheduleItemInput): ScheduleMutationResult {
    const current = this.get(id);
    if (current.status === "cancelled") {
      throw new Error("cancelled schedule items cannot be updated");
    }
    const next: ScheduleItem = {
      ...current,
      title: patch.title === undefined ? current.title : patch.title.trim(),
      notes: patch.notes === undefined ? current.notes : cleanOptional(patch.notes),
      startAt: patch.startAt === undefined ? current.startAt : normalizeInstant(patch.startAt),
      endAt: patch.endAt === undefined ? current.endAt : normalizeInstant(patch.endAt),
      timezone: patch.timezone === undefined ? current.timezone : patch.timezone,
      allDay: patch.allDay === undefined ? current.allDay : patch.allDay,
      recurrenceRule:
        patch.recurrenceRule === undefined
          ? current.recurrenceRule
          : normalizeRecurrence(patch.recurrenceRule),
      updatedAt: this.clock.now().toISOString(),
      revision: (current.revision ?? 0) + 1,
    };
    if (patch.reminder !== undefined && (!patch.reminder || typeof patch.reminder !== "object" || Array.isArray(patch.reminder))) {
      throw new Error("reminder policy must be an object");
    }
    const currentPolicy = reminderPolicy(current);
    next.reminder = normalizeReminderPolicy(patch.reminder ? {
      ...currentPolicy, ...patch.reminder,
      channelMode: patch.reminder.channelMode ?? (patch.reminder.channels ? "custom" : currentPolicy.channelMode ?? "custom"),
    } : currentPolicy, next);
    validateScheduleItem(next);
    assertFutureReminder(next, this.clock.now());
    const warnings = this.overlapWarnings(next);
    const result = this.repository.transaction(() => {
      this.repository.updateItem(next);
      let occurrence: ReminderOccurrence | undefined;
      if (reminderPolicy(current).enabled || reminderPolicy(next).enabled) {
        this.repository.cancelScheduledOccurrences(next.id, next.updatedAt);
        if (reminderPolicy(next).enabled && next.startAt && next.startAt > next.updatedAt) occurrence = this.createOccurrence(next, notificationTime(next));
      }
      return { item: next, occurrence, warnings };
    });
    this.emitMutation({ type: "updated", item: result.item, previousItem: current, occurrence: result.occurrence });
    return result;
  }

  complete(id: string): ScheduleItem {
    const item = this.get(id);
    const updated = { ...item, status: "completed" as const, updatedAt: this.clock.now().toISOString() };
    const result = this.repository.transaction(() => {
      this.repository.updateItem(updated);
      this.repository.cancelScheduledOccurrences(id, updated.updatedAt);
      return updated;
    });
    this.emitMutation({ type: "completed", item: result, previousItem: item });
    return result;
  }

  cancel(id: string): ScheduleItem {
    const item = this.get(id);
    const updated = { ...item, status: "cancelled" as const, updatedAt: this.clock.now().toISOString() };
    const result = this.repository.transaction(() => {
      this.repository.updateItem(updated);
      this.repository.cancelScheduledOccurrences(id, updated.updatedAt);
      return updated;
    });
    this.emitMutation({ type: "cancelled", item: result, previousItem: item });
    return result;
  }

  snooze(occurrenceId: string, minutes: number): ReminderOccurrence {
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 10080) {
      throw new Error("snooze minutes must be greater than zero");
    }
    const occurrence = this.repository.getOccurrence(occurrenceId);
    if (!occurrence) {
      throw new ScheduleNotFoundError("occurrence", occurrenceId);
    }
    const now = this.clock.now();
    const nextDueAt = new Date(now.getTime() + minutes * 60_000).toISOString();
    const item = this.get(occurrence.scheduleItemId);
    if (item.status !== "scheduled" || ["cancelled", "snoozed"].includes(occurrence.status)) throw new Error("reminder is no longer active");
    const result = this.repository.transaction(() => {
      this.repository.suppressOccurrence(occurrence.id, now.toISOString());
      this.repository.setOccurrenceStatus(occurrence.id, "snoozed", now.toISOString());
      return this.createOccurrence(item, nextDueAt, occurrence.id);
    });
    this.emitMutation({ type: "snoozed", item, occurrence: result, snoozeMinutes: minutes });
    return result;
  }

  createNextRecurringOccurrence(item: ScheduleItem, previousDueAt: string): ReminderOccurrence | undefined {
    const previous = this.repository.getOccurrenceByItemAndTime(item.id, previousDueAt);
    if (previous?.snoozedFromId) return undefined;
    const leadMs = reminderPolicy(item).leadMinutes * 60_000;
    const eventAt = previous?.eventAt ?? new Date(Date.parse(previousDueAt) + leadMs).toISOString();
    const nextEventAt = nextRecurringInstant(eventAt, item.recurrenceRule, item.timezone);
    return nextEventAt ? this.createOccurrence(item, new Date(Date.parse(nextEventAt) - leadMs).toISOString()) : undefined;
  }

  listOccurrences(scheduleItemId?: string): ReminderOccurrence[] {
    return this.repository.listOccurrences(scheduleItemId);
  }

  retryNotification(outboxId: string) {
    const entry = this.repository.getOutbox(outboxId);
    if (!entry) {
      throw new ScheduleNotFoundError("notification", outboxId);
    }
    if (entry.status !== "failed") {
      throw new Error("only failed notifications can be retried");
    }
    const occurrence = this.repository.getOccurrence(entry.occurrenceId);
    if (!occurrence) {
      throw new ScheduleNotFoundError("occurrence", entry.occurrenceId);
    }
    if (entry.suppressedAt || occurrence.acknowledgedAt || ["cancelled", "snoozed"].includes(occurrence.status) || this.get(occurrence.scheduleItemId).status !== "scheduled") throw new Error("reminder is no longer active");
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      this.repository.retryOutbox(entry.id, now, now);
      this.repository.setOccurrenceStatus(occurrence.id, "scheduled", now);
      return this.repository.getOutbox(entry.id)!;
    });
  }

  acknowledge(occurrenceId: string, via = "in_app"): ReminderOccurrence {
    const occurrence = this.repository.getOccurrence(occurrenceId);
    if (!occurrence) throw new ScheduleNotFoundError("occurrence", occurrenceId);
    if (["cancelled", "snoozed"].includes(occurrence.status)) throw new Error("reminder is no longer active");
    return this.repository.transaction(() => this.repository.acknowledgeOccurrence(occurrenceId, via, this.clock.now().toISOString()));
  }

  private createOccurrence(
    item: ScheduleItem,
    dueAt: string,
    snoozedFromId?: string,
  ): ReminderOccurrence {
    const now = this.clock.now().toISOString();
    return this.repository.createOccurrence({
      id: this.idGenerator.next("occurrence"),
      scheduleItemId: item.id,
      dueAt,
      eventAt: snoozedFromId
        ? this.repository.getOccurrence(snoozedFromId)?.eventAt ?? item.startAt ?? dueAt
        : new Date(Date.parse(dueAt) + reminderPolicy(item).leadMinutes * 60_000).toISOString(),
      status: "scheduled",
      snoozedFromId,
      createdAt: now,
      updatedAt: now,
    });
  }

  private overlapWarnings(item: ScheduleItem): string[] {
    if (!item.startAt || item.status !== "scheduled") {
      return [];
    }
    const start = new Date(item.startAt).getTime();
    const end = item.endAt ? new Date(item.endAt).getTime() : start + 1;
    const overlaps = this.repository.listItems({
      status: "scheduled",
      ownerType: item.ownerType,
      characterId: item.characterId,
    }).filter((candidate) => {
      if (candidate.id === item.id || !candidate.startAt) return false;
      const candidateStart = new Date(candidate.startAt).getTime();
      const candidateEnd = candidate.endAt ? new Date(candidate.endAt).getTime() : candidateStart + 1;
      return candidateStart < end && candidateEnd > start;
    });
    return overlaps.map((candidate) => `与“${candidate.title}”时间重叠`);
  }

  private emitMutation(event: ScheduleMutationEvent): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(event);
      } catch {
        // Schedule mutations are already committed; observers reconcile from durable state.
      }
    }
  }
}

function notificationTime(item: ScheduleItem): string {
  return new Date(Date.parse(item.startAt!) - reminderPolicy(item).leadMinutes * 60_000).toISOString();
}

function validateCreateInput(input: CreateScheduleItemInput): void {
  if (!input.title?.trim()) {
    throw new Error("title is required");
  }
  if (!(["event", "task", "reminder"] as string[]).includes(input.kind)) {
    throw new Error("kind must be event, task, or reminder");
  }
  assertTimezone(input.timezone);
  assertOwner(input.ownerType ?? "user", input.characterId, input.kind);
  if (input.kind === "reminder" && !input.startAt) {
    throw new TimeResolutionError("AMBIGUOUS_TIME", "提醒必须包含明确时间");
  }
}

function validateScheduleItem(item: ScheduleItem): void {
  if (!item.title) throw new Error("title is required");
  assertTimezone(item.timezone);
  assertOwner(item.ownerType, item.characterId, item.kind);
  if (item.kind === "reminder" && !item.startAt) {
    throw new TimeResolutionError("AMBIGUOUS_TIME", "提醒必须包含明确时间");
  }
  if (item.startAt && item.endAt && item.endAt <= item.startAt) {
    throw new Error("endAt must be after startAt");
  }
}

function assertOwner(
  ownerType: ScheduleItem["ownerType"],
  characterId: string | undefined,
  kind: ScheduleItem["kind"],
): void {
  if (ownerType === "character") {
    if (!characterId?.trim()) throw new ScheduleValidationError("character schedule items require characterId");
    if (kind === "reminder") throw new ScheduleValidationError("character schedules do not create real reminders");
    return;
  }
  if (characterId?.trim()) throw new ScheduleValidationError("user schedule items cannot have characterId");
}

function normalizeInstant(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TimeResolutionError("INVALID_TIME", `无效时间：${value}`);
  }
  return date.toISOString();
}

function normalizeRecurrence(value?: string): string | undefined {
  const rule = cleanOptional(value)?.toUpperCase();
  if (!rule) return undefined;
  if (!/^FREQ=(DAILY|WEEKLY)(?:;INTERVAL=\d+)?$/.test(rule)) {
    throw new Error("recurrenceRule currently supports DAILY or WEEKLY with optional INTERVAL");
  }
  return rule;
}

function nextRecurringInstant(previousDueAt: string, rule: string | undefined, timezone: string): string | undefined {
  if (!rule) return undefined;
  const frequency = rule.match(/FREQ=(DAILY|WEEKLY)/)?.[1];
  const interval = Number(rule.match(/INTERVAL=(\d+)/)?.[1] ?? "1");
  return addZonedCalendarDays(previousDueAt, interval * (frequency === "WEEKLY" ? 7 : 1), timezone);
}

function cleanOptional(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new TimeResolutionError("INVALID_TIMEZONE", `无效时区：${timezone}`);
  }
}

function assertFutureReminder(item: ScheduleItem, now: Date): void {
  if ((item.kind === "reminder" || reminderPolicy(item).enabled) && item.startAt && new Date(item.startAt).getTime() <= now.getTime()) {
    throw new TimeResolutionError("PAST_TIME", "提醒时间已经过去，请提供未来时间");
  }
}
