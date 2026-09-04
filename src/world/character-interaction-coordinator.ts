import { randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import {
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
  CharacterCollaborationJob,
  CharacterCollaborationReportOutcome,
  CharacterInteractionActor,
  CharacterInteractionActorInput,
  CharacterInteractionSceneComposer,
  CharacterInteractionSceneDraft,
  CharacterInteractionResult,
  CharacterSocialTickResult,
  WorldEventSource,
} from "./types.js";

const ACTOR_CONTEXT_MESSAGE_LIMIT = 16;
const ACTOR_TEXT_LIMIT = 4_000;

export type CharacterInteractionCoordinatorOptions = {
  actor: CharacterInteractionActor;
  sceneComposer: CharacterInteractionSceneComposer;
  onCollaborationSettled?: (
    result: CharacterInteractionResult,
    signal: AbortSignal,
  ) => CharacterCollaborationReportOutcome | Promise<CharacterCollaborationReportOutcome>;
  onAction?: (
    actionType: string,
    status: "completed" | "failed" | "blocked",
    details: Record<string, unknown>,
  ) => void;
};

export class CharacterInteractionCoordinator {
  private readonly ownerId = randomUUID();
  private readonly channelQueues = new Map<string, Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private started = false;
  private disposed = false;
  private executionScheduled = false;
  private reportScheduled = false;
  private executionRescheduleRequested = false;
  private reportRescheduleRequested = false;
  private executionTimer?: NodeJS.Timeout;
  private reportTimer?: NodeJS.Timeout;
  private executionProcessing?: Promise<void>;
  private reportProcessing?: Promise<void>;

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
    requiredSkillIds?: string[];
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
      ...(input.requiredSkillIds?.length ? { requiredSkillIds: input.requiredSkillIds } : {}),
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

  async queueCharacterHelp(input: {
    sourceCharacterId: string;
    targetCharacterId?: string;
    requiredSkillIds?: string[];
    task: string;
    context?: string;
    message?: string;
    idempotencyKey: string;
    parentSessionId?: string;
  }): Promise<CharacterInteractionResult> {
    if (this.disposed) {
      throw new WorldValidationError("character interaction coordinator is disposed");
    }
    const source = this.rpService.getCharacter(input.sourceCharacterId);
    const task = boundedRequired(input.task, "collaboration task", 2_000);
    const existingEpisode = this.channels.repository.findEpisodeByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existingEpisode) {
      const existingJob = this.channels.repository.getCollaborationJob(existingEpisode.id);
      if (
        !existingJob ||
        existingEpisode.kind !== "collaboration" ||
        existingEpisode.initiatorCharacterId !== source.id
      ) {
        throw new WorldValidationError(
          "idempotency key belongs to a different character interaction",
        );
      }
      this.start();
      this.scheduleExecutions();
      this.scheduleReports();
      if (existingEpisode.status === "completed") {
        await this.finalizeCompletedEpisode(existingEpisode);
      }
      return this.resultFor(
        this.channels.getChannel(existingEpisode.channelId),
        existingEpisode,
        undefined,
        existingJob.routing,
      );
    }
    const routing = this.capabilities.routeTask({
      sourceCharacterId: source.id,
      task,
      ...(input.targetCharacterId ? { targetCharacterId: input.targetCharacterId } : {}),
      ...(input.requiredSkillIds?.length ? { requiredSkillIds: input.requiredSkillIds } : {}),
    });
    const target = this.rpService.getCharacter(routing.selected!.characterId);
    const context = boundedOptional(input.context, 1_500);
    const opening = boundedOptional(input.message, 2_000) ||
      `${target.name}，能帮我处理一下这件事吗？${task}`;
    const objective = [task, context ? `补充背景：${context}` : ""].filter(Boolean).join("\n");
    const started = this.channels.startQueuedCollaboration({
      initiatorCharacterId: source.id,
      targetCharacterId: target.id,
      idempotencyKey: input.idempotencyKey,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      title: `${source.name}委托${target.name}`,
      objective,
      openingMessage: opening,
      routing,
    });
    this.start();
    this.scheduleExecutions();
    return this.resultFor(started.channel, started.episode, undefined, started.job.routing);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const now = this.now();
    this.channels.repository.recoverInterruptedCollaborationJobs(now);
    this.channels.repository.failExhaustedCollaborationJobs(
      now,
      "协作任务多次中断，已停止重试。",
    );
    this.channels.repository.reconcileTerminalCollaborationJobs(now);
    this.channels.repository.recoverInterruptedCollaborationReports(now);
    this.scheduleExecutions();
    this.scheduleReports();
  }

  async drain(): Promise<void> {
    if (this.disposed) return;
    this.start();
    this.scheduleExecutions();
    this.scheduleReports();
    while (
      this.executionScheduled ||
      this.reportScheduled ||
      this.executionProcessing ||
      this.reportProcessing
    ) {
      await Promise.all([
        this.executionProcessing ?? Promise.resolve(),
        this.reportProcessing ?? Promise.resolve(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.executionTimer) clearTimeout(this.executionTimer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.executionTimer = undefined;
    this.reportTimer = undefined;
    this.executionScheduled = false;
    this.reportScheduled = false;
    this.executionRescheduleRequested = false;
    this.reportRescheduleRequested = false;
    for (const controller of this.activeControllers) controller.abort();
    const now = this.now();
    this.channels.repository.releaseCollaborationOwner(this.ownerId, now);
    this.channels.repository.releaseCollaborationReportOwner(this.ownerId, now);
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

  private scheduleExecutions(): void {
    if (!this.started || this.disposed) return;
    if (this.executionProcessing) {
      this.executionRescheduleRequested = true;
      return;
    }
    if (this.executionScheduled) return;
    this.executionScheduled = true;
    this.executionTimer = setTimeout(() => {
      this.executionTimer = undefined;
      this.executionScheduled = false;
      if (this.disposed) return;
      const processing = this.processAvailableCollaborations().catch((error) => {
        if (this.disposed) return;
        this.options.onAction?.("character_collaboration_worker", "failed", {
          error: errorText(error),
        });
      });
      const tracked = processing.finally(() => {
        if (this.executionProcessing !== tracked) return;
        this.executionProcessing = undefined;
        if (this.executionRescheduleRequested && !this.disposed) {
          this.executionRescheduleRequested = false;
          this.scheduleExecutions();
        }
      });
      this.executionProcessing = tracked;
    }, 0);
    this.executionTimer.unref();
  }

  private scheduleReports(): void {
    if (!this.started || this.disposed) return;
    if (this.reportProcessing) {
      this.reportRescheduleRequested = true;
      return;
    }
    if (this.reportScheduled) return;
    this.reportScheduled = true;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      this.reportScheduled = false;
      if (this.disposed) return;
      const processing = this.processAvailableCollaborationReports().catch((error) => {
        if (this.disposed) return;
        this.options.onAction?.("character_collaboration_reporter", "failed", {
          error: errorText(error),
        });
      });
      const tracked = processing.finally(() => {
        if (this.reportProcessing !== tracked) return;
        this.reportProcessing = undefined;
        if (this.reportRescheduleRequested && !this.disposed) {
          this.reportRescheduleRequested = false;
          this.scheduleReports();
        }
      });
      this.reportProcessing = tracked;
    }, 0);
    this.reportTimer.unref();
  }

  private async processAvailableCollaborations(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    this.channels.repository.recoverExpiredCollaborationJobs(now);
    this.channels.repository.failExhaustedCollaborationJobs(
      now,
      "协作任务多次中断，已停止重试。",
    );
    this.channels.repository.reconcileTerminalCollaborationJobs(now);
    for (const job of this.channels.repository.listRunnableCollaborationJobs(this.now(), 10)) {
      if (this.disposed) return;
      await this.processCollaborationJob(job);
    }
    if (this.disposed) return;
    this.channels.repository.reconcileTerminalCollaborationJobs(this.now());
    this.scheduleReports();
    if (this.channels.repository.listRunnableCollaborationJobs(this.now(), 1).length) {
      this.scheduleExecutions();
    }
  }

  private async processCollaborationJob(job: CharacterCollaborationJob): Promise<void> {
    if (this.disposed) return;
    const claimToken = randomUUID();
    const claimed = this.channels.repository.claimCollaborationJob(
      job.episodeId,
      this.ownerId,
      claimToken,
      this.now(),
      this.leaseExpiry(),
    );
    if (!claimed) return;
    const claim = { ownerId: this.ownerId, claimToken };
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let claimLost = false;
    const renew = (): boolean => {
      if (this.disposed || controller.signal.aborted || claimLost) return false;
      try {
        const active = this.channels.repository.renewCollaborationClaim(
          claimed.episodeId,
          this.ownerId,
          claimToken,
          this.leaseExpiry(),
          this.now(),
        );
        if (!active) {
          claimLost = true;
          controller.abort();
        }
        return active;
      } catch {
        claimLost = true;
        controller.abort();
        return false;
      }
    };
    const heartbeat = setInterval(renew, 10_000);
    heartbeat.unref();
    try {
      const episode = this.channels.repository.getEpisode(claimed.episodeId);
      if (!episode) throw new Error(`collaboration episode not found: ${claimed.episodeId}`);
      const channel = this.channels.getChannel(episode.channelId);
      const result = await this.runLocked(channel.id, async () => {
        if (!renew()) throw new CharacterCollaborationClaimLostError();
        return this.runSeededExchange(
          channel,
          episode,
          claimed.openingMessage,
          "collaboration_result",
          claimed.routing,
          controller.signal,
          renew,
        );
      });
      if (!renew()) return;
      const status = collaborationJobStatusFor(result.episode.status);
      if (!status) {
        throw new Error(`collaboration did not reach a terminal state: ${result.episode.status}`);
      }
      const finished = this.channels.repository.finishCollaborationJob(
        claimed.episodeId,
        status,
        {
          ...(result.episode.failureReason
            ? { lastError: result.episode.failureReason }
            : {}),
        },
        this.now(),
        claim,
      );
      if (finished) this.scheduleReports();
    } catch (error) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        claimLost ||
        error instanceof CharacterCollaborationClaimLostError
      ) {
        return;
      }
      const current = this.channels.repository.getEpisode(claimed.episodeId);
      let terminal = current;
      if (current && !isTerminal(current.status)) {
        terminal = this.failEpisode(current, error);
        this.recordCollaborationEvidence(terminal, claimed.routing);
      }
      this.channels.repository.finishCollaborationJob(
        claimed.episodeId,
        terminal?.status === "cancelled" ? "cancelled" : "failed",
        { lastError: terminal?.failureReason ?? errorText(error) },
        this.now(),
        claim,
      );
      this.scheduleReports();
    } finally {
      clearInterval(heartbeat);
      this.activeControllers.delete(controller);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  private async processAvailableCollaborationReports(): Promise<void> {
    if (this.disposed) return;
    this.channels.repository.recoverExpiredCollaborationReports(this.now());
    for (
      const episode of this.channels.repository.listReportableCollaborationEpisodes(
        this.now(),
        10,
      )
    ) {
      if (this.disposed) return;
      await this.processCollaborationReport(episode);
    }
    if (
      !this.disposed &&
      this.channels.repository.listReportableCollaborationEpisodes(this.now(), 1).length
    ) {
      this.scheduleReports();
    }
  }

  private async processCollaborationReport(episode: CharacterChannelEpisode): Promise<void> {
    if (this.disposed) return;
    const claimToken = randomUUID();
    const claimed = this.channels.repository.claimCollaborationReport(
      episode.id,
      this.ownerId,
      claimToken,
      this.now(),
      this.leaseExpiry(),
    );
    if (!claimed) return;
    const claim = { ownerId: this.ownerId, claimToken };
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let claimLost = false;
    const renew = (): boolean => {
      if (this.disposed || controller.signal.aborted || claimLost) return false;
      try {
        const active = this.channels.repository.renewCollaborationReportClaim(
          claimed.id,
          this.ownerId,
          claimToken,
          this.leaseExpiry(),
          this.now(),
        );
        if (!active) {
          claimLost = true;
          controller.abort();
        }
        return active;
      } catch {
        claimLost = true;
        controller.abort();
        return false;
      }
    };
    const heartbeat = setInterval(renew, 10_000);
    heartbeat.unref();
    try {
      const job = this.channels.repository.getCollaborationJob(claimed.id);
      if (!job) throw new Error(`collaboration job not found: ${claimed.id}`);
      if (claimed.status === "completed") {
        await this.finalizeCompletedEpisode(claimed, controller.signal);
      }
      const result = this.resultFor(
        this.channels.getChannel(claimed.channelId),
        claimed,
        undefined,
        job.routing,
      );
      const outcome = this.options.onCollaborationSettled
        ? await this.options.onCollaborationSettled(result, controller.signal)
        : { status: "skipped" as const, reason: "no collaboration settlement handler" };
      if (!renew()) return;
      const normalized = normalizeReportOutcome(outcome);
      this.channels.repository.finishCollaborationReport(
        claimed.id,
        normalized.status,
        {
          ...(normalized.status === "failed" ? { error: normalized.error } : {}),
          ...(normalized.metrics ?? {}),
        },
        this.now(),
        claim,
      );
      const measured = this.channels.repository.getEpisode(claimed.id);
      this.options.onAction?.(
        "character_collaboration_report",
        normalized.status === "failed" ? "failed" : "completed",
        {
          episodeId: claimed.id,
          channelId: claimed.channelId,
          reportStatus: normalized.status,
          reportWaitMs: measured?.reportWaitMs ?? claimed.reportWaitMs ?? 0,
          reportGenerationMs: measured?.reportGenerationMs ?? 0,
          reportDeliveryMs: measured?.reportDeliveryMs ?? 0,
          reportModelCalls: measured?.reportModelCalls ?? 0,
          ...(normalized.status === "failed" ? { error: normalized.error } : {}),
          ...(normalized.status === "skipped" && normalized.reason
            ? { reason: normalized.reason }
            : {}),
        },
      );
    } catch (error) {
      if (this.disposed || controller.signal.aborted || claimLost) return;
      if (!renew()) return;
      const message = errorText(error);
      this.channels.repository.finishCollaborationReport(
        claimed.id,
        "failed",
        { error: message },
        this.now(),
        claim,
      );
      this.options.onAction?.("character_collaboration_report", "failed", {
        episodeId: claimed.id,
        channelId: claimed.channelId,
        error: message,
      });
    } finally {
      clearInterval(heartbeat);
      this.activeControllers.delete(controller);
      if (!controller.signal.aborted) controller.abort();
    }
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
    signal?: AbortSignal,
    claimActive?: () => boolean,
  ): Promise<CharacterInteractionResult> {
    assertInteractionActive(signal, claimActive);
    const current = this.channels.repository.getEpisode(episode.id) ?? episode;
    if (isTerminal(current.status)) {
      if (current.status === "completed") {
        await this.finalizeCompletedEpisode(current);
      }
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
          unread: false,
        });
      }
      const existingResponse = existingMessages.find((message) =>
        message.senderCharacterId === running.targetCharacterId &&
        message.kind === (running.kind === "collaboration" ? "result" : "message"));
      if (existingResponse) {
        const completed = this.channels.updateEpisode(running.id, {
          status: "completed",
          resultText: existingResponse.content,
          completed: true,
        });
        await this.finalizeCompletedEpisode(completed, signal);
        this.recordCollaborationEvidence(completed, routing);
        return this.resultFor(channel, completed, existingResponse.content, routing);
      }
      const tracked = await this.callTrackedActor(
        running,
        running.targetCharacterId,
        purpose,
        opening,
        signal,
        routing,
      );
      const response = tracked.response;
      running = tracked.episode;
      assertInteractionActive(signal, claimActive);
      const declineReason = parseDecline(response);
      if (declineReason !== undefined) {
        const declined = this.channels.updateEpisode(running.id, {
          status: "declined",
          resultText: declineReason,
          completed: true,
        });
        try {
          this.channels.appendSystemMessage({
            channelId: channel.id,
            episodeId: running.id,
            content: declineReason ? `对方暂未接受：${declineReason}` : "对方暂未接受这次交流。",
          });
        } catch (error) {
          this.options.onAction?.("character_channel_status_message", "failed", {
            episodeId: declined.id,
            channelId: channel.id,
            error: errorText(error),
          });
        }
        this.options.onAction?.("character_channel_exchange", "blocked", {
          episodeId: declined.id,
          channelId: channel.id,
          reason: declineReason || "declined",
          ...targetExecutionMetrics(declined),
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
        unread: false,
      });
      const completed = this.channels.updateEpisode(running.id, {
        status: "completed",
        resultText: reply,
        completed: true,
      });
      await this.finalizeCompletedEpisode(completed, signal);
      this.options.onAction?.("character_channel_exchange", "completed", {
        episodeId: completed.id,
        channelId: channel.id,
        kind: completed.kind,
        ...targetExecutionMetrics(completed),
      });
      this.recordCollaborationEvidence(completed, routing);
      return this.resultFor(channel, completed, reply, routing);
    } catch (error) {
      if (
        signal?.aborted ||
        error instanceof CharacterCollaborationClaimLostError
      ) {
        throw new CharacterCollaborationClaimLostError();
      }
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
    if (isTerminal(current.status)) {
      if (current.status === "completed") {
        await this.finalizeCompletedEpisode(current);
      }
      return this.resultFor(channel, current);
    }
    let running = this.channels.updateEpisode(current.id, { status: "running" });
    try {
      const existing = this.channels.repository.listMessages(channel.id, 500)
        .filter((message) => message.episodeId === running.id);
      let opening = existing.find((message) =>
        message.senderCharacterId === running.initiatorCharacterId)?.content;
      if (!opening) {
        const tracked = await this.callTrackedActor(
          running,
          running.initiatorCharacterId,
          "social_opening",
        );
        const generated = tracked.response;
        running = tracked.episode;
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
          unread: false,
        });
      }
      const tracked = await this.callTrackedActor(
        running,
        running.targetCharacterId,
        "social_reply",
        opening,
      );
      const response = tracked.response;
      running = tracked.episode;
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
        unread: false,
      });
      const completed = this.channels.updateEpisode(running.id, {
        status: "completed",
        resultText: reply,
        completed: true,
      });
      this.updateSocialTimestamps(completed);
      await this.finalizeCompletedEpisode(completed);
      this.options.onAction?.("character_social_exchange", "completed", {
        episodeId: completed.id,
        channelId: channel.id,
        sourceCharacterId: completed.initiatorCharacterId,
        targetCharacterId: completed.targetCharacterId,
        ...targetExecutionMetrics(completed),
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
    signal?: AbortSignal,
    routing?: CharacterTaskRoute,
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
      recentReflections: this.channels.listRecentInteractionReflections({
        characterId: actor.id,
        worldId: episode.worldId,
        peerCharacterId: peer.id,
        limit: 4,
      }),
      ...(episode.objective ? { objective: episode.objective } : {}),
      ...(openingMessage ? { openingMessage } : {}),
      ...(purpose === "collaboration_result"
        ? {
            taskIdentity: this.capabilities.getTaskIdentity(actor.id),
            taskSkill: this.capabilities.getTaskSkill(
              actor.id,
              "normal",
              routing?.selectedSkillIds,
            ),
          }
        : {}),
      currentTime: this.clock.now().toISOString(),
      ...(signal ? { signal } : {}),
    };
    return this.options.actor(input);
  }

  private async callTrackedActor(
    episode: CharacterChannelEpisode,
    actorCharacterId: string,
    purpose: CharacterInteractionActorInput["purpose"],
    openingMessage?: string,
    signal?: AbortSignal,
    routing?: CharacterTaskRoute,
  ): Promise<{ response: string; episode: CharacterChannelEpisode }> {
    let counted = episode;
    const executionStartedAt = performance.now();
    try {
      const response = await this.callActor(
        episode,
        actorCharacterId,
        purpose,
        openingMessage,
        signal,
        routing,
      );
      if (!signal?.aborted) {
        counted = this.recordTargetExecutionDurationSafely(
          episode.id,
          performance.now() - executionStartedAt,
          counted,
        );
      }
      return { response, episode: counted };
    } catch (error) {
      if (!signal?.aborted) {
        this.recordTargetExecutionDurationSafely(
          episode.id,
          performance.now() - executionStartedAt,
          counted,
        );
      }
      throw error;
    }
  }

  private recordTargetExecutionDurationSafely(
    episodeId: string,
    durationMs: number,
    fallback: CharacterChannelEpisode,
  ): CharacterChannelEpisode {
    try {
      return this.channels.recordTargetExecutionDuration(episodeId, durationMs);
    } catch (error) {
      this.options.onAction?.("character_collaboration_metrics", "failed", {
        episodeId,
        metric: "targetExecutionMs",
        error: errorText(error),
      });
      return this.channels.repository.getEpisode(episodeId) ?? fallback;
    }
  }

  private async finalizeCompletedEpisode(
    episode: CharacterChannelEpisode,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = this.channels.repository.getEpisode(episode.id) ?? episode;
    if (current.status !== "completed") return;
    if (this.channels.getInteractionScene(current.id)) {
      this.settleEpisodeSafely(current);
      return;
    }
    const source = this.rpService.getCharacter(current.initiatorCharacterId);
    const target = this.rpService.getCharacter(current.targetCharacterId);
    const sourceRuntime = this.worldService.repository.getRuntime(source.id);
    const targetRuntime = this.worldService.repository.getRuntime(target.id);
    const messages = this.channels.repository.listMessages(current.channelId, 500)
      .filter((message) => message.episodeId === current.id && message.senderType === "character");
    const composerInput = {
      episode: current,
      world: this.worldService.getWorld(current.worldId),
      source: {
        characterId: source.id,
        name: source.name,
        soulMarkdown: source.soulMarkdown,
        ...(sourceRuntime ? { runtime: sourceRuntime } : {}),
        ...(sourceRuntime?.placeId ? {
          place: this.worldService.repository.getPlace(sourceRuntime.placeId),
        } : {}),
        ...(this.worldConversationService.repository.getCharacterRelationship(
          current.worldId,
          source.id,
          target.id,
        ) ? {
          relationshipToPeer:
            this.worldConversationService.repository.getCharacterRelationship(
              current.worldId,
              source.id,
              target.id,
            ),
        } : {}),
        recentReflections: this.channels.listRecentInteractionReflections({
          characterId: source.id,
          worldId: current.worldId,
          peerCharacterId: target.id,
          limit: 4,
        }),
      },
      target: {
        characterId: target.id,
        name: target.name,
        soulMarkdown: target.soulMarkdown,
        ...(targetRuntime ? { runtime: targetRuntime } : {}),
        ...(targetRuntime?.placeId ? {
          place: this.worldService.repository.getPlace(targetRuntime.placeId),
        } : {}),
        ...(this.worldConversationService.repository.getCharacterRelationship(
          current.worldId,
          target.id,
          source.id,
        ) ? {
          relationshipToPeer:
            this.worldConversationService.repository.getCharacterRelationship(
              current.worldId,
              target.id,
              source.id,
            ),
        } : {}),
        recentReflections: this.channels.listRecentInteractionReflections({
          characterId: target.id,
          worldId: current.worldId,
          peerCharacterId: source.id,
          limit: 4,
        }),
      },
      messages,
      currentTime: this.now(),
      ...(signal ? { signal } : {}),
    };
    let draft: CharacterInteractionSceneDraft;
    try {
      draft = normalizeInteractionSceneDraft(
        await this.options.sceneComposer(composerInput),
      );
    } catch (error) {
      this.options.onAction?.("character_interaction_scene", "failed", {
        episodeId: current.id,
        channelId: current.channelId,
        stage: "compose",
        error: errorText(error),
      });
      draft = fallbackInteractionScene({
        episode: current,
        sourceName: source.name,
        targetName: target.name,
        placeName: composerInput.source.place?.name ?? composerInput.target.place?.name,
        messages,
      });
    }
    try {
      const saved = this.channels.saveInteractionScene(
        current.id,
        draft,
        interactionSalience(current),
      );
      this.settleEpisodeSafely(current);
      this.options.onAction?.("character_interaction_scene", "completed", {
        episodeId: current.id,
        channelId: current.channelId,
        created: saved.created,
        reflectionCount: saved.reflections.length,
      });
    } catch (error) {
      this.options.onAction?.("character_interaction_scene", "failed", {
        episodeId: current.id,
        channelId: current.channelId,
        stage: "persist",
        error: errorText(error),
      });
    }
  }

  private settleEpisode(episode: CharacterChannelEpisode): void {
    const eventKey = `character-channel-event:${episode.id}`;
    if (this.worldService.repository.findEventByIdempotencyKey(eventKey)) return;
    const source = this.rpService.getCharacter(episode.initiatorCharacterId);
    const target = this.rpService.getCharacter(episode.targetCharacterId);
    const scene = this.channels.getInteractionScene(episode.id);
    const reflections = this.channels.listInteractionReflections(episode.id);
    const messages = scene ? [] : this.channels.repository.listMessages(episode.channelId, 500)
      .filter((message) => message.episodeId === episode.id && message.senderType === "character");
    const summary = scene?.eventSummary ?? (episode.kind === "collaboration"
      ? `${source.name}向${target.name}请求协作，${target.name}给出了回应。`
      : `${source.name}与${target.name}进行了一次私下交流。`);
    const now = this.clock.now().toISOString();
    this.worldService.repository.createEvent({
      id: this.idGenerator.next("world-event"),
      worldId: episode.worldId,
      type: "interaction",
      summary,
      salience: interactionSalience(episode),
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
      const reflection = reflections.find((entry) => entry.characterId === character.id);
      const memoryContent = reflection
        ? `${summary}\n角色视角：${reflection.summary}`
        : `${summary}${transcriptSummary ? ` ${transcriptSummary}` : ""}`;
      this.worldConversationService.createObservation({
        worldId: episode.worldId,
        characterId: character.id,
        knowledge: "direct",
        summary: boundedOptional(summary, 900),
        salience: interactionSalience(episode),
      });
      this.rpService.writeMemory({
        realm: "roleplay",
        scope: "character",
        type: episode.kind === "collaboration" ? "plot_event" : "relationship_event",
        key: `character-channel:${episode.id}`,
        content: boundedOptional(memoryContent, 1_000),
        sourceSessionId: `character-channel-${episode.channelId}`,
        sourceMessageId: episode.id,
        characterId: character.id,
        salience: interactionSalience(episode),
        confidence: 1,
        confirmed: true,
        tags: [
          "world",
          "character-channel",
          "character-reflection",
          episode.worldId,
          episode.kind,
          character.id === source.id ? target.id : source.id,
        ],
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
    const failed = this.channels.updateEpisode(episode.id, {
      status: "failed",
      failureReason: reason,
      completed: true,
    });
    try {
      this.channels.appendSystemMessage({
        channelId: failed.channelId,
        episodeId: failed.id,
        content: "本次角色交流未完成。",
      });
    } catch {
      // Preserve the original execution failure.
    }
    this.options.onAction?.("character_channel_exchange", "failed", {
      episodeId: failed.id,
      channelId: failed.channelId,
      error: reason,
      ...targetExecutionMetrics(failed),
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
      ...(this.channels.getInteractionScene(episode.id) ? {
        scene: this.channels.getInteractionScene(episode.id),
      } : {}),
      reflections: this.channels.listInteractionReflections(episode.id),
      ...(responseText || episode.resultText ? { responseText: responseText || episode.resultText } : {}),
      ...(routing ? { routing } : {}),
    };
  }

  private recordCollaborationEvidence(
    episode: CharacterChannelEpisode,
    routing?: CharacterTaskRoute,
  ): void {
    if (episode.kind !== "collaboration") return;
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
        skillPackageIds: routing?.selectedSkillIds ?? [],
        sourceTaskId: episode.id,
        outcome,
        summary: [
          episode.objective,
          episode.resultText ? `结果：${episode.resultText}` : "",
          episode.failureReason ? `失败：${episode.failureReason}` : "",
        ].filter(Boolean).join("\n"),
      });
    } catch (error) {
      this.options.onAction?.("character_skill_evaluation", "failed", {
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

  private now(): string {
    return this.clock.now().toISOString();
  }

  private leaseExpiry(): string {
    return new Date(this.clock.now().getTime() + 30_000).toISOString();
  }
}

export class CharacterInteractionExecutionError extends Error {
  readonly code = "CHARACTER_INTERACTION_FAILED";

  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = "CharacterInteractionExecutionError";
  }
}

class CharacterCollaborationClaimLostError extends Error {
  constructor() {
    super("character collaboration claim is no longer active");
    this.name = "CharacterCollaborationClaimLostError";
  }
}

function assertInteractionActive(
  signal?: AbortSignal,
  claimActive?: () => boolean,
): void {
  if (signal?.aborted || (claimActive && !claimActive())) {
    throw new CharacterCollaborationClaimLostError();
  }
}

function collaborationJobStatusFor(
  status: CharacterChannelEpisode["status"],
): Exclude<CharacterCollaborationJob["status"], "queued" | "running"> | undefined {
  if (status === "completed" || status === "declined") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

function normalizeReportOutcome(
  outcome: CharacterCollaborationReportOutcome,
): CharacterCollaborationReportOutcome {
  const metrics = normalizeReportMetrics(outcome?.metrics);
  if (outcome?.status === "delivered") {
    return { status: "delivered", ...(metrics ? { metrics } : {}) };
  }
  if (outcome?.status === "skipped") {
    return {
      status: "skipped",
      ...(boundedOptional(outcome.reason, 800) ? {
        reason: boundedOptional(outcome.reason, 800),
      } : {}),
      ...(metrics ? { metrics } : {}),
    };
  }
  if (outcome?.status === "failed") {
    return {
      status: "failed",
      error: boundedOptional(outcome.error, 800) || "collaboration settlement delivery failed",
      ...(metrics ? { metrics } : {}),
    };
  }
  throw new Error("invalid collaboration settlement outcome");
}

function normalizeReportMetrics(
  metrics: CharacterCollaborationReportOutcome["metrics"],
): NonNullable<CharacterCollaborationReportOutcome["metrics"]> | undefined {
  if (!metrics) return undefined;
  return {
    reportQueueWaitMs: nonNegativeInteger(metrics.reportQueueWaitMs),
    reportGenerationMs: nonNegativeInteger(metrics.reportGenerationMs),
    reportDeliveryMs: nonNegativeInteger(metrics.reportDeliveryMs),
    reportModelCalls: nonNegativeInteger(metrics.reportModelCalls),
  };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function targetExecutionMetrics(
  episode: CharacterChannelEpisode,
): { targetExecutionMs: number; targetModelCalls: number } {
  return {
    targetExecutionMs: nonNegativeInteger(episode.targetExecutionMs ?? 0),
    targetModelCalls: nonNegativeInteger(episode.modelCalls),
  };
}

function isTerminal(status: CharacterChannelEpisode["status"]): boolean {
  return ["completed", "declined", "failed", "cancelled"].includes(status);
}

function parseDecline(value: string): string | undefined {
  const normalized = value.trim();
  const match = normalized.match(/^\[DECLINE\](?::\s*|\s+)?([\s\S]*)$/iu);
  return match ? boundedOptional(match[1], 500) : undefined;
}

function interactionSalience(episode: CharacterChannelEpisode): number {
  return episode.kind === "collaboration" ? 0.72 : 0.58;
}

function normalizeInteractionSceneDraft(
  draft: CharacterInteractionSceneDraft,
): CharacterInteractionSceneDraft {
  return {
    narrativeText: boundedRequired(draft.narrativeText, "interaction scene", 8_000),
    eventSummary: boundedRequired(draft.eventSummary, "interaction event summary", 1_200),
    sourcePerspectiveSummary: boundedRequired(
      draft.sourcePerspectiveSummary,
      "source character perspective",
      600,
    ),
    targetPerspectiveSummary: boundedRequired(
      draft.targetPerspectiveSummary,
      "target character perspective",
      600,
    ),
  };
}

function fallbackInteractionScene(input: {
  episode: CharacterChannelEpisode;
  sourceName: string;
  targetName: string;
  placeName?: string;
  messages: CharacterChannelMessage[];
}): CharacterInteractionSceneDraft {
  const setting = input.placeName ? `在${input.placeName}` : "在这个世界的一隅";
  const renderedMessages = input.messages.slice(0, 4).map((message) => {
    const speaker = message.senderCharacterId === input.episode.initiatorCharacterId
      ? input.sourceName
      : input.targetName;
    const content = boundedOptional(message.content.replace(/\s+/gu, " "), 1_400);
    return `${speaker}说：“${content}”`;
  });
  const action = input.episode.kind === "collaboration"
    ? `${input.sourceName}向${input.targetName}说明了需要协助的事情。`
    : `${input.sourceName}先向${input.targetName}开了口。`;
  const response = renderedMessages.length
    ? renderedMessages.join("\n\n")
    : `${input.targetName}听完后作出了回应。`;
  const narrativeText = boundedRequired(
    `${setting}，${action}\n\n${response}\n\n话音落下后，两人各自记住了这次往来中不同的部分。`,
    "fallback interaction scene",
    8_000,
  );
  const eventSummary = input.episode.kind === "collaboration"
    ? `${input.sourceName}向${input.targetName}提出协作请求，${input.targetName}作出了回应。`
    : `${input.sourceName}主动与${input.targetName}交谈，两人完成了一次私下互动。`;
  return {
    narrativeText,
    eventSummary,
    sourcePerspectiveSummary: input.episode.kind === "collaboration"
      ? `我把需要帮助的事情交代给了${input.targetName}，并记住了对方的回应。`
      : `我主动找${input.targetName}说了话，也留意到了对方回应我的方式。`,
    targetPerspectiveSummary: input.episode.kind === "collaboration"
      ? `${input.sourceName}来找我协助，我按自己的判断给出了回应。`
      : `${input.sourceName}主动来找我交谈，我选择回应，并形成了自己的印象。`,
  };
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
