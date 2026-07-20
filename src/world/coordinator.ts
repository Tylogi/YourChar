import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { RpService } from "../rp/service.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleItem } from "../schedule/types.js";
import { WorldValidationError, type WorldService } from "./service.js";
import {
  worldCapabilities,
  type CharacterActivityPlan,
  type CharacterAutonomyPolicy,
  type ProactiveMessage,
  type ProactiveMessenger,
  type WorldActivityProposal,
  type WorldAutonomyTickResult,
  type WorldCapabilityId,
  type WorldEvent,
  type WorldPlanner,
} from "./types.js";

type ConversationSnapshot = {
  sessionId: string;
  recentConversation: Array<{ role: "user" | "assistant"; text: string }>;
};

export type WorldAutonomyCoordinatorOptions = {
  planner?: WorldPlanner;
  messenger?: ProactiveMessenger;
  conversationForCharacter?: (characterId: string) => Promise<ConversationSnapshot | undefined>;
  canDeliverProactive?: (sessionId: string, characterId: string) => boolean;
  canProjectRuntime?: (characterId: string) => boolean;
  intervalMs?: number;
};

export class WorldAutonomyCoordinator {
  private timer?: NodeJS.Timeout;
  private running?: Promise<WorldAutonomyTickResult>;
  private readonly intervalMs: number;

  constructor(
    readonly worldService: WorldService,
    private readonly scheduleService: ScheduleService,
    private readonly rpService: RpService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly options: WorldAutonomyCoordinatorOptions = {},
  ) {
    this.intervalMs = Math.max(15_000, options.intervalMs ?? 60_000);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(characterId?: string): Promise<WorldAutonomyTickResult> {
    if (this.running) return this.running;
    const operation = this.tickUnlocked(characterId).finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    this.running = operation;
    return operation;
  }

  validateActivityTarget(
    characterId: string,
    placeId: string,
    capabilityId: WorldCapabilityId,
  ): void {
    const life = this.worldService.getCharacterLife(characterId);
    if (!life.membership || !life.world) {
      throw new WorldValidationError("assign the character to a world before scheduling a world activity");
    }
    const place = life.places.find((entry) => entry.id === placeId);
    if (!place) throw new WorldValidationError("the scheduled place does not belong to the character's world");
    if (capabilityId !== "travel" && !place.capabilityIds.includes(capabilityId)) {
      throw new WorldValidationError(`${place.name} does not provide capability ${capabilityId}`);
    }
  }

  linkScheduleItem(input: {
    characterId: string;
    scheduleItemId: string;
    placeId: string;
    capabilityId: WorldCapabilityId;
    summary?: string;
    salience?: number;
    idempotencyKey: string;
  }): CharacterActivityPlan {
    const existing = this.worldService.repository.findActivityPlanByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    this.validateActivityTarget(input.characterId, input.placeId, input.capabilityId);
    const life = this.worldService.getCharacterLife(input.characterId);
    const schedule = this.scheduleService.get(input.scheduleItemId);
    if (
      schedule.ownerType !== "character" ||
      schedule.characterId !== input.characterId ||
      schedule.status !== "scheduled"
    ) {
      throw new WorldValidationError("world activities require a scheduled item owned by the selected character");
    }
    if (!schedule.startAt || !schedule.endAt) {
      throw new WorldValidationError("world activities require explicit start and end times");
    }
    const now = this.clock.now().toISOString();
    return this.worldService.repository.createActivityPlan({
      id: this.idGenerator.next("world-plan"),
      scheduleItemId: schedule.id,
      worldId: life.membership!.worldId,
      characterId: input.characterId,
      placeId: input.placeId,
      capabilityId: input.capabilityId,
      summary: input.summary?.trim().slice(0, 800) || schedule.notes || schedule.title,
      salience: boundedUnit(input.salience, input.capabilityId === "travel" ? 0.62 : 0.55),
      status: "planned",
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
  }

  refreshCharacterRuntime(characterId: string): void {
    if (this.options.canProjectRuntime && !this.options.canProjectRuntime(characterId)) return;
    let life = this.worldService.getCharacterLife(characterId);
    if (!life.membership || !life.runtime) return;
    let reconciled = false;
    for (const plan of life.plans.filter((entry) => entry.status === "planned")) {
      const item = this.safeSchedule(plan.scheduleItemId);
      if (!item || item.status === "cancelled") {
        this.worldService.repository.updateActivityPlan({
          ...plan,
          status: "cancelled",
          updatedAt: this.clock.now().toISOString(),
        });
        reconciled = true;
      } else if (item.status === "completed") {
        this.settlePlan(characterId, plan, item);
        reconciled = true;
      }
    }
    if (reconciled) life = this.worldService.getCharacterLife(characterId);
    if (!life.runtime) return;
    const now = this.clock.now().getTime();
    const active = life.plans.flatMap((plan) => {
      if (plan.status !== "planned") return [];
      const item = this.safeSchedule(plan.scheduleItemId);
      if (!item || item.status !== "scheduled" || !item.startAt) return [];
      const start = new Date(item.startAt).getTime();
      const end = item.endAt ? new Date(item.endAt).getTime() : start + 60 * 60_000;
      return start <= now && now < end ? [{ plan, item, end }] : [];
    }).sort((left, right) => right.end - left.end)[0];
    if (active) {
      this.worldService.setCharacterRuntime(characterId, {
        ...(active.plan.capabilityId !== "travel" && active.plan.placeId
          ? { placeId: active.plan.placeId }
          : {}),
        activity: active.item.title,
        availability: capabilityAvailability(active.plan.capabilityId),
        expectedUntil: new Date(active.end).toISOString(),
      });
      return;
    }
    const projected = life.plans.flatMap((plan) => {
      if (!plan.placeId || (plan.status !== "planned" && plan.status !== "settled")) return [];
      const item = this.safeSchedule(plan.scheduleItemId);
      if (!item) return [];
      const completedAt = plan.settledAt ?? item.endAt ?? item.startAt;
      if (!completedAt) return [];
      const completed = new Date(completedAt).getTime();
      return completed <= now && completed > new Date(life.runtime!.updatedAt).getTime()
        ? [{ plan, completed }]
        : [];
    }).sort((left, right) => right.completed - left.completed)[0];
    if (projected) {
      this.worldService.setCharacterRuntime(characterId, {
        placeId: projected.plan.placeId,
        activity: "自由活动",
        availability: "free",
        expectedUntil: null,
      });
      return;
    }
    const staleOpenEndedActivity = !life.runtime.expectedUntil &&
      life.runtime.availability !== "free" &&
      now - new Date(life.runtime.updatedAt).getTime() >= 2 * 60 * 60_000;
    if (
      (life.runtime.expectedUntil && new Date(life.runtime.expectedUntil).getTime() <= now) ||
      staleOpenEndedActivity
    ) {
      this.worldService.setCharacterRuntime(characterId, {
        activity: "自由活动",
        availability: "free",
        expectedUntil: null,
      });
    }
  }

  async planCharacter(characterId: string, force = false): Promise<{
    plans: CharacterActivityPlan[];
    fallbackUsed: boolean;
  }> {
    const life = this.worldService.getCharacterLife(characterId);
    if (!life.membership || !life.world || !life.runtime) {
      throw new WorldValidationError("assign the character to a world before planning activities");
    }
    if (!life.policy.enabled) throw new WorldValidationError("character autonomy is disabled");
    if (!life.places.length) return { plans: [], fallbackUsed: true };
    const localDate = localDateKey(this.clock.now(), life.world.timezone);
    if (!force && life.policy.lastPlannedDate === localDate) {
      return { plans: life.plans.filter((plan) => plan.status === "planned"), fallbackUsed: false };
    }

    const character = this.rpService.getCharacter(characterId);
    const existingSchedule = this.scheduleService.list({
      ownerType: "character",
      characterId,
      status: "scheduled",
    });
    let proposals: WorldActivityProposal[] = [];
    let fallbackUsed = false;
    if (this.options.planner) {
      try {
        const output = await this.options.planner({
          characterId,
          characterName: character.name,
          soulMarkdown: character.soulMarkdown,
          world: life.world,
          places: life.places,
          currentState: life.runtime,
          existingSchedule: existingSchedule.map((item) => ({
            title: item.title,
            ...(item.startAt ? { startAt: item.startAt } : {}),
            ...(item.endAt ? { endAt: item.endAt } : {}),
          })),
          now: this.clock.now().toISOString(),
          localDate,
        });
        proposals = validateProposals(parsePlannerOutput(output), life.places, this.clock.now());
      } catch {
        proposals = [];
      }
    }
    if (!proposals.length) {
      proposals = fallbackProposals(characterId, localDate, life.places, this.clock.now());
      fallbackUsed = true;
    }

    const created: CharacterActivityPlan[] = [];
    for (const [index, proposal] of proposals.slice(0, 4).entries()) {
      const idempotencyKey = `world-plan:${life.world.id}:${characterId}:${life.membership.createdAt}:${localDate}:${index}`;
      const existing = this.worldService.repository.findActivityPlanByIdempotencyKey(idempotencyKey);
      if (existing) {
        created.push(existing);
        continue;
      }
      const schedule = this.scheduleService.create({
        kind: "event",
        title: proposal.title,
        notes: proposal.summary,
        startAt: proposal.startAt,
        endAt: proposal.endAt,
        timezone: life.world.timezone,
        ownerType: "character",
        characterId,
        sourceSessionId: `world:${life.world.id}`,
        idempotencyKey,
      }).item;
      const now = this.clock.now().toISOString();
      created.push(this.worldService.repository.createActivityPlan({
        id: this.idGenerator.next("world-plan"),
        scheduleItemId: schedule.id,
        worldId: life.world.id,
        characterId,
        placeId: proposal.placeId,
        capabilityId: proposal.capabilityId,
        summary: proposal.summary,
        salience: proposal.salience,
        status: "planned",
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
      }));
    }
    this.worldService.repository.upsertPolicy({
      ...life.policy,
      lastPlannedDate: localDate,
      updatedAt: this.clock.now().toISOString(),
    });
    this.refreshCharacterRuntime(characterId);
    return { plans: created, fallbackUsed };
  }

  async performCharacterAction(input: {
    characterId: string;
    placeId?: string;
    capabilityId: WorldCapabilityId;
    activity?: string;
    summary?: string;
    salience?: number;
    idempotencyKey: string;
    source?: "agent_tool" | "manual";
    allowProactive?: boolean;
  }): Promise<WorldEvent> {
    const event = this.worldService.performAction({
      characterId: input.characterId,
      ...(input.placeId ? { placeId: input.placeId } : {}),
      capabilityId: input.capabilityId,
      ...(input.activity ? { activity: input.activity } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.salience === undefined ? {} : { salience: input.salience }),
      source: input.source ?? "agent_tool",
      idempotencyKey: input.idempotencyKey,
    });
    this.rememberEvent(input.characterId, event);
    if (input.allowProactive) this.enqueueProactive(input.characterId, event);
    return event;
  }

  async simulateMoment(characterId: string): Promise<{
    event: WorldEvent;
    proactiveMessage?: ProactiveMessage;
  }> {
    const life = this.worldService.getCharacterLife(characterId);
    if (!life.membership || !life.world || !life.runtime) {
      throw new WorldValidationError("assign the character to a world before simulating a moment");
    }
    const place = life.places.find((entry) => entry.id === life.runtime!.placeId)
      ?? life.places.find((entry) => entry.id === life.membership!.homePlaceId)
      ?? life.places[0];
    if (!place) throw new WorldValidationError("create at least one place before simulating a moment");
    const index = stableIndex(`${characterId}:${this.clock.now().toISOString().slice(0, 13)}`, place.capabilityIds.length);
    const capabilityId = place.capabilityIds[index] ?? "observe";
    const activity = worldCapabilities[capabilityId].defaultActivity;
    const character = this.rpService.getCharacter(characterId);
    const event = await this.performCharacterAction({
      characterId,
      placeId: place.id,
      capabilityId,
      activity,
      summary: `${character.name}在${place.name}${activity}`,
      salience: 0.72,
      idempotencyKey: `manual-moment:${characterId}:${this.clock.now().toISOString()}`,
      source: "manual",
      allowProactive: true,
    });
    await this.deliverPending(characterId, true);
    return {
      event,
      proactiveMessage: this.worldService.repository.getProactiveMessageByEvent(event.id),
    };
  }

  private async tickUnlocked(characterId?: string): Promise<WorldAutonomyTickResult> {
    const memberships = characterId
      ? [this.worldService.repository.getMembership(characterId)].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      : this.worldService.repository.listMemberships();
    const result: WorldAutonomyTickResult = {
      characters: memberships.length,
      planned: 0,
      settled: 0,
      delivered: 0,
      failed: 0,
    };
    for (const membership of memberships) {
      try {
        this.refreshCharacterRuntime(membership.characterId);
        result.settled += this.settleDue(membership.characterId);
        const policy = this.worldService.repository.getPolicy(membership.characterId);
        if (policy?.enabled) {
          const plan = await this.planCharacter(membership.characterId);
          result.planned += plan.plans.filter((entry) => entry.createdAt === entry.updatedAt).length;
        }
        result.delivered += await this.deliverPending(membership.characterId);
        this.refreshCharacterRuntime(membership.characterId);
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  private settleDue(characterId: string): number {
    const membership = this.worldService.repository.getMembership(characterId);
    if (!membership) return 0;
    const due = this.worldService.repository.listDueActivityPlans(
      this.clock.now().toISOString(),
      characterId,
      membership.worldId,
    );
    let settled = 0;
    for (const plan of due) {
      const schedule = this.safeSchedule(plan.scheduleItemId);
      if (!schedule) continue;
      this.settlePlan(characterId, plan, schedule);
      settled += 1;
    }
    return settled;
  }

  private settlePlan(
    characterId: string,
    plan: CharacterActivityPlan,
    schedule: ScheduleItem,
  ): WorldEvent {
    const now = this.clock.now().toISOString();
    const event = this.worldService.repository.createEvent({
      id: this.idGenerator.next("world-event"),
      worldId: plan.worldId,
      ...(plan.placeId ? { placeId: plan.placeId } : {}),
      type: plan.capabilityId === "travel" ? "travel" : "activity",
      summary: plan.summary,
      salience: plan.salience,
      source: "autonomy",
      startsAt: schedule.startAt ?? now,
      ...(schedule.endAt ? { endsAt: schedule.endAt } : {}),
      idempotencyKey: `settled:${plan.id}`,
      participantIds: [characterId],
      createdAt: now,
      updatedAt: now,
    });
    if (
      plan.placeId &&
      (!this.options.canProjectRuntime || this.options.canProjectRuntime(characterId))
    ) {
      this.worldService.setCharacterRuntime(characterId, {
        placeId: plan.placeId,
        activity: "自由活动",
        availability: "free",
        expectedUntil: null,
      });
    }
    this.rememberEvent(characterId, event);
    if (schedule.status === "scheduled") this.scheduleService.complete(schedule.id);
    this.worldService.repository.updateActivityPlan({
      ...plan,
      status: "settled",
      updatedAt: now,
      settledAt: now,
    });
    this.enqueueProactive(characterId, event);
    return event;
  }

  private rememberEvent(characterId: string, event: WorldEvent): void {
    if (event.salience < 0.5) return;
    this.rpService.writeMemory({
      realm: "roleplay",
      scope: "character",
      type: "plot_event",
      key: `world-event:${event.id}`,
      content: event.summary,
      sourceSessionId: `world-${event.worldId}`,
      sourceMessageId: event.id,
      characterId,
      salience: event.salience,
      confidence: 1,
      confirmed: true,
      tags: ["world", "autonomy", event.worldId, ...(event.placeId ? [event.placeId] : [])],
      idempotencyKey: `world-event-memory:${event.id}:${characterId}`,
    });
  }

  private enqueueProactive(characterId: string, event: WorldEvent): ProactiveMessage | undefined {
    const policy = this.worldService.repository.getPolicy(characterId);
    if (!policy?.proactiveEnabled || event.salience < 0.65) return undefined;
    const now = this.clock.now().toISOString();
    return this.worldService.repository.createProactiveMessage({
      id: this.idGenerator.next("proactive"),
      characterId,
      worldEventId: event.id,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async deliverPending(characterId: string, ignoreQuietHours = false): Promise<number> {
    const policy = this.worldService.repository.getPolicy(characterId);
    if (!policy?.proactiveEnabled || !this.options.messenger || !this.options.conversationForCharacter) return 0;
    const life = this.worldService.getCharacterLife(characterId);
    if (!life.world) return 0;
    if (!ignoreQuietHours && inQuietHours(this.clock.now(), life.world.timezone, policy)) return 0;
    const today = localDateKey(this.clock.now(), life.world.timezone);
    const deliveredToday = this.worldService.repository.listProactiveMessages({
      characterId,
      status: "delivered",
      limit: 100,
    }).filter((message) => message.deliveredAt && localDateKey(new Date(message.deliveredAt), life.world!.timezone) === today).length;
    if (deliveredToday >= policy.dailyMessageLimit) return 0;
    const pending = this.worldService.repository.listProactiveMessages({
      characterId,
      status: "pending",
      limit: 20,
    }).reverse().find((message) => {
      if (!message.lastError) return true;
      return this.clock.now().getTime() - new Date(message.updatedAt).getTime() >= 10 * 60_000;
    });
    if (!pending) return 0;
    const conversation = await this.options.conversationForCharacter(characterId);
    if (!conversation) return 0;
    if (this.options.canDeliverProactive && !this.options.canDeliverProactive(conversation.sessionId, characterId)) return 0;
    const event = this.worldService.repository.getEvent(pending.worldEventId);
    if (!event) return 0;
    const character = this.rpService.getCharacter(characterId);
    try {
      const delivery = await this.options.messenger({
        characterId,
        characterName: character.name,
        sessionId: conversation.sessionId,
        event,
        world: life.world,
        place: event.placeId ? life.places.find((place) => place.id === event.placeId) : undefined,
        recentConversation: conversation.recentConversation,
      });
      if (!delivery?.text.trim()) throw new Error("proactive message model returned empty text");
      const now = this.clock.now().toISOString();
      this.worldService.repository.updateProactiveMessage({
        ...pending,
        sessionId: delivery.sessionId,
        text: delivery.text.trim(),
        status: "delivered",
        attempts: pending.attempts + 1,
        lastError: undefined,
        updatedAt: now,
        deliveredAt: now,
      });
      this.worldService.repository.upsertPolicy({
        ...policy,
        lastProactiveAt: now,
        updatedAt: now,
      });
      return 1;
    } catch (error) {
      const attempts = pending.attempts + 1;
      this.worldService.repository.updateProactiveMessage({
        ...pending,
        status: attempts >= 3 ? "failed" : "pending",
        attempts,
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        updatedAt: this.clock.now().toISOString(),
      });
      return 0;
    }
  }

  private safeSchedule(id: string): ScheduleItem | undefined {
    try {
      return this.scheduleService.get(id);
    } catch {
      return undefined;
    }
  }
}

function parsePlannerOutput(output: unknown): unknown[] {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const activities = (output as Record<string, unknown>).activities;
    return Array.isArray(activities) ? activities : [];
  }
  if (typeof output !== "string") return [];
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    return Array.isArray(parsed.activities) ? parsed.activities : [];
  } catch {
    return [];
  }
}

function validateProposals(
  values: unknown[],
  places: Array<{ id: string; capabilityIds: WorldCapabilityId[] }>,
  now: Date,
): WorldActivityProposal[] {
  const placeMap = new Map(places.map((place) => [place.id, place]));
  const horizon = now.getTime() + 30 * 60 * 60_000;
  const proposals: WorldActivityProposal[] = [];
  for (const value of values.slice(0, 8)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const placeId = cleanString(item.placeId);
    const capabilityId = cleanString(item.capabilityId) as WorldCapabilityId;
    const place = placeId ? placeMap.get(placeId) : undefined;
    if (!place || (capabilityId !== "travel" && !place.capabilityIds.includes(capabilityId))) continue;
    const start = new Date(cleanString(item.startAt));
    const end = new Date(cleanString(item.endAt));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start.getTime() < now.getTime() + 5 * 60_000 || start.getTime() > horizon) continue;
    const duration = end.getTime() - start.getTime();
    if (duration < 15 * 60_000 || duration > 4 * 60 * 60_000) continue;
    const title = cleanString(item.title).slice(0, 120);
    const summary = cleanString(item.summary).slice(0, 800);
    if (!title || !summary) continue;
    proposals.push({
      title,
      placeId,
      capabilityId,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      summary,
      salience: boundedUnit(item.salience, 0.55),
    });
  }
  return proposals.sort((left, right) => left.startAt.localeCompare(right.startAt));
}

function fallbackProposals(
  characterId: string,
  localDate: string,
  places: Array<{ id: string; name: string; capabilityIds: WorldCapabilityId[] }>,
  now: Date,
): WorldActivityProposal[] {
  if (!places.length) return [];
  const offsets = [30, 240, 480];
  return offsets.map((minutes, index) => {
    const place = places[stableIndex(`${characterId}:${localDate}:place:${index}`, places.length)];
    const capabilityId = place.capabilityIds[
      stableIndex(`${characterId}:${localDate}:capability:${index}`, place.capabilityIds.length)
    ] ?? "observe";
    const start = new Date(now.getTime() + minutes * 60_000);
    const end = new Date(start.getTime() + (capabilityId === "rest" ? 90 : 60) * 60_000);
    const activity = worldCapabilities[capabilityId].defaultActivity;
    return {
      title: `${worldCapabilities[capabilityId].label} · ${place.name}`,
      placeId: place.id,
      capabilityId,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      summary: `在${place.name}${activity}`,
      salience: index === 1 ? 0.7 : 0.52,
    };
  });
}

function stableIndex(value: string, size: number): number {
  if (size <= 1) return 0;
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % size;
}

function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function localClock(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((entry) => entry.type === "hour")?.value ?? "00";
  const minute = parts.find((entry) => entry.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function inQuietHours(date: Date, timezone: string, policy: CharacterAutonomyPolicy): boolean {
  const current = localClock(date, timezone);
  if (policy.quietStart === policy.quietEnd) return false;
  return policy.quietStart < policy.quietEnd
    ? current >= policy.quietStart && current < policy.quietEnd
    : current >= policy.quietStart || current < policy.quietEnd;
}

function capabilityAvailability(capabilityId: WorldCapabilityId) {
  if (capabilityId === "rest") return "resting" as const;
  if (capabilityId === "travel") return "traveling" as const;
  if (["socialize", "communicate", "observe"].includes(capabilityId)) return "free" as const;
  return "busy" as const;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedUnit(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}
