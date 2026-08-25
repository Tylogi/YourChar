import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ContextLogEntry, ConversationSpace, Mode } from "../domain/types.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import { memoryCoordinatorMcpModuleId } from "../modules/catalog.js";
import type { RoleplayMemoryType, RealityMemoryType } from "../rp/types.js";
import { MemoryLifecycleError, MemoryLifecycleService } from "./lifecycle.js";
import { parseExtractorOutput } from "./extractor.js";
import { MemoryCoordinatorRepository } from "./repository.js";
import type {
  MemoryCoordinatorStatus,
  ExtractedMemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractionJob,
  MemoryExtractor,
  MemoryTargetRealm,
  TrustedRealityMemoryObserver,
} from "./types.js";

export class MemoryCoordinator {
  private readonly ownerId = randomUUID();
  private scheduled = false;
  private processing?: Promise<void>;
  private disposed = false;
  private readonly enabled: boolean;

  constructor(
    readonly repository: MemoryCoordinatorRepository,
    readonly lifecycle: MemoryLifecycleService,
    private readonly modules: AgentModuleCatalog,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly extractor: MemoryExtractor,
    private readonly autoCaptureRealityEnabled: () => boolean = () => false,
    private readonly observeTrustedReality?: TrustedRealityMemoryObserver,
    options: { enabled?: boolean } = {},
  ) {
    this.enabled = options.enabled !== false;
    if (!this.enabled) return;
    this.repository.recoverExpired(this.now());
    this.schedule();
  }

  enqueueTurn(
    log: ContextLogEntry,
    context: { characterId?: string; conversationSpace?: ConversationSpace },
  ): MemoryExtractionJob | undefined {
    if (!this.enabled) return undefined;
    if (log.status !== "completed") return undefined;
    return this.enqueue(log, context);
  }

  enqueueOutputGuardRecovery(
    log: ContextLogEntry,
    context: { characterId?: string; conversationSpace?: ConversationSpace },
  ): MemoryExtractionJob | undefined {
    if (!this.enabled) return undefined;
    if (log.status !== "failed" || log.mode !== "sms") return undefined;
    if (!explicitCapture(log.requestText) && !explicitForget(log.requestText)) return undefined;
    return this.enqueue(log, context, "output_guard_exhausted");
  }

  private enqueue(
    log: ContextLogEntry,
    context: { characterId?: string; conversationSpace?: ConversationSpace },
    recoveryReason?: "output_guard_exhausted",
  ): MemoryExtractionJob | undefined {
    const realm: MemoryTargetRealm = log.mode === "rp" ? "roleplay" : "reality";
    const conversationSpace = context.conversationSpace ?? "normal";
    const secretOwnerCharacterId = conversationSpace === "secret" ? context.characterId : undefined;
    if (conversationSpace === "secret" && !secretOwnerCharacterId) return undefined;
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
      conversationSpace,
      ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
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

  status(
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): MemoryCoordinatorStatus {
    return {
      enabled: this.modules.isEnabled(memoryCoordinatorMcpModuleId),
      pendingCount: this.repository.pendingCount(conversationSpace, secretOwnerCharacterId),
      pendingCandidateCount: this.lifecycle.pendingCandidateCount(
        conversationSpace,
        secretOwnerCharacterId,
      ),
      estimatedTokensLast24Hours: this.repository.estimatedTokensSince(
        new Date(this.clock.now().getTime() - 24 * 60 * 60_000).toISOString(),
        conversationSpace,
        secretOwnerCharacterId,
      ),
      recentJobs: this.repository.listRecent(
        20,
        conversationSpace,
        secretOwnerCharacterId,
      ).map(({ ownerId: _ownerId, claimToken: _claimToken, ...job }) => job),
    };
  }

  retry(
    id: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): MemoryExtractionJob {
    const job = this.repository.retry(
      id,
      this.now(),
      conversationSpace,
      secretOwnerCharacterId,
    );
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
      if (
        log.conversationSpace !== job.conversationSpace ||
        log.secretOwnerCharacterId !== job.secretOwnerCharacterId
      ) throw new Error("source context log belongs to a different conversation space");
      if ([...log.requestText].length > 8_000) throw new Error("source user message exceeds extraction limits");
      let resultCount = 0;
      const forgetting = explicitForget(log.requestText);
      const explicit = explicitCapture(log.requestText);
      if (forgetting) {
        resultCount = this.handleExplicitForget(job, forgetting);
      } else if (explicit) {
        this.lifecycle.captureAuthorized({
          conversationSpace: job.conversationSpace,
          ...(job.secretOwnerCharacterId
            ? { secretOwnerCharacterId: job.secretOwnerCharacterId }
            : {}),
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
          conversationSpace: job.conversationSpace,
          ...(job.secretOwnerCharacterId
            ? { secretOwnerCharacterId: job.secretOwnerCharacterId }
            : {}),
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
          const candidateTags = personMetadataTags(candidate, input.userText);
          const trustedEvidence = job.realm === "reality"
            ? trustedDailyEvidence(candidate, input.userText)
            : undefined;
          const trustedKey = trustedEvidence
            ? candidate.key ?? `reality.daily.${candidate.type}.${shortHash(trustedEvidence)}`
            : undefined;
          const trustedTags = trustedEvidence
            ? [...new Set([
                ...candidateTags,
                ...dailySemanticTags(candidate.type, trustedEvidence),
                "daily-auto-capture",
                "user-quote-evidence",
              ])]
            : candidateTags;
          const memoryInput = {
            conversationSpace: job.conversationSpace,
            ...(job.secretOwnerCharacterId
              ? { secretOwnerCharacterId: job.secretOwnerCharacterId }
              : {}),
            realm: job.realm,
            type: candidate.type,
            key: trustedKey ?? candidate.key,
            content: trustedEvidence ?? candidate.content,
            ...(job.characterId ? { characterId: job.characterId } : {}),
            sourceSessionId: job.sessionId,
            sourceMessageId: job.sourceMessageId,
            salience: trustedEvidence
              ? Math.max(candidate.salience ?? 0, dailyAutoSalience(candidate.type))
              : candidate.salience,
            confidence: candidate.confidence,
            tags: trustedTags,
            idempotencyKey: `${job.idempotencyKey}:candidate:${index}`,
          };
          if (
            job.conversationSpace === "normal" &&
            trustedEvidence && trustedKey && this.observeTrustedReality
          ) {
            this.observeTrustedReality({
              sourceSessionId: job.sessionId,
              sourceMessageId: job.sourceMessageId,
              candidateIndex: index,
              claimKey: trustedKey,
              claimType: candidate.type as RealityMemoryType,
              exactQuote: trustedEvidence,
              confidence: candidate.confidence ?? 0,
              ...(candidate.salience === undefined ? {} : { salience: candidate.salience }),
              ...(trustedTags?.length ? { tags: trustedTags } : {}),
            });
          } else if (trustedEvidence && this.autoCaptureRealityEnabled()) {
            this.lifecycle.createControlPlane(memoryInput);
          } else {
            this.lifecycle.propose(memoryInput);
          }
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
      conversationSpace: job.conversationSpace,
      ...(job.secretOwnerCharacterId
        ? { secretOwnerCharacterId: job.secretOwnerCharacterId }
        : {}),
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
    if (matches[0]) {
      this.lifecycle.forget(
        matches[0].id,
        `explicit_forget:${job.sourceMessageId}`,
        job.conversationSpace,
        job.secretOwnerCharacterId,
      );
    }
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

export function hasDurableSignal(text: string, mode: Mode): boolean {
  if (mode === "sms") {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (!normalized) return false;
    const durable = /(?:我(?:叫|的名字|是|住在|来自|喜欢|爱吃|常吃|不吃|不喝|不喜欢|讨厌|偏好|习惯|通常|一般|平时|每天|每周|工作日|周末|一直|正在|最近在|打算|计划|希望|目标|家人|家里|有个|认识|妹妹|姐姐|哥哥|弟弟|父母|朋友|同事|导师)|我的(?:目标|项目|课题|习惯|偏好|边界|家人|朋友|同事|导师)|对我来说|以后(?:请)?不要|回复我时|回答我时|跟我说话时|请(?:先|尽量|不要)|I\s+(?:am|live|come from|prefer|usually|normally|always|like|dislike|avoid|work on|plan|hope|know|have))/iu.test(normalized);
    const namedRelationship = /(?:是|就是)我(?:的)?[^，。！？,.!?]{0,12}(?:同学|朋友|同事|导师|老师|室友|邻居|家人|亲戚|伴侣|恋人|对象|前任|客户)|我(?:的)?[^，。！？,.!?]{0,12}(?:同学|朋友|同事|导师|老师|室友|邻居|家人|亲戚|伴侣|恋人|对象|前任|客户)(?:叫|是|名叫)/u.test(normalized);
    const onlyTransient = /^(?:我)?(?:今天|现在|刚刚|刚才|这会儿|今晚|这次|临时|today|right now|just now).{0,40}(?:累|困|饿|忙|开心|难过|生气|在下雨|有事|tired|busy|happy|sad|hungry)[。！？.!?]?$/iu.test(normalized);
    if (onlyTransient) return false;
    if (durable || namedRelationship) return true;
    if (/^(?:嗯+|哦+|好(?:的|呀|啊)?|行|可以|知道了|收到|谢谢|早|晚安|hi|hello|ok(?:ay)?|thanks?)[。！？.!?~～]*$/iu.test(normalized)) {
      return false;
    }
    const selfDisclosure = /(?:^|[，。！？,.!?\s])(?:我|我的|我们|咱们|家里|家人|I\b|I'm\b|I've\b|my\b)/iu.test(normalized);
    return selfDisclosure && [...normalized].length >= 5;
  }
  return /(?:我们约定|世界观|剧情里|从此|关系变成|角色知道|秘密是|边界是|誓言|线索)/u.test(text);
}

function trustedDailyEvidence(
  candidate: { confidence?: number; evidence?: { user: string } },
  userText: string,
): string | undefined {
  if ((candidate.confidence ?? 0) < 0.88) return undefined;
  const evidence = candidate.evidence?.user.replace(/\s+/gu, " ").trim();
  if (!evidence || [...evidence].length < 2 || !normalizeEvidence(userText).includes(evidence)) return undefined;
  if (isSensitiveDailyMemory(evidence)) return undefined;
  return evidence;
}

function normalizeEvidence(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function isSensitiveDailyMemory(value: string): boolean {
  return /(?:密码|口令|验证码|密钥|token|api\s*key|secret|身份证|护照|银行卡|信用卡|账号|账户|转账|收入|工资|存款|负债|病史|疾病|诊断|药物|过敏|手机号|电话号码|邮箱|电子邮件|详细地址|住址|门牌号|password|credential|verification code|identity card|passport|bank|credit card|salary|diagnosis|medical|phone number|email|street address)/iu.test(value);
}

function dailyAutoSalience(type: string): number {
  if (type === "boundary" || type === "goal") return 0.85;
  if (type === "preference" || type === "project" || type === "person") return 0.78;
  return 0.72;
}

function dailySemanticTags(type: string, evidence: string): string[] {
  const tags: string[] = [];
  if (type === "preference") tags.push("偏好");
  if (type === "goal") tags.push("目标", "计划");
  if (type === "project") tags.push("项目", "工作");
  if (type === "person") tags.push("人际", "人物");
  if (type === "boundary") tags.push("边界");
  if (/(?:平时|通常|一般|每天|每周|工作日|周末|起床|睡觉|作息|习惯)/u.test(evidence)) {
    tags.push("作息", "日常习惯");
  }
  if (/(?:吃|喝|香菜|饮食|忌口|口味)/u.test(evidence)) tags.push("饮食", "忌口");
  if (/(?:回复|回答|说话|结论|简洁|详细)/u.test(evidence)) tags.push("沟通", "回复偏好");
  if (/(?:妹妹|姐姐|哥哥|弟弟|父母|家人)/u.test(evidence)) tags.push("家人");
  return tags;
}

function personMetadataTags(candidate: ExtractedMemoryCandidate, userText: string): string[] {
  const ordinary = (candidate.tags ?? []).filter((tag) =>
    !tag.startsWith("person-name:") &&
    !tag.startsWith("person-alias:") &&
    !tag.startsWith("person-relationship:")
  );
  if (candidate.type !== "person" || !candidate.person) return ordinary;
  const source = userText.toLocaleLowerCase();
  const name = source.includes(candidate.person.name.toLocaleLowerCase())
    ? taggedPersonValue("person-name:", candidate.person.name)
    : undefined;
  const aliases = (candidate.person.aliases ?? [])
    .filter((alias) => source.includes(alias.toLocaleLowerCase()))
    .map((alias) => taggedPersonValue("person-alias:", alias))
    .filter((tag): tag is string => Boolean(tag));
  const relationship = candidate.person.relationship && source.includes(candidate.person.relationship.toLocaleLowerCase())
    ? taggedPersonValue("person-relationship:", candidate.person.relationship)
    : undefined;
  return [...new Set([
    ...ordinary,
    ...(name ? [name] : []),
    ...aliases,
    ...(relationship ? [relationship] : []),
  ])].slice(0, 20);
}

function taggedPersonValue(prefix: string, value: string): string | undefined {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  return `${prefix}${[...clean].slice(0, 80 - prefix.length).join("")}`;
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
