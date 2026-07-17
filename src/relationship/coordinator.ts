import { randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ContextLogEntry } from "../domain/types.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import { relationshipStateMcpModuleId } from "../modules/catalog.js";
import { parseRelationshipExtraction } from "./extractor.js";
import type { RelationshipRepository } from "./repository.js";
import type { RelationshipService } from "./service.js";
import type {
  RelationshipCoordinatorStatus,
  RelationshipExtractionInput,
  RelationshipExtractionJob,
  RelationshipExtractor,
} from "./types.js";

export class RelationshipCoordinator {
  private readonly ownerId = randomUUID();
  private scheduled = false;
  private processing?: Promise<void>;
  private disposed = false;

  constructor(
    readonly repository: RelationshipRepository,
    readonly service: RelationshipService,
    private readonly modules: AgentModuleCatalog,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly extractor: RelationshipExtractor,
  ) {
    this.repository.recoverExpired(this.now());
    this.schedule();
  }

  enqueueTurn(log: ContextLogEntry, context: { characterId?: string }): RelationshipExtractionJob | undefined {
    if (log.status !== "completed" || !context.characterId) return undefined;
    const enabled = this.modules.isEnabled(relationshipStateMcpModuleId);
    const triggered = hasRelationshipSignal(log.requestText);
    const now = this.now();
    const job = this.repository.createJob({
      id: this.idGenerator.next("relationship-job"),
      idempotencyKey: `turn:${log.id}`,
      sourceContextLogId: log.id,
      sessionId: log.sessionId,
      characterId: context.characterId,
      mode: log.mode,
      triggerReason: !enabled ? "module_disabled" : triggered ? "relationship_signal_detected" : "no_relationship_signal",
      status: enabled && triggered ? "pending" : "skipped",
      attempts: 0,
      maxAttempts: 3,
      inputTokenEstimate: enabled && triggered
        ? estimateTokens(log.requestText) + estimateTokens(log.reply) + 280
        : 0,
      resultCount: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (job.status === "pending") this.schedule();
    return job;
  }

  status(): RelationshipCoordinatorStatus {
    return {
      enabled: this.modules.isEnabled(relationshipStateMcpModuleId),
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
    if (this.disposed || this.scheduled) return;
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
      if (!this.modules.isEnabled(relationshipStateMcpModuleId)) {
        this.repository.finish(job.id, "skipped", { resultCount: 0 }, this.now(), claim);
        return;
      }
      const log = this.repository.getContextLog(job.sourceContextLogId);
      if (!log) throw new Error("source context log is unavailable");
      if ([...log.requestText].length > 8_000 || [...log.reply].length > 12_000) {
        throw new Error("source turn exceeds relationship extraction limits");
      }
      const input: RelationshipExtractionInput = {
        mode: job.mode,
        characterId: job.characterId,
        sourceSessionId: job.sessionId,
        sourceContextLogId: job.sourceContextLogId,
        userText: log.requestText,
        assistantText: log.reply,
      };
      const raw = await this.extractor(input);
      if (this.disposed || claimLost) return;
      if (!this.repository.renewClaim(job.id, this.ownerId, claimToken, this.leaseExpiry(), this.now())) return;
      if (!this.modules.isEnabled(relationshipStateMcpModuleId)) {
        this.repository.finish(job.id, "skipped", { durationMs: Date.now() - started, resultCount: 0 }, this.now(), claim);
        return;
      }
      const event = this.service.applyExtraction(input, parseRelationshipExtraction(raw));
      this.repository.finish(job.id, "completed", {
        durationMs: Date.now() - started,
        resultCount: event ? 1 : 0,
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

  private now(): string {
    return this.clock.now().toISOString();
  }

  private leaseExpiry(): string {
    return new Date(this.clock.now().getTime() + 30_000).toISOString();
  }
}

export function hasRelationshipSignal(text: string): boolean {
  const normalized = text.trim();
  if ([...normalized].length < 2) return false;
  return /(?:谢谢|感谢|辛苦|支持|相信|信任|答应|承诺|陪我|想你|喜欢你|爱你|在乎你|抱抱|拥抱|亲吻|亲你|对不起|抱歉|原谅|和好|吵架|生气|讨厌你|恨你|失望|骗我|背叛|不尊重|越界|别再|不要这样|秘密|只告诉你|成功了|做到了|thank|trust|promise|miss you|like you|love you|hug|kiss|sorry|forgive|argue|angry|hate you|disappointed|betray|boundary|secret)/iu.test(normalized);
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
