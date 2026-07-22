import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { RpService } from "../rp/service.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleItem } from "../schedule/types.js";
import {
  deriveProactiveTopic,
  evaluateProactiveCandidate,
  scoreProactiveCandidate,
  type ProactiveBlockReason,
} from "./proactive-policy.js";
import { WorldValidationError, type WorldService } from "./service.js";
import {
  worldCapabilities,
  type CharacterActivityPlan,
  type CharacterAutonomyPolicy,
  type CharacterContactRequest,
  type CharacterContactRequestResult,
  type ProactiveMessage,
  type ProactiveMessenger,
  type WorldActivityProposal,
  type WorldAutonomyTickResult,
  type WorldCapabilityId,
  type WorldEvent,
  type WorldPlanner,
  type WorldStoryEvent,
} from "./types.js";

type ConversationSnapshot = {
  sessionId: string;
  recentConversation: Array<{ role: "user" | "assistant"; text: string; sentAt?: string }>;
  lastUserAt?: string;
  lastConversationAt?: string;
  lastConversationRole?: "user" | "assistant";
};

export type WorldAutonomyCoordinatorOptions = {
  planner?: WorldPlanner;
  messenger?: ProactiveMessenger;
  conversationForCharacter?: (characterId: string) => Promise<ConversationSnapshot | undefined>;
  proactiveBlockReason?: (sessionId: string, characterId: string) => ProactiveBlockReason | undefined;
  canProjectRuntime?: (characterId: string) => boolean;
  storySnapshot?: (worldId: string) => { activeEvent?: WorldStoryEvent };
  intervalMs?: number;
};

export class WorldAutonomyCoordinator {
  private timer?: NodeJS.Timeout;
  private running?: Promise<WorldAutonomyTickResult>;
  private nudgeQueue: Promise<void> = Promise.resolve();
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

  nudge(characterId: string): Promise<WorldAutonomyTickResult> {
    const operation = this.nudgeQueue.then(async () => {
      const active = this.running;
      if (active) await active;
      return this.tick(characterId);
    });
    this.nudgeQueue = operation.then(() => undefined, () => undefined);
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
    const story = this.options.storySnapshot?.(life.world.id);
    if (story?.activeEvent?.participantIds.includes(characterId)) {
      return {
        plans: life.plans.filter((plan) => plan.status === "planned"),
        fallbackUsed: false,
      };
    }
    const worldCharacters = this.worldService.repository.listMemberships(life.world.id).map((membership) => {
      const member = this.rpService.getCharacter(membership.characterId);
      const runtime = this.worldService.repository.getRuntime(membership.characterId);
      return {
        characterId: member.id,
        name: member.name,
        ...(runtime?.placeId ? { placeId: runtime.placeId } : {}),
        activity: runtime?.activity ?? "自由活动",
        availability: runtime?.availability ?? "free" as const,
      };
    });
    let proposals: WorldActivityProposal[] = [];
    let fallbackUsed = false;
    let plannerOutputValid = false;
    let proposedCount = 0;
    if (this.options.planner) {
      try {
        const output = await this.options.planner({
          characterId,
          characterName: character.name,
          soulMarkdown: character.soulMarkdown,
          world: life.world,
          places: life.places,
          currentState: life.runtime,
          ...(life.membership.homePlaceId ? { homePlaceId: life.membership.homePlaceId } : {}),
          existingSchedule: existingSchedule.map((item) => ({
            title: item.title,
            ...(item.startAt ? { startAt: item.startAt } : {}),
            ...(item.endAt ? { endAt: item.endAt } : {}),
          })),
          recentEvents: life.events.slice(0, 8).reverse().map((event) => ({
            summary: event.summary,
            startsAt: event.startsAt,
            ...(event.placeId ? { placeId: event.placeId } : {}),
            participantIds: [...event.participantIds],
          })),
          ...(story?.activeEvent ? { activeStoryEvent: story.activeEvent } : {}),
          worldCharacters,
          now: this.clock.now().toISOString(),
          localDate,
        });
        const parsed = parsePlannerOutput(output);
        plannerOutputValid = parsed.valid;
        proposedCount = parsed.activities.length;
        proposals = validateProposals(
          parsed.activities,
          life.places,
          this.clock.now(),
          existingSchedule,
          life.runtime,
        );
      } catch {
        proposals = [];
      }
    }
    fallbackUsed = !plannerOutputValid || (proposedCount > 0 && !proposals.length);

    const created: CharacterActivityPlan[] = [];
    for (const [index, proposal] of proposals.slice(0, 3).entries()) {
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

  requestCharacterContact(input: CharacterContactRequest): CharacterContactRequestResult {
    const sourceMembership = this.worldService.repository.getMembership(input.sourceCharacterId);
    if (!sourceMembership) {
      throw new WorldValidationError("the requesting character must belong to a shared world");
    }
    if (input.sourceCharacterId === input.targetCharacterId) {
      throw new WorldValidationError("a character cannot request contact from themself");
    }
    const targetMembership = this.worldService.repository.getMembership(input.targetCharacterId);
    if (!targetMembership || targetMembership.worldId !== sourceMembership.worldId) {
      throw new WorldValidationError("the target character must belong to the same shared world");
    }
    const targetPolicy = this.worldService.repository.getPolicy(input.targetCharacterId);
    if (!targetPolicy?.proactiveEnabled) {
      return { accepted: false, reason: "target_proactive_disabled" };
    }
    const requestText = cleanString(input.requestText).replace(/\s+/gu, " ").slice(0, 500);
    if (!requestText) throw new WorldValidationError("contact request text is required");
    const sourceSessionId = cleanString(input.sourceSessionId);
    if (!sourceSessionId) throw new WorldValidationError("source session id is required");
    const idempotencyKey = cleanString(input.idempotencyKey);
    if (!idempotencyKey) throw new WorldValidationError("contact request idempotency key is required");
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const target = this.rpService.getCharacter(input.targetCharacterId);
    const now = this.clock.now().toISOString();

    return this.worldService.repository.transaction(() => {
      const event = this.worldService.repository.findEventByIdempotencyKey(idempotencyKey) ??
        this.worldService.repository.createEvent({
          id: this.idGenerator.next("world-event"),
          worldId: sourceMembership.worldId,
          type: "interaction",
          summary: `${source.name}请${target.name}在方便时联系用户。`,
          salience: 0.9,
          source: "agent_tool",
          startsAt: now,
          idempotencyKey,
          participantIds: [source.id, target.id],
          createdAt: now,
          updatedAt: now,
        });
      const existing = this.worldService.repository.getProactiveMessageByEvent(event.id);
      const proactiveMessage = existing ?? this.enqueueProactive(target.id, event, {
        topic: {
          topicKey: `character.contact:${source.id}`,
          topicLabel: `来自${source.name}的联系请求`,
        },
        decisionDetails: {
          kind: "character_contact",
          sourceCharacterId: source.id,
          sourceCharacterName: source.name,
          sourceSessionId,
          requestText,
        },
      });
      if (!proactiveMessage) return { accepted: false, reason: "target_proactive_disabled" };
      return { accepted: true, event, proactiveMessage };
    });
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
    await this.deliverPending(characterId, { force: true, preferredEventId: event.id });
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

  private enqueueProactive(
    characterId: string,
    event: WorldEvent,
    options: {
      topic?: { topicKey: string; topicLabel: string };
      decisionDetails?: Record<string, unknown>;
    } = {},
  ): ProactiveMessage | undefined {
    const policy = this.worldService.repository.getPolicy(characterId);
    if (!policy?.proactiveEnabled || event.salience < 0.45) return undefined;
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const place = event.placeId ? this.worldService.repository.getPlace(event.placeId) : undefined;
    const topic = options.topic ?? deriveProactiveTopic(event, place);
    const topicPolicy = this.worldService.repository.getProactiveTopicPolicy(characterId, topic.topicKey);
    const lastTopicDeliveryAt = this.worldService.repository.listProactiveMessages({
      characterId,
      status: "delivered",
      limit: 500,
    }).find((message) => message.topicKey === topic.topicKey)?.deliveredAt;
    const scored = scoreProactiveCandidate({ event, now: nowDate, topicPolicy, lastTopicDeliveryAt });
    return this.worldService.repository.createProactiveMessage({
      id: this.idGenerator.next("proactive"),
      characterId,
      worldEventId: event.id,
      ...topic,
      candidateScore: scored.score,
      decisionCode: "queued",
      decisionDetails: { ...options.decisionDetails, breakdown: scored.breakdown },
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async deliverPending(
    characterId: string,
    options: { force?: boolean; preferredEventId?: string } = {},
  ): Promise<number> {
    let policy = this.worldService.repository.getPolicy(characterId);
    if (!policy) return 0;
    if (!policy.proactiveEnabled) {
      this.worldService.repository.skipPendingProactiveMessages(
        characterId,
        this.clock.now().toISOString(),
        "policy_disabled",
      );
      return 0;
    }
    if (!this.options.messenger || !this.options.conversationForCharacter) return 0;
    const life = this.worldService.getCharacterLife(characterId);
    if (!life.world) {
      this.worldService.repository.skipPendingProactiveMessages(
        characterId,
        this.clock.now().toISOString(),
        "world_changed",
      );
      return 0;
    }
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    if (policy.proactivePausedUntil && new Date(policy.proactivePausedUntil).getTime() <= nowDate.getTime()) {
      const resumed = { ...policy, proactivePausedUntil: undefined, updatedAt: now };
      delete resumed.proactivePausedUntil;
      policy = this.worldService.repository.upsertPolicy(resumed);
    }
    const today = localDateKey(nowDate, life.world.timezone);
    const deliveredMessages = this.worldService.repository.listProactiveMessages({
      characterId,
      status: "delivered",
      limit: 500,
    });
    const deliveredToday = deliveredMessages.filter((message) =>
      message.deliveredAt && localDateKey(new Date(message.deliveredAt), life.world!.timezone) === today).length;
    const pendingMessages = this.worldService.repository.listProactiveMessages({
      characterId,
      status: "pending",
      limit: 100,
    });
    if (!pendingMessages.length) return 0;
    const conversation = await this.options.conversationForCharacter(characterId);
    const blockReason = conversation
      ? this.options.proactiveBlockReason?.(conversation.sessionId, characterId)
      : "conversation_busy";
    const ready: Array<{ message: ProactiveMessage; event: WorldEvent }> = [];
    for (const pending of pendingMessages) {
      const event = this.worldService.repository.getEvent(pending.worldEventId);
      const topicPolicy = this.worldService.repository.getProactiveTopicPolicy(characterId, pending.topicKey);
      const evaluation = evaluateProactiveCandidate({
        message: pending,
        event,
        policy,
        topicPolicy,
        deliveredMessages,
        deliveredToday,
        now: nowDate,
        inQuietHours: inQuietHours(nowDate, life.world.timezone, policy),
        ...(conversation?.lastUserAt ? { lastUserAt: conversation.lastUserAt } : {}),
        ...(blockReason ? { blockReason } : {}),
        force: options.force,
      });
      const evaluated = this.worldService.repository.updateProactiveMessage({
        ...pending,
        candidateScore: evaluation.score,
        decisionCode: evaluation.decisionCode,
        decisionDetails: { ...pending.decisionDetails, ...evaluation.details },
        status: evaluation.permanent ? "skipped" : "pending",
        updatedAt: now,
      });
      if (event && evaluation.decisionCode === "candidate_ready") ready.push({ message: evaluated, event });
    }
    if (!conversation || !ready.length) return 0;

    ready.sort((left, right) => compareProactiveCandidates(left, right, options.preferredEventId));
    const uniqueTopics = new Map<string, { message: ProactiveMessage; event: WorldEvent }>();
    for (const candidate of ready) {
      const winner = uniqueTopics.get(candidate.message.topicKey);
      if (!winner) {
        uniqueTopics.set(candidate.message.topicKey, candidate);
        continue;
      }
      this.worldService.repository.updateProactiveMessage({
        ...candidate.message,
        status: "skipped",
        decisionCode: "ranked_behind",
        decisionDetails: {
          ...candidate.message.decisionDetails,
          duplicateOf: winner.message.id,
          reason: "newer or higher-scoring candidate for the same topic",
        },
        updatedAt: now,
      });
    }
    const ranked = [...uniqueTopics.values()]
      .sort((left, right) => compareProactiveCandidates(left, right, options.preferredEventId));
    const selected = ranked[0];
    if (!selected) return 0;
    for (const candidate of ranked.slice(1)) {
      this.worldService.repository.updateProactiveMessage({
        ...candidate.message,
        decisionCode: "ranked_behind",
        decisionDetails: {
          ...candidate.message.decisionDetails,
          selectedCandidateId: selected.message.id,
        },
        updatedAt: now,
      });
    }
    const pending = selected.message;
    const event = selected.event;
    const character = this.rpService.getCharacter(characterId);
    const deliveryNow = this.clock.now();
    const lastConversationTime = conversation.lastConversationAt
      ? new Date(conversation.lastConversationAt).getTime()
      : undefined;
    try {
      const delivery = await this.options.messenger({
        characterId,
        characterName: character.name,
        sessionId: conversation.sessionId,
        event,
        candidate: pending,
        world: life.world,
        place: event.placeId ? life.places.find((place) => place.id === event.placeId) : undefined,
        recentConversation: conversation.recentConversation,
        currentTime: deliveryNow.toISOString(),
        ...(conversation.lastConversationAt ? { lastConversationAt: conversation.lastConversationAt } : {}),
        ...(conversation.lastConversationRole ? { lastConversationRole: conversation.lastConversationRole } : {}),
        ...(lastConversationTime === undefined || !Number.isFinite(lastConversationTime) ? {} : {
          elapsedSinceLastConversationSeconds: Math.max(
            0,
            Math.floor((deliveryNow.getTime() - lastConversationTime) / 1_000),
          ),
        }),
      });
      if (delivery?.declined) {
        const declinedAt = this.clock.now().toISOString();
        this.worldService.repository.updateProactiveMessage({
          ...pending,
          sessionId: delivery.sessionId,
          status: "skipped",
          attempts: pending.attempts + 1,
          lastAttemptAt: declinedAt,
          lastError: undefined,
          decisionCode: "character_declined",
          decisionDetails: {
            ...pending.decisionDetails,
            ...(delivery.reason ? { reason: delivery.reason } : {}),
            declinedAt,
          },
          updatedAt: declinedAt,
        });
        return 0;
      }
      if (!delivery?.text.trim()) throw new Error("proactive message model returned empty text");
      const deliveredAt = this.clock.now().toISOString();
      this.worldService.repository.updateProactiveMessage({
        ...pending,
        sessionId: delivery.sessionId,
        text: delivery.text.trim(),
        status: "delivered",
        attempts: pending.attempts + 1,
        lastAttemptAt: deliveredAt,
        lastError: undefined,
        decisionCode: "delivered",
        decisionDetails: { ...pending.decisionDetails, deliveredAt },
        updatedAt: deliveredAt,
        deliveredAt,
      });
      this.worldService.repository.upsertPolicy({
        ...policy,
        lastProactiveAt: deliveredAt,
        updatedAt: deliveredAt,
      });
      return 1;
    } catch (error) {
      const attempts = pending.attempts + 1;
      const attemptedAt = this.clock.now().toISOString();
      const lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      this.worldService.repository.updateProactiveMessage({
        ...pending,
        status: attempts >= 3 ? "failed" : "pending",
        attempts,
        lastAttemptAt: attemptedAt,
        lastError,
        decisionCode: "model_failed",
        decisionDetails: { ...pending.decisionDetails, error: lastError, attempts },
        updatedAt: attemptedAt,
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

function compareProactiveCandidates(
  left: { message: ProactiveMessage; event: WorldEvent },
  right: { message: ProactiveMessage; event: WorldEvent },
  preferredEventId?: string,
): number {
  if (preferredEventId) {
    if (left.event.id === preferredEventId && right.event.id !== preferredEventId) return -1;
    if (right.event.id === preferredEventId && left.event.id !== preferredEventId) return 1;
  }
  if (left.message.candidateScore !== right.message.candidateScore) {
    return right.message.candidateScore - left.message.candidateScore;
  }
  const byTime = right.event.startsAt.localeCompare(left.event.startsAt);
  return byTime || left.message.id.localeCompare(right.message.id);
}

function parsePlannerOutput(output: unknown): { valid: boolean; activities: unknown[] } {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const activities = (output as Record<string, unknown>).activities;
    return Array.isArray(activities) ? { valid: true, activities } : { valid: false, activities: [] };
  }
  if (typeof output !== "string") return { valid: false, activities: [] };
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return { valid: false, activities: [] };
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    return Array.isArray(parsed.activities)
      ? { valid: true, activities: parsed.activities }
      : { valid: false, activities: [] };
  } catch {
    return { valid: false, activities: [] };
  }
}

function validateProposals(
  values: unknown[],
  places: Array<{ id: string; capabilityIds: WorldCapabilityId[] }>,
  now: Date,
  existingSchedule: Array<{ title: string; startAt?: string; endAt?: string }>,
  currentState: { placeId?: string; energy: number },
): WorldActivityProposal[] {
  const placeMap = new Map(places.map((place) => [place.id, place]));
  const horizon = now.getTime() + 30 * 60 * 60_000;
  const candidates: WorldActivityProposal[] = [];
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
    candidates.push({
      title,
      placeId,
      capabilityId,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      summary,
      salience: boundedUnit(item.salience, 0.55),
    });
  }
  const occupied = existingSchedule.flatMap((item) => {
    if (!item.startAt) return [];
    const start = new Date(item.startAt).getTime();
    const end = item.endAt ? new Date(item.endAt).getTime() : start + 60 * 60_000;
    return Number.isFinite(start) && Number.isFinite(end) ? [{ start, end }] : [];
  });
  const accepted: WorldActivityProposal[] = [];
  const seen = new Set<string>();
  let previousPlaceId = currentState.placeId;
  let previousEnd = now.getTime();
  for (const proposal of candidates.sort((left, right) => left.startAt.localeCompare(right.startAt))) {
    const start = new Date(proposal.startAt).getTime();
    const end = new Date(proposal.endAt).getTime();
    const key = `${proposal.title.toLocaleLowerCase()}\0${proposal.placeId}\0${proposal.capabilityId}`;
    if (seen.has(key)) continue;
    if (occupied.some((interval) => start < interval.end && end > interval.start)) continue;
    if (accepted.some((entry) => start < new Date(entry.endAt).getTime() && end > new Date(entry.startAt).getTime())) continue;
    if (currentState.energy < 25 && ["exercise", "work", "study", "create"].includes(proposal.capabilityId)) continue;
    const changedPlace = Boolean(previousPlaceId && previousPlaceId !== proposal.placeId);
    const transitionMinutes = (start - previousEnd) / 60_000;
    if (changedPlace && proposal.capabilityId !== "travel" && transitionMinutes < 30) continue;
    if (proposal.capabilityId === "travel" && previousPlaceId === proposal.placeId) continue;
    accepted.push(proposal);
    occupied.push({ start, end });
    seen.add(key);
    previousPlaceId = proposal.placeId;
    previousEnd = end;
    if (accepted.length >= 3) break;
  }
  return accepted;
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
