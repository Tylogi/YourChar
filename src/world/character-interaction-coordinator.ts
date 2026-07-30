import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import {
  type CharacterCapabilityId,
  type CharacterTaskRoute,
  type CharacterCapabilityService,
} from "../organization/index.js";
import type { RpService } from "../rp/service.js";
import type { CharacterChannelService } from "./character-channel-service.js";
import type { WorldConversationService } from "./conversation-service.js";
import { WorldValidationError, type WorldService } from "./service.js";
import type {
  CharacterChannel,
  CharacterChannelEpisode,
  CharacterChannelMessage,
  CharacterInteractionActor,
  CharacterInteractionActorInput,
  CharacterInteractionResult,
  CharacterSocialTickResult,
  WorldEventSource,
} from "./types.js";

const ACTOR_CONTEXT_MESSAGE_LIMIT = 16;
const ACTOR_TEXT_LIMIT = 4_000;

export type CharacterInteractionCoordinatorOptions = {
  actor: CharacterInteractionActor;
  onAction?: (
    actionType: string,
    status: "completed" | "failed" | "blocked",
    details: Record<string, unknown>,
  ) => void;
};

export class CharacterInteractionCoordinator {
  private readonly channelQueues = new Map<string, Promise<unknown>>();

  constructor(
    readonly channels: CharacterChannelService,
    readonly capabilities: CharacterCapabilityService,
    private readonly worldService: WorldService,
    private readonly worldConversationService: WorldConversationService,
    private readonly rpService: RpService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly options: CharacterInteractionCoordinatorOptions,
  ) {}

  async sendCharacterMessage(input: {
    sourceCharacterId: string;
    targetCharacterId: string;
    message: string;
    idempotencyKey: string;
    parentSessionId?: string;
    source?: "agent_tool" | "manual";
  }): Promise<CharacterInteractionResult> {
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const target = this.rpService.getCharacter(input.targetCharacterId);
    const message = boundedRequired(input.message, "character message", ACTOR_TEXT_LIMIT);
    const started = this.channels.startEpisode({
      initiatorCharacterId: source.id,
      targetCharacterId: target.id,
      kind: "contact",
      source: input.source ?? "agent_tool",
      idempotencyKey: input.idempotencyKey,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      title: `${source.name}与${target.name}的私聊`,
      objective: message,
    });
    return this.runLocked(started.channel.id, () =>
      this.runSeededExchange(started.channel, started.episode, message, "direct_reply"));
  }

  async requestCharacterHelp(input: {
    sourceCharacterId: string;
    targetCharacterId?: string;
    requiredCapabilityIds?: CharacterCapabilityId[];
    task: string;
    context?: string;
    message?: string;
    idempotencyKey: string;
    parentSessionId?: string;
  }): Promise<CharacterInteractionResult> {
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const task = boundedRequired(input.task, "collaboration task", 2_000);
    const routing = this.capabilities.routeTask({
      sourceCharacterId: source.id,
      task,
      ...(input.targetCharacterId ? { targetCharacterId: input.targetCharacterId } : {}),
      ...(input.requiredCapabilityIds?.length
        ? { requiredCapabilityIds: input.requiredCapabilityIds }
        : {}),
    });
    const target = this.rpService.getCharacter(routing.selected!.characterId);
    const context = boundedOptional(input.context, 1_500);
    const opening = boundedOptional(input.message, 2_000) ||
      `${target.name}，能帮我处理一下这件事吗？${task}`;
    const objective = [task, context ? `补充背景：${context}` : ""].filter(Boolean).join("\n");
    const started = this.channels.startEpisode({
      initiatorCharacterId: source.id,
      targetCharacterId: target.id,
      kind: "collaboration",
      source: "agent_tool",
      idempotencyKey: input.idempotencyKey,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      title: `${source.name}委托${target.name}`,
      objective,
    });
    return this.runLocked(started.channel.id, () =>
      this.runSeededExchange(
        started.channel,
        started.episode,
        opening,
        "collaboration_result",
        routing,
      ));
  }

  async startSocialExchange(input: {
    sourceCharacterId: string;
    targetCharacterId: string;
    idempotencyKey: string;
    source?: "autonomy" | "manual";
    topic?: string;
  }): Promise<CharacterInteractionResult> {
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const target = this.rpService.getCharacter(input.targetCharacterId);
    const topic = boundedOptional(input.topic, 800);
    const started = this.channels.startEpisode({
      initiatorCharacterId: source.id,
      targetCharacterId: target.id,
      kind: "social",
      source: input.source ?? "autonomy",
      idempotencyKey: input.idempotencyKey,
      title: `${source.name}与${target.name}的日常`,
      objective: topic,
    });
    return this.runLocked(started.channel.id, () =>
      this.runGeneratedSocialExchange(started.channel, started.episode));
  }

  async tick(characterId?: string): Promise<CharacterSocialTickResult> {
    const result: CharacterSocialTickResult = { created: 0, failed: 0 };
    const memberships = this.worldService.repository.listMemberships();
    const worldIds = [...new Set(memberships.map((entry) => entry.worldId))].sort();
    for (const worldId of worldIds) {
      const members = memberships
        .filter((entry) => entry.worldId === worldId)
        .filter((entry) => !characterId || entry.characterId === characterId)
        .sort((left, right) => left.characterId.localeCompare(right.characterId));
      let worldCreated = false;
      for (const sourceMembership of members) {
        const sourceId = sourceMembership.characterId;
        const world = this.worldService.getWorld(worldId);
        const policy = this.worldService.repository.getPolicy(sourceId);
        if (!policy?.socialEnabled || policy.socialDailyLimit <= 0) continue;
        if (isQuietTime(this.clock.now(), world.timezone, policy.quietStart, policy.quietEnd)) continue;
        if (isWithinCooldown(this.clock.now(), policy.lastSocialAt, policy.socialCooldownMinutes)) continue;
        const runtime = this.worldService.repository.getRuntime(sourceId);
        if (!runtime || runtime.availability !== "free") continue;
        const activeEvent = this.worldConversationService.repository.getOpenStoryEvent(worldId);
        if (activeEvent?.participantIds.includes(sourceId)) continue;
        const [dayStart, dayEnd] = localDayBounds(this.clock.now(), world.timezone);
        const dailyCount = this.channels.repository.countAutonomySocialEpisodes(
          sourceId,
          dayStart.toISOString(),
          dayEnd.toISOString(),
        );
        if (dailyCount >= policy.socialDailyLimit) continue;
        const target = this.selectSocialTarget(sourceId, worldId, activeEvent?.participantIds ?? []);
        if (!target) continue;
        const localDate = localDateKey(this.clock.now(), world.timezone);
        const retrySlot = Math.floor(this.clock.now().getTime() / (30 * 60_000));
        try {
          const exchange = await this.startSocialExchange({
            sourceCharacterId: sourceId,
            targetCharacterId: target,
            source: "autonomy",
            idempotencyKey:
              `character-social:${worldId}:${sourceId}:${target}:${localDate}:${dailyCount}:${retrySlot}`,
          });
          if (exchange.episode.status === "completed" || exchange.episode.status === "declined") {
            result.created += 1;
            worldCreated = true;
            break;
          }
          result.failed += 1;
        } catch (error) {
          result.failed += 1;
          this.options.onAction?.("character_social_exchange", "failed", {
            worldId,
            sourceCharacterId: sourceId,
            targetCharacterId: target,
            error: errorText(error),
          });
        }
      }
      if (worldCreated) continue;
    }
    return result;
  }

  private selectSocialTarget(
    sourceCharacterId: string,
    worldId: string,
    activeParticipantIds: string[],
  ): string | undefined {
    const blocked = new Set(activeParticipantIds);
    const candidates = this.worldService.repository.listMemberships(worldId)
      .filter((entry) => entry.characterId !== sourceCharacterId)
      .filter((entry) => !blocked.has(entry.characterId))
      .filter((entry) => {
        const policy = this.worldService.repository.getPolicy(entry.characterId);
        const runtime = this.worldService.repository.getRuntime(entry.characterId);
        if (!policy?.socialEnabled || runtime?.availability !== "free") return false;
        const world = this.worldService.getWorld(worldId);
        return !isQuietTime(this.clock.now(), world.timezone, policy.quietStart, policy.quietEnd) &&
          !isWithinCooldown(this.clock.now(), policy.lastSocialAt, policy.socialCooldownMinutes);
      })
      .map((entry) => {
        const relationship = this.worldConversationService.repository.getCharacterRelationship(
          worldId,
          sourceCharacterId,
          entry.characterId,
        );
        return {
          characterId: entry.characterId,
          score: (relationship?.affinity ?? 50) + (relationship?.trust ?? 40) +
            Math.floor((relationship?.intimacy ?? 15) / 2) - (relationship?.tension ?? 0),
        };
      })
      .sort((left, right) => right.score - left.score || left.characterId.localeCompare(right.characterId));
    return candidates[0]?.characterId;
  }

  private async runSeededExchange(
    channel: CharacterChannel,
    episode: CharacterChannelEpisode,
    opening: string,
    purpose: "direct_reply" | "collaboration_result",
    routing?: CharacterTaskRoute,
  ): Promise<CharacterInteractionResult> {
    const current = this.channels.repository.getEpisode(episode.id) ?? episode;
    if (isTerminal(current.status)) {
      this.recordCollaborationEvidence(current, routing);
      return this.resultFor(channel, current, undefined, routing);
    }
    let running = this.channels.updateEpisode(current.id, { status: "running" });
    try {
      const existingMessages = this.channels.repository.listMessages(channel.id, 500)
        .filter((message) => message.episodeId === running.id);
      if (!existingMessages.some((message) => message.senderCharacterId === running.initiatorCharacterId)) {
        this.channels.appendCharacterMessage({
          channelId: channel.id,
          episodeId: running.id,
          senderCharacterId: running.initiatorCharacterId,
          kind: running.kind === "collaboration" ? "task" : "message",
          content: opening,
        });
      }
      const response = await this.callActor(running, running.targetCharacterId, purpose, opening);
      running = this.channels.updateEpisode(running.id, { modelCalls: running.modelCalls + 1 });
      const declineReason = parseDecline(response);
      if (declineReason !== undefined) {
        this.channels.appendSystemMessage({
          channelId: channel.id,
          episodeId: running.id,
          content: declineReason ? `对方暂未接受：${declineReason}` : "对方暂未接受这次交流。",
        });
        const declined = this.channels.updateEpisode(running.id, {
          status: "declined",
          resultText: declineReason,
          completed: true,
        });
        this.options.onAction?.("character_channel_exchange", "blocked", {
          episodeId: declined.id,
          channelId: channel.id,
          reason: declineReason || "declined",
        });
        this.recordCollaborationEvidence(declined, routing);
        return this.resultFor(channel, declined, undefined, routing);
      }
      const reply = boundedRequired(response, "character reply", ACTOR_TEXT_LIMIT);
      this.channels.appendCharacterMessage({
        channelId: channel.id,
        episodeId: running.id,
        senderCharacterId: running.targetCharacterId,
        kind: running.kind === "collaboration" ? "result" : "message",
        content: reply,
      });
      const completed = this.channels.updateEpisode(running.id, {
        status: "completed",
        resultText: reply,
        completed: true,
      });
      this.settleEpisodeSafely(completed);
      this.options.onAction?.("character_channel_exchange", "completed", {
        episodeId: completed.id,
        channelId: channel.id,
        kind: completed.kind,
      });
      this.recordCollaborationEvidence(completed, routing);
      return this.resultFor(channel, completed, reply, routing);
    } catch (error) {
      const failed = this.failEpisode(running, error);
      this.recordCollaborationEvidence(failed, routing);
      throw new CharacterInteractionExecutionError(failed.id, errorText(error));
    }
  }

  private async runGeneratedSocialExchange(
    channel: CharacterChannel,
    episode: CharacterChannelEpisode,
  ): Promise<CharacterInteractionResult> {
    const current = this.channels.repository.getEpisode(episode.id) ?? episode;
    if (isTerminal(current.status)) return this.resultFor(channel, current);
    let running = this.channels.updateEpisode(current.id, { status: "running" });
    try {
      const existing = this.channels.repository.listMessages(channel.id, 500)
        .filter((message) => message.episodeId === running.id);
      let opening = existing.find((message) =>
        message.senderCharacterId === running.initiatorCharacterId)?.content;
      if (!opening) {
        const generated = await this.callActor(running, running.initiatorCharacterId, "social_opening");
        running = this.channels.updateEpisode(running.id, { modelCalls: running.modelCalls + 1 });
        const declineReason = parseDecline(generated);
        if (declineReason !== undefined) {
          const declined = this.channels.updateEpisode(running.id, {
            status: "declined",
            resultText: declineReason,
            completed: true,
          });
          this.updateSocialTimestamps(declined);
          return this.resultFor(channel, declined);
        }
        opening = boundedRequired(generated, "social opening", ACTOR_TEXT_LIMIT);
        this.channels.appendCharacterMessage({
          channelId: channel.id,
          episodeId: running.id,
          senderCharacterId: running.initiatorCharacterId,
          content: opening,
        });
      }
      const response = await this.callActor(running, running.targetCharacterId, "social_reply", opening);
      running = this.channels.updateEpisode(running.id, { modelCalls: running.modelCalls + 1 });
      const declineReason = parseDecline(response);
      if (declineReason !== undefined) {
        this.channels.appendSystemMessage({
          channelId: channel.id,
          episodeId: running.id,
          content: declineReason ? `对方没有继续回应：${declineReason}` : "对方没有继续回应。",
        });
        const declined = this.channels.updateEpisode(running.id, {
          status: "declined",
          resultText: declineReason,
          completed: true,
        });
        this.updateSocialTimestamps(running);
        return this.resultFor(channel, declined);
      }
      const reply = boundedRequired(response, "social reply", ACTOR_TEXT_LIMIT);
      this.channels.appendCharacterMessage({
        channelId: channel.id,
        episodeId: running.id,
        senderCharacterId: running.targetCharacterId,
        content: reply,
      });
      const completed = this.channels.updateEpisode(running.id, {
        status: "completed",
        resultText: reply,
        completed: true,
      });
      this.updateSocialTimestamps(completed);
      this.settleEpisodeSafely(completed);
      this.options.onAction?.("character_social_exchange", "completed", {
        episodeId: completed.id,
        channelId: channel.id,
        sourceCharacterId: completed.initiatorCharacterId,
        targetCharacterId: completed.targetCharacterId,
      });
      return this.resultFor(channel, completed, reply);
    } catch (error) {
      const failed = this.failEpisode(running, error);
      throw new CharacterInteractionExecutionError(failed.id, errorText(error));
    }
  }

  private async callActor(
    episode: CharacterChannelEpisode,
    actorCharacterId: string,
    purpose: CharacterInteractionActorInput["purpose"],
    openingMessage?: string,
  ): Promise<string> {
    const actor = this.rpService.getCharacter(actorCharacterId);
    const peerId = actorCharacterId === episode.initiatorCharacterId
      ? episode.targetCharacterId
      : episode.initiatorCharacterId;
    const peer = this.rpService.getCharacter(peerId);
    const actorRuntime = this.worldService.repository.getRuntime(actor.id);
    const peerRuntime = this.worldService.repository.getRuntime(peer.id);
    const relationship = this.worldConversationService.repository.getCharacterRelationship(
      episode.worldId,
      actor.id,
      peer.id,
    );
    const input: CharacterInteractionActorInput = {
      purpose,
      channelId: episode.channelId,
      episodeId: episode.id,
      actorCharacterId: actor.id,
      actorName: actor.name,
      actorSoulMarkdown: actor.soulMarkdown,
      peerCharacterId: peer.id,
      peerName: peer.name,
      world: this.worldService.getWorld(episode.worldId),
      ...(actorRuntime ? { actorRuntime } : {}),
      ...(peerRuntime ? { peerRuntime } : {}),
      ...(actorRuntime?.placeId ? {
        actorPlace: this.worldService.repository.getPlace(actorRuntime.placeId),
      } : {}),
      ...(peerRuntime?.placeId ? {
        peerPlace: this.worldService.repository.getPlace(peerRuntime.placeId),
      } : {}),
      ...(relationship ? { relationship } : {}),
      recentMessages: this.channels.repository.listMessages(episode.channelId, ACTOR_CONTEXT_MESSAGE_LIMIT),
      ...(episode.objective ? { objective: episode.objective } : {}),
      ...(openingMessage ? { openingMessage } : {}),
      ...(purpose === "collaboration_result"
        ? {
            taskIdentity: this.capabilities.getTaskIdentity(actor.id),
            taskSkill: this.capabilities.getTaskSkill(actor.id),
          }
        : {}),
      currentTime: this.clock.now().toISOString(),
    };
    return this.options.actor(input);
  }

  private settleEpisode(episode: CharacterChannelEpisode): void {
    const eventKey = `character-channel-event:${episode.id}`;
    if (this.worldService.repository.findEventByIdempotencyKey(eventKey)) return;
    const source = this.rpService.getCharacter(episode.initiatorCharacterId);
    const target = this.rpService.getCharacter(episode.targetCharacterId);
    const messages = this.channels.repository.listMessages(episode.channelId, 500)
      .filter((message) => message.episodeId === episode.id && message.senderType === "character");
    const summary = episode.kind === "collaboration"
      ? `${source.name}向${target.name}请求协作，${target.name}给出了回应。`
      : `${source.name}与${target.name}进行了一次私下交流。`;
    const now = this.clock.now().toISOString();
    this.worldService.repository.createEvent({
      id: this.idGenerator.next("world-event"),
      worldId: episode.worldId,
      type: "interaction",
      summary,
      salience: episode.kind === "collaboration" ? 0.72 : 0.58,
      source: episode.source as WorldEventSource,
      startsAt: episode.createdAt,
      endsAt: episode.completedAt ?? now,
      idempotencyKey: eventKey,
      participantIds: [source.id, target.id],
      createdAt: now,
      updatedAt: now,
    });
    const transcriptSummary = messages
      .map((message) => {
        const speaker = message.senderCharacterId === source.id ? source.name : target.name;
        return `${speaker}：${boundedOptional(message.content, 180)}`;
      })
      .join("；");
    for (const character of [source, target]) {
      this.worldConversationService.createObservation({
        worldId: episode.worldId,
        characterId: character.id,
        knowledge: "direct",
        summary: boundedOptional(`${summary}${transcriptSummary ? ` ${transcriptSummary}` : ""}`, 900),
        salience: episode.kind === "collaboration" ? 0.72 : 0.58,
      });
      this.rpService.writeMemory({
        realm: "roleplay",
        scope: "character",
        type: episode.kind === "collaboration" ? "plot_event" : "relationship_event",
        key: `character-channel:${episode.id}`,
        content: boundedOptional(`${summary}${transcriptSummary ? ` ${transcriptSummary}` : ""}`, 1_000),
        sourceSessionId: `character-channel-${episode.channelId}`,
        sourceMessageId: episode.id,
        characterId: character.id,
        salience: episode.kind === "collaboration" ? 0.72 : 0.58,
        confidence: 1,
        confirmed: true,
        tags: ["world", "character-channel", episode.worldId, episode.kind],
        idempotencyKey: `character-channel-memory:${episode.id}:${character.id}`,
      });
    }
    const sourceDelta = episode.kind === "collaboration"
      ? { affinityDelta: 1, trustDelta: 2, tensionDelta: 0, intimacyDelta: 0 }
      : { affinityDelta: 1, trustDelta: 1, tensionDelta: 0, intimacyDelta: 1 };
    const targetDelta = episode.kind === "collaboration"
      ? { affinityDelta: 1, trustDelta: 1, tensionDelta: 0, intimacyDelta: 0 }
      : sourceDelta;
    this.worldConversationService.applyRelationshipDelta({
      worldId: episode.worldId,
      subjectCharacterId: source.id,
      objectCharacterId: target.id,
      ...sourceDelta,
      summary,
    });
    this.worldConversationService.applyRelationshipDelta({
      worldId: episode.worldId,
      subjectCharacterId: target.id,
      objectCharacterId: source.id,
      ...targetDelta,
      summary,
    });
  }

  private settleEpisodeSafely(episode: CharacterChannelEpisode): void {
    try {
      this.settleEpisode(episode);
    } catch (error) {
      this.options.onAction?.("character_channel_settlement", "failed", {
        episodeId: episode.id,
        channelId: episode.channelId,
        error: errorText(error),
      });
    }
  }

  private updateSocialTimestamps(episode: CharacterChannelEpisode): void {
    const now = this.clock.now().toISOString();
    for (const characterId of [episode.initiatorCharacterId, episode.targetCharacterId]) {
      const policy = this.worldService.repository.getPolicy(characterId);
      if (policy) {
        this.worldService.repository.upsertPolicy({
          ...policy,
          lastSocialAt: now,
          updatedAt: now,
        });
      }
    }
  }

  private failEpisode(
    episode: CharacterChannelEpisode,
    error: unknown,
  ): CharacterChannelEpisode {
    const reason = errorText(error);
    try {
      this.channels.appendSystemMessage({
        channelId: episode.channelId,
        episodeId: episode.id,
        content: "本次角色交流未完成。",
      });
    } catch {
      // Preserve the original execution failure.
    }
    const failed = this.channels.updateEpisode(episode.id, {
      status: "failed",
      failureReason: reason,
      completed: true,
    });
    this.options.onAction?.("character_channel_exchange", "failed", {
      episodeId: failed.id,
      channelId: failed.channelId,
      error: reason,
    });
    return failed;
  }

  private resultFor(
    channel: CharacterChannel,
    episode: CharacterChannelEpisode,
    responseText?: string,
    routing?: CharacterTaskRoute,
  ): CharacterInteractionResult {
    const messages = this.channels.repository.listMessages(channel.id, 500)
      .filter((message) => message.episodeId === episode.id);
    return {
      channel: this.channels.getChannel(channel.id),
      episode: this.channels.repository.getEpisode(episode.id) ?? episode,
      messages,
      ...(responseText || episode.resultText ? { responseText: responseText || episode.resultText } : {}),
      ...(routing ? { routing } : {}),
    };
  }

  private recordCollaborationEvidence(
    episode: CharacterChannelEpisode,
    routing?: CharacterTaskRoute,
  ): void {
    if (episode.kind !== "collaboration" || !routing?.requiredCapabilityIds.length) return;
    const outcome = episode.status === "completed"
      ? "completed"
      : episode.status === "declined"
        ? "declined"
        : episode.status === "cancelled"
          ? "cancelled"
          : episode.status === "failed"
            ? "failed"
            : undefined;
    if (!outcome) return;
    try {
      this.capabilities.recordTaskEvidence({
        characterId: episode.targetCharacterId,
        capabilityIds: routing.requiredCapabilityIds,
        sourceTaskId: episode.id,
        outcome,
        summary: [
          episode.objective,
          episode.resultText ? `结果：${episode.resultText}` : "",
          episode.failureReason ? `失败：${episode.failureReason}` : "",
        ].filter(Boolean).join("\n"),
      });
    } catch (error) {
      this.options.onAction?.("character_capability_evidence", "failed", {
        episodeId: episode.id,
        characterId: episode.targetCharacterId,
        error: errorText(error),
      });
    }
  }

  private runLocked<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.channelQueues.set(channelId, current);
    return current.finally(() => {
      if (this.channelQueues.get(channelId) === current) this.channelQueues.delete(channelId);
    });
  }
}

export class CharacterInteractionExecutionError extends Error {
  readonly code = "CHARACTER_INTERACTION_FAILED";

  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = "CharacterInteractionExecutionError";
  }
}

function isTerminal(status: CharacterChannelEpisode["status"]): boolean {
  return ["completed", "declined", "failed", "cancelled"].includes(status);
}

function parseDecline(value: string): string | undefined {
  const normalized = value.trim();
  const match = normalized.match(/^\[DECLINE\](?::\s*|\s+)?([\s\S]*)$/iu);
  return match ? boundedOptional(match[1], 500) : undefined;
}

function boundedRequired(value: string, label: string, maximum: number): string {
  const normalized = boundedOptional(value, maximum);
  if (!normalized) throw new WorldValidationError(`${label} is required`);
  return normalized;
}

function boundedOptional(value: string | undefined, maximum: number): string {
  return [...String(value ?? "").trim()].slice(0, maximum).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800);
}

function isWithinCooldown(now: Date, lastAt: string | undefined, minutes: number): boolean {
  if (!lastAt) return false;
  const timestamp = new Date(lastAt).getTime();
  return Number.isFinite(timestamp) && now.getTime() - timestamp < minutes * 60_000;
}

function isQuietTime(now: Date, timezone: string, start: string, end: string): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((entry) => entry.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((entry) => entry.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const starts = startHour * 60 + startMinute;
  const ends = endHour * 60 + endMinute;
  if (starts === ends) return false;
  return starts < ends
    ? current >= starts && current < ends
    : current >= starts || current < ends;
}

function localDateKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function localDayBounds(now: Date, timezone: string): [Date, Date] {
  const localDate = localDateKey(now, timezone);
  const start = zonedDateTimeToInstant(`${localDate}T00:00:00`, timezone);
  const nextLocalDate = localDateKey(new Date(start.getTime() + 36 * 60 * 60_000), timezone);
  const end = zonedDateTimeToInstant(`${nextLocalDate}T00:00:00`, timezone);
  return [start, end];
}

function zonedDateTimeToInstant(localIso: string, timezone: string): Date {
  const assumedUtc = new Date(`${localIso}Z`);
  let candidate = new Date(assumedUtc.getTime() - timezoneOffsetMs(assumedUtc, timezone));
  candidate = new Date(assumedUtc.getTime() - timezoneOffsetMs(candidate, timezone));
  return candidate;
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  const represented = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second),
  );
  return represented - date.getTime();
}
