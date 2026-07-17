import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ContextLogEntry, Mode } from "../domain/types.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import { memoryCoordinatorMcpModuleId } from "../modules/catalog.js";
import type { RoleplayMemoryType, RealityMemoryType } from "../rp/types.js";
import { MemoryLifecycleError, MemoryLifecycleService } from "./lifecycle.js";
import { parseExtractorOutput } from "./extractor.js";
import { MemoryCoordinatorRepository } from "./repository.js";
import type {
  MemoryCoordinatorStatus,
  MemoryExtractionInput,
  MemoryExtractionJob,
  MemoryExtractor,
  MemoryTargetRealm,
} from "./types.js";

export class MemoryCoordinator {
  private readonly ownerId = randomUUID();
  private scheduled = false;
  private processing?: Promise<void>;
  private disposed = false;

  constructor(
    readonly repository: MemoryCoordinatorRepository,
    readonly lifecycle: MemoryLifecycleService,
    private readonly modules: AgentModuleCatalog,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly extractor: MemoryExtractor,
  ) {
    this.repository.recoverExpired(this.now());
    this.schedule();
  }

  enqueueTurn(log: ContextLogEntry, context: { characterId?: string }): MemoryExtractionJob | undefined {
    if (log.status !== "completed") return undefined;
    return this.enqueue(log, context);
  }

  enqueueOutputGuardRecovery(
    log: ContextLogEntry,
    context: { characterId?: string },
  ): MemoryExtractionJob | undefined {
    if (log.status !== "failed" || log.mode !== "sms") return undefined;
    if (!explicitCapture(log.requestText) && !explicitForget(log.requestText)) return undefined;
    return this.enqueue(log, context, "output_guard_exhausted");
  }

  private enqueue(
    log: ContextLogEntry,
    context: { characterId?: string },
    recoveryReason?: "output_guard_exhausted",
  ): MemoryExtractionJob | undefined {
    const realm: MemoryTargetRealm = log.mode === "rp" ? "roleplay" : "reality";
    const characterId = realm === "roleplay" ? context.characterId : undefined;
    if (realm === "roleplay" && !characterId) return undefined;
    const explicit = explicitCapture(log.requestText);
    const forgetting = explicitForget(log.requestText);
    const durable = hasDurableSignal(log.requestText, log.mode);
    const enabled = this.modules.isEnabled(memoryCoordinatorMcpModuleId);
    const triggerKind = explicit || forgetting ? "explicit" : durable ? "durable_signal" : "none";
    const baseTriggerReason = !enabled
      ? "module_disabled"
      : forgetting
        ? "explicit_forget_authorization"
        : explicit
          ? "explicit_remember_authorization"
          : durable
            ? "durable_signal_detected"
            : "no_durable_signal";
    const triggerReason = recoveryReason
      ? `${baseTriggerReason}:${recoveryReason}`
      : baseTriggerReason;
    const now = this.now();
    const sourceMessageId = `message_${shortHash(`${log.sessionId}\0${log.id}`)}`;
    const job = this.repository.createJob({
      id: this.idGenerator.next("memory-job"),
      idempotencyKey: `turn:${log.id}`,
      sourceContextLogId: log.id,
      sessionId: log.sessionId,
      sourceMessageId,
      mode: log.mode,
      realm,
      ...(characterId ? { characterId } : {}),
      triggerKind,
      triggerReason,
      status: enabled && triggerKind !== "none" ? "pending" : "skipped",
      attempts: 0,
      maxAttempts: 3,
      inputTokenEstimate: triggerKind === "durable_signal"
        ? estimateTokens(log.requestText) + estimateTokens(log.reply) + 260
        : 0,
      resultCount: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (job.status === "pending") this.schedule();
    return job;
  }

  status(): MemoryCoordinatorStatus {
    return {
      enabled: this.modules.isEnabled(memoryCoordinatorMcpModuleId),
      pendingCount: this.repository.pendingCount(),
      pendingCandidateCount: this.lifecycle.pendingCandidateCount(),
      estimatedTokensLast24Hours: this.repository.estimatedTokensSince(
        new Date(this.clock.now().getTime() - 24 * 60 * 60_000).toISOString(),
      ),
      recentJobs: this.repository.listRecent(20).map(({ ownerId: _ownerId, claimToken: _claimToken, ...job }) => job),
    };
  }

  retry(id: string): MemoryExtractionJob {
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
    if (this.disposed) return;
    for (const job of this.repository.listRunnable(this.now(), 10)) {
      if (this.disposed) return;
      await this.processJob(job);
    }
    if (this.disposed) return;
    if (this.repository.listRunnable(this.now(), 1).length) this.schedule();
  }

  private async processJob(job: MemoryExtractionJob): Promise<void> {
    if (this.disposed) return;
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
      if (!this.modules.isEnabled(memoryCoordinatorMcpModuleId)) {
        this.repository.finish(job.id, "skipped", { resultCount: 0 }, this.now(), claim);
        return;
      }
      const log = this.repository.getContextLog(job.sourceContextLogId);
      if (!log) throw new Error("source context log is unavailable");
      if ([...log.requestText].length > 8_000) throw new Error("source user message exceeds extraction limits");
      let resultCount = 0;
      const forgetting = explicitForget(log.requestText);
      const explicit = explicitCapture(log.requestText);
      if (forgetting) {
        resultCount = this.handleExplicitForget(job, forgetting);
      } else if (explicit) {
        this.lifecycle.captureAuthorized({
          realm: job.realm,
          type: explicitType(job.realm, explicit),
          key: explicitKey(job.realm, explicit),
          content: explicit,
          ...(job.characterId ? { characterId: job.characterId } : {}),
          sourceSessionId: job.sessionId,
          sourceMessageId: job.sourceMessageId,
          salience: 0.9,
          confidence: 1,
          tags: ["explicit-user-memory"],
          idempotencyKey: `${job.idempotencyKey}:explicit`,
        });
        resultCount = 1;
      } else {
        if ([...log.reply].length > 12_000) throw new Error("source assistant reply exceeds extraction limits");
        const input: MemoryExtractionInput = {
          mode: job.mode,
          realm: job.realm,
          ...(job.characterId ? { characterId: job.characterId } : {}),
          sourceSessionId: job.sessionId,
          sourceMessageId: job.sourceMessageId,
          userText: log.requestText,
          assistantText: log.reply,
        };
        const extracted = await this.extractor(input);
        if (this.disposed || claimLost) return;
        if (!this.repository.renewClaim(job.id, this.ownerId, claimToken, this.leaseExpiry(), this.now())) return;
        const candidates = parseExtractorOutput(extracted, input);
        if (!this.modules.isEnabled(memoryCoordinatorMcpModuleId)) {
          this.repository.finish(job.id, "skipped", {
            durationMs: Date.now() - started,
            resultCount: 0,
          }, this.now(), claim);
          return;
        }
        for (const [index, candidate] of candidates.entries()) {
          this.lifecycle.propose({
            realm: job.realm,
            type: candidate.type,
            key: candidate.key,
            content: candidate.content,
            ...(job.characterId ? { characterId: job.characterId } : {}),
            sourceSessionId: job.sessionId,
            sourceMessageId: job.sourceMessageId,
            salience: candidate.salience,
            confidence: candidate.confidence,
            tags: candidate.tags,
            idempotencyKey: `${job.idempotencyKey}:candidate:${index}`,
          });
          resultCount += 1;
        }
      }
      if (this.disposed) return;
      this.repository.finish(job.id, "completed", {
        durationMs: Date.now() - started,
        resultCount,
      }, this.now(), claim);
    } catch (error) {
      if (this.disposed) return;
      const message = truncateError(error);
      this.repository.finish(job.id, "failed", {
        durationMs: Date.now() - started,
        lastError: message,
      }, this.now(), claim);
      if (claimed.attempts < claimed.maxAttempts) {
        // Failed jobs remain visible and require an explicit trusted retry, avoiding hidden metered loops.
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private handleExplicitForget(job: MemoryExtractionJob, requested: string): number {
    const matches = this.lifecycle.searchConfirmed({
      realm: job.realm,
      ...(job.characterId ? { characterId: job.characterId } : {}),
      query: requested,
      limit: 10,
    });
    if (matches.length > 1) {
      throw new MemoryLifecycleError(
        `explicit forget matched ${matches.length} memories; select one in Memory Management`,
        "MEMORY_FORGET_AMBIGUOUS",
      );
    }
    if (matches[0]) this.lifecycle.forget(matches[0].id, `explicit_forget:${job.sourceMessageId}`);
    return matches.length;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private leaseExpiry(): string {
    return new Date(this.clock.now().getTime() + 30_000).toISOString();
  }
}

export function explicitCapture(text: string): string | undefined {
  const match = text.trim().match(/^(?:(?:请|帮我)?(?:记住|记得)|以后(?:请)?记得)[：:，,\s]*(.+)$/isu) ??
    text.trim().match(/^(?:please\s+)?remember(?:\s+that)?[\s,:]*(.+)$/isu);
  const value = match?.[1]?.trim();
  return value || undefined;
}

export function explicitForget(text: string): string | undefined {
  const match = text.trim().match(/^(?:(?:请|帮我)?(?:忘记|删除记忆|不要再记得))[：:，,\s]*(.+)$/isu) ??
    text.trim().match(/^(?:please\s+)?forget[\s,:]*(.+)$/isu);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function hasDurableSignal(text: string, mode: Mode): boolean {
  if (mode === "sms") {
    return /(?:我叫|我的名字|我住在|我来自|我喜欢|我不喜欢|我的目标|我的项目|我正在做|我认识|对我来说|以后不要|我的边界|I\s+(?:am|live|prefer|like|dislike|work on|know))/iu.test(text);
  }
  return /(?:我们约定|世界观|剧情里|从此|关系变成|角色知道|秘密是|边界是|誓言|线索)/u.test(text);
}

function explicitType(realm: MemoryTargetRealm, content: string): RealityMemoryType | RoleplayMemoryType {
  if (realm === "roleplay") return /边界|不要|禁止/u.test(content) ? "boundary" : "relationship_event";
  if (/目标|打算|计划/u.test(content)) return "goal";
  if (/项目|课题|产品/u.test(content)) return "project";
  if (/喜欢|偏好|不喜欢/u.test(content)) return "preference";
  if (/边界|不要|禁止/u.test(content)) return "boundary";
  if (/认识|朋友|家人|同事/u.test(content)) return "person";
  return "user_fact";
}

function explicitKey(realm: MemoryTargetRealm, content: string): string {
  return `${realm}.explicit.${shortHash(content)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
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
