import { randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ContextLogEntry } from "../domain/types.js";
import type { InteractionService } from "../interaction/service.js";
import type { InteractionTransitionResult } from "../interaction/types.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import {
  interactionStateMcpModuleId,
  relationshipStateMcpModuleId,
  worldStateMcpModuleId,
} from "../modules/catalog.js";
import type { RelationshipRepository } from "../relationship/repository.js";
import type { RelationshipService } from "../relationship/service.js";
import type {
  RelationshipCoordinatorStatus,
  RelationshipExtractionJob,
} from "../relationship/types.js";
import { parsePostTurnAnalysis, stablePostTurnAnalyzerPrompt } from "./extractor.js";
import type { WorldService } from "../world/service.js";
import type {
  PostTurnAnalysisInput,
  PostTurnAnalysisKind,
  PostTurnAnalyzer,
  PostTurnEnqueueContext,
} from "./types.js";

export class PostTurnCoordinator {
  private readonly ownerId = randomUUID();
  private scheduled = false;
  private processing?: Promise<void>;

  get isBusy(): boolean { return Boolean(this.processing); }
  private disposed = false;
  private readonly enabled: boolean;

  constructor(
    readonly repository: RelationshipRepository,
    readonly relationshipService: RelationshipService,
    private readonly interactionService: InteractionService,
    private readonly worldService: WorldService,
    private readonly modules: AgentModuleCatalog,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly analyzer: PostTurnAnalyzer,
    private readonly onInteractionApplied: (result: InteractionTransitionResult) => void = () => undefined,
    options: { enabled?: boolean } = {},
  ) {
    this.enabled = options.enabled !== false;
    if (!this.enabled) return;
    this.repository.recoverExpired(this.now());
    this.schedule();
  }

  enqueueTurn(log: ContextLogEntry, context: PostTurnEnqueueContext): RelationshipExtractionJob | undefined {
    if (!this.enabled) return undefined;
    if (log.status !== "completed" || !context.characterId) return undefined;
    const relationshipRequested = this.modules.isEnabled(relationshipStateMcpModuleId);
    const interaction = this.interactionService.get(log.sessionId, { conversationSpace: "normal" });
    const start = context.interactionStateAtTurnStart;
    const interactionRequested = this.modules.isEnabled(interactionStateMcpModuleId) &&
      log.mode === "sms" &&
      start?.characterId === context.characterId &&
      start.continuity === "canonical" &&
      start.presence === "co_present" &&
      interaction?.characterId === context.characterId &&
      interaction.continuity === "canonical" &&
      interaction.presence === "co_present" &&
      !interaction.pendingEventId &&
      interaction.revision === start.revision;
    const worldAttributes = log.mode === "sms" && this.modules.isEnabled(worldStateMcpModuleId)
      ? this.worldService.attributeAnalysisContext(context.characterId)
      : undefined;
    const analysisKinds: PostTurnAnalysisKind[] = [
      ...(relationshipRequested ? ["relationship" as const] : []),
      ...(interactionRequested ? ["interaction" as const] : []),
      ...(worldAttributes ? ["world_attributes" as const] : []),
    ];
    const now = this.now();
    const enabled = analysisKinds.length > 0;
    const job = this.repository.createJob({
      id: this.idGenerator.next("post-turn-job"),
      idempotencyKey: `turn:${log.id}`,
      sourceContextLogId: log.id,
      sessionId: log.sessionId,
      characterId: context.characterId,
      mode: log.mode,
      triggerReason: triggerReason(analysisKinds),
      analysisKinds,
      ...(interactionRequested ? {
        interactionPresence: "co_present" as const,
        interactionRevision: interaction.revision,
      } : {}),
      status: enabled ? "pending" : "skipped",
      attempts: 0,
      maxAttempts: 3,
      inputTokenEstimate: enabled
        ? estimateTurnTokens([log]) + estimateTokens(stablePostTurnAnalyzerPrompt) +
          estimateTokens(JSON.stringify(worldAttributes ?? {})) + 350
        : 0,
      resultCount: 0,
      relationshipResultCount: 0,
      interactionResultCount: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (job.status === "pending") this.schedule();
    return job;
  }

  status(): RelationshipCoordinatorStatus {
    const relationshipEnabled = this.modules.isEnabled(relationshipStateMcpModuleId);
    const interactionFallbackEnabled = this.modules.isEnabled(interactionStateMcpModuleId);
    const worldAttributeAnalysisEnabled = this.modules.isEnabled(worldStateMcpModuleId);
    return {
      enabled: relationshipEnabled || interactionFallbackEnabled || worldAttributeAnalysisEnabled,
      relationshipEnabled,
      interactionFallbackEnabled,
      worldAttributeAnalysisEnabled,
      pendingCount: this.repository.pendingCount(),
      estimatedTokensLast24Hours: this.repository.estimatedTokensSince(
        new Date(this.clock.now().getTime() - 24 * 60 * 60_000).toISOString(),
      ),
      recentJobs: this.repository.listRecentJobs(20).map(({ ownerId: _owner, claimToken: _claim, ...job }) => job),
    };
  }

  retry(id: string): RelationshipExtractionJob {
    const job = this.repository.retry(id, this.now());
    this.schedule();
    return job;
  }

  async drain(): Promise<void> {
    if (!this.enabled) return;
    this.schedule();
    while (this.scheduled || this.processing) {
      await this.processing;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.repository.releaseOwner(this.ownerId, this.now());
  }

  private schedule(): void {
    if (!this.enabled || this.disposed || this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.disposed) return;
      const processing = this.processAvailable();
      const tracked = processing.finally(() => {
        if (this.processing === tracked) this.processing = undefined;
      });
      this.processing = tracked;
    }, 0);
  }

  private async processAvailable(): Promise<void> {
    for (const job of this.repository.listRunnable(this.now(), 10)) {
      if (this.disposed) return;
      await this.processJob(job);
    }
    if (!this.disposed && this.repository.listRunnable(this.now(), 1).length) this.schedule();
  }

  private async processJob(job: RelationshipExtractionJob): Promise<void> {
    const claimToken = randomUUID();
    const claimed = this.repository.claim(job.id, this.ownerId, claimToken, this.now(), this.leaseExpiry());
    if (!claimed) return;
    const claim = { ownerId: this.ownerId, claimToken };
    let claimLost = false;
    const heartbeat = setInterval(() => {
      if (this.disposed) return;
      try {
        if (!this.repository.renewClaim(job.id, this.ownerId, claimToken, this.leaseExpiry(), this.now())) claimLost = true;
      } catch {
        claimLost = true;
      }
    }, 10_000);
    heartbeat.unref();
    const started = Date.now();
    try {
      const requestedAnalyses = this.activeAnalyses(claimed);
      if (!requestedAnalyses.length) {
        this.repository.finish(job.id, "skipped", { resultCount: 0 }, this.now(), claim);
        return;
      }
      const log = this.repository.getContextLog(job.sourceContextLogId);
      if (!log) throw new Error("source context log is unavailable");
      const periodicReview = job.triggerReason.startsWith("periodic_relationship_review");
      const reviewLogs = periodicReview
        ? [...this.repository.listRecentQuietTurns(job.characterId, job.id, 7)].reverse()
        : [];
      const sourceLogs = [...reviewLogs, log];
      if (sourceLogs.some((entry) => [...entry.requestText].length > 8_000 || [...entry.reply].length > 12_000)) {
        throw new Error("source turn exceeds post-turn analysis limits");
      }
      const currentRelationship = requestedAnalyses.includes("relationship")
        ? this.relationshipService.ensureState(job.characterId)
        : undefined;
      const interaction = requestedAnalyses.includes("interaction")
        ? this.interactionInput(job)
        : undefined;
      const worldAttributes = requestedAnalyses.includes("world_attributes")
        ? this.worldAttributeInput(job)
        : undefined;
      const completedWorldActions = worldAttributes
        ? this.completedWorldActions(log, job.characterId, worldAttributes.worldId)
        : [];
      const input: PostTurnAnalysisInput = {
        mode: job.mode,
        characterId: job.characterId,
        sourceSessionId: job.sessionId,
        sourceContextLogId: job.sourceContextLogId,
        userText: log.requestText,
        assistantText: log.reply,
        reviewKind: periodicReview ? "periodic" : "single_turn",
        requestedAnalyses,
        ...(periodicReview ? {
          reviewTurns: sourceLogs.map((entry) => ({
            sourceContextLogId: entry.id,
            userText: entry.requestText,
            assistantText: entry.reply,
          })),
        } : {}),
        ...(currentRelationship ? {
          currentRelationship: {
            stage: currentRelationship.stage,
            bondFacets: currentRelationship.bondFacets,
            romanceStatus: currentRelationship.romanceStatus,
          },
        } : {}),
        ...(interaction ? { interaction } : {}),
        ...(worldAttributes ? { worldAttributes } : {}),
        ...(completedWorldActions.length ? { completedWorldActions } : {}),
      };
      const raw = await this.analyzer(input);
      if (this.disposed || claimLost) return;
      if (!this.repository.renewClaim(job.id, this.ownerId, claimToken, this.leaseExpiry(), this.now())) return;
      const fresh = this.repository.getJob(job.id);
      if (!fresh) return;
      const activeAfterAnalysis = this.activeAnalyses(fresh);
      const analysis = parsePostTurnAnalysis(raw);
      const relationshipEvent = activeAfterAnalysis.includes("relationship")
        ? this.relationshipService.applyExtraction(input, analysis.relationship)
        : undefined;
      const interactionResult = activeAfterAnalysis.includes("interaction") && fresh.interactionRevision
        ? this.interactionService.applyPostTurnDeparture({
            sessionId: fresh.sessionId,
            characterId: fresh.characterId,
            mode: fresh.mode,
            scope: { conversationSpace: "normal" },
            sourceContextLogId: fresh.sourceContextLogId,
            expectedRevision: fresh.interactionRevision,
            userText: log.requestText,
            assistantText: log.reply,
            decision: analysis.interaction,
          })
        : undefined;
      const worldAttributeEvents = activeAfterAnalysis.includes("world_attributes") && worldAttributes
        ? this.worldService.applyAttributeAnalysis({
            context: worldAttributes,
            decisions: analysis.worldAttributes,
            source: "post_turn_analysis",
            sourceReferenceId: fresh.sourceContextLogId,
            evidenceTexts: [
              log.requestText,
              log.reply,
              ...completedWorldActions.map((action) => action.summary),
            ],
          })
        : [];
      if (interactionResult) {
        try {
          this.onInteractionApplied(interactionResult);
        } catch {
          // The canonical transition is already durable; optional audit reporting is non-fatal.
        }
      }
      const relationshipResultCount = relationshipEvent ? 1 : 0;
      const interactionResultCount = interactionResult ? 1 : 0;
      const worldAttributeResultCount = worldAttributeEvents.length;
      this.repository.finish(job.id, "completed", {
        durationMs: Date.now() - started,
        resultCount: relationshipResultCount + interactionResultCount + worldAttributeResultCount,
        relationshipResultCount,
        interactionResultCount,
      }, this.now(), claim);
    } catch (error) {
      if (this.disposed) return;
      this.repository.finish(job.id, "failed", {
        durationMs: Date.now() - started,
        resultCount: 0,
        lastError: truncateError(error),
      }, this.now(), claim);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private activeAnalyses(job: RelationshipExtractionJob): PostTurnAnalysisKind[] {
    return job.analysisKinds.filter((kind) => {
      if (kind === "relationship") return this.modules.isEnabled(relationshipStateMcpModuleId);
      if (kind === "interaction") {
        return this.modules.isEnabled(interactionStateMcpModuleId) && Boolean(this.interactionInput(job));
      }
      return this.modules.isEnabled(worldStateMcpModuleId) && Boolean(this.worldAttributeInput(job));
    });
  }

  private worldAttributeInput(job: RelationshipExtractionJob): PostTurnAnalysisInput["worldAttributes"] | undefined {
    return job.mode === "sms" ? this.worldService.attributeAnalysisContext(job.characterId) : undefined;
  }

  private completedWorldActions(
    log: ContextLogEntry,
    characterId: string,
    worldId: string,
  ): NonNullable<PostTurnAnalysisInput["completedWorldActions"]> {
    const seen = new Set<string>();
    return log.actions.flatMap((action) => {
      if (action.status !== "completed" || action.actionType !== "perform_place_action") return [];
      const eventId = typeof action.payload.worldEventId === "string" ? action.payload.worldEventId : "";
      const capabilityId = typeof action.payload.capabilityId === "string" ? action.payload.capabilityId : "";
      if (!eventId || !capabilityId || seen.has(eventId)) return [];
      const event = this.worldService.repository.getEvent(eventId);
      if (
        !event || event.worldId !== worldId || event.source !== "agent_tool" ||
        !event.participantIds.includes(characterId)
      ) return [];
      seen.add(eventId);
      return [{
        actionType: "perform_place_action" as const,
        eventId,
        summary: event.summary,
        capabilityId,
        ...(event.placeId ? { placeId: event.placeId } : {}),
      }];
    }).slice(0, 8);
  }

  private interactionInput(job: RelationshipExtractionJob): PostTurnAnalysisInput["interaction"] | undefined {
    if (job.mode !== "sms" || job.interactionPresence !== "co_present" || !job.interactionRevision) return undefined;
    const state = this.interactionService.get(job.sessionId, { conversationSpace: "normal" });
    if (
      !state ||
      state.characterId !== job.characterId ||
      state.continuity !== "canonical" ||
      state.presence !== "co_present" ||
      state.pendingEventId ||
      state.revision !== job.interactionRevision
    ) return undefined;
    return {
      sessionId: job.sessionId,
      characterId: job.characterId,
      continuity: "canonical",
      presenceAtTurnStart: "co_present",
      currentPresence: "co_present",
      expectedRevision: job.interactionRevision,
      ...(state.location ? { location: state.location } : {}),
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private leaseExpiry(): string {
    return new Date(this.clock.now().getTime() + 30_000).toISOString();
  }
}

function triggerReason(kinds: PostTurnAnalysisKind[]): string {
  if (kinds.length > 1) return "private_turn_post_review";
  if (kinds[0] === "relationship") return "private_turn_review";
  if (kinds[0] === "interaction") return "private_turn_interaction_review";
  if (kinds[0] === "world_attributes") return "private_turn_world_attribute_review";
  return "all_post_turn_consumers_inactive";
}

function estimateTurnTokens(logs: ContextLogEntry[]): number {
  return logs.reduce((total, log) => total + estimateTokens(log.requestText) + estimateTokens(log.reply), 0);
}

function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 1_980)}...[truncated]`;
}
