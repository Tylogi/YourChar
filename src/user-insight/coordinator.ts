import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { MemoryLifecycleService } from "../memory-coordinator/lifecycle.js";
import type { MemoryCandidateInput } from "../memory-coordinator/types.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleItem, ScheduleMutationEvent } from "../schedule/types.js";
import type { UserInsightRepository } from "./repository.js";
import type {
  ConversationUserInsightInput,
  UserInsightDecision,
  UserInsightObservation,
  UserInsightObservationInput,
  UserInsightStatus,
} from "./types.js";

const completedWindowMs = 90 * 24 * 60 * 60_000;
const snoozeWindowMs = 60 * 24 * 60 * 60_000;
const completedMinimumSpanMs = 7 * 24 * 60 * 60_000;

export type UserInsightCoordinatorOptions = {
  enabled: () => boolean;
  onAction?: (actionType: string, payload: Record<string, unknown>) => void;
};

export class UserInsightControlError extends Error {
  constructor(
    message: string,
    readonly code: "USER_INSIGHT_NOT_FOUND" | "USER_INSIGHT_SENSITIVE" |
      "USER_INSIGHT_RETRACTED" | "USER_INSIGHT_WRITE_DISABLED",
  ) {
    super(message);
    this.name = "UserInsightControlError";
  }
}

export class UserInsightCoordinator {
  constructor(
    readonly repository: UserInsightRepository,
    private readonly lifecycle: MemoryLifecycleService,
    private readonly scheduleService: ScheduleService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly options: UserInsightCoordinatorOptions,
  ) {}

  observeSchedule(event: ScheduleMutationEvent, refreshProjection = true): void {
    if (event.item.ownerType !== "user") return;
    const affected = new Set<string>();
    if (event.type === "cancelled") {
      this.repository.retractSource("schedule", event.item.id, this.now()).forEach((key) => affected.add(key));
    } else if (event.type === "completed") {
      this.repository.retractSource("schedule", event.item.id, this.now()).forEach((key) => affected.add(key));
      if (event.item.kind !== "reminder") {
        const observation = this.upsertCompleted(event.item);
        affected.add(observation.claimKey);
      }
    } else if (event.type === "snoozed" && event.occurrence && event.snoozeMinutes) {
      const observation = this.upsertSnooze(event.item, event.occurrence.snoozedFromId ?? event.occurrence.id, event.snoozeMinutes);
      affected.add(observation.claimKey);
    } else {
      const previous = this.repository.getBySource("schedule", event.item.id, "recurring_schedule");
      if (event.item.recurrenceRule && event.item.status === "scheduled") {
        const observation = this.upsertRecurring(event.item);
        affected.add(observation.claimKey);
        if (previous && previous.claimKey !== observation.claimKey) affected.add(previous.claimKey);
      } else {
        if (previous) affected.add(previous.claimKey);
        this.repository.retractSource("schedule", event.item.id, this.now()).forEach((key) => affected.add(key));
        this.upsertOneOff(event.item);
      }
    }
    for (const claimKey of affected) this.recalculateClaim(claimKey);
    if (refreshProjection) this.lifecycle.refreshRealityProfileProjection();
  }

  observeConversation(input: ConversationUserInsightInput, refreshProjection = true): UserInsightObservation {
    const exactQuote = [...input.exactQuote.replace(/\s+/gu, " ").trim()].slice(0, 500).join("");
    if (!exactQuote) throw new Error("conversation insight requires an exact user quote");
    const sensitive = isSensitiveScheduleText(exactQuote);
    const claimKey = normalizeConversationClaimKey(input.claimKey, input.claimType, exactQuote);
    const observation = this.upsert({
      sourceType: "conversation",
      sourceId: `${input.sourceMessageId}:${input.candidateIndex}`,
      sourceSessionId: input.sourceSessionId,
      kind: "conversation_statement",
      claimKey,
      claimType: input.claimType,
      claimText: sensitive ? "[敏感对话内容未进入用户画像]" : exactQuote,
      evidence: sensitive
        ? { sourceMessageId: input.sourceMessageId, candidateIndex: input.candidateIndex, quoteRedacted: true }
        : {
            sourceMessageId: input.sourceMessageId,
            candidateIndex: input.candidateIndex,
            exactUserQuote: exactQuote,
            salience: input.salience ?? null,
            tags: input.tags ?? [],
          },
      confidence: Math.max(0, Math.min(1, input.confidence)),
      sensitivity: sensitive ? "sensitive" : "low",
      decision: this.initialDecision(sensitive, false),
      observedAt: input.observedAt ?? this.now(),
    });
    this.recalculateClaim(claimKey);
    if (refreshProjection) this.lifecycle.refreshRealityProfileProjection();
    return this.repository.get(observation.id) ?? observation;
  }

  confirm(id: string): UserInsightObservation {
    const observation = this.requireObservation(id);
    if (observation.sensitivity === "sensitive" || observation.decision === "blocked_sensitive") {
      throw new UserInsightControlError(
        "敏感画像观察不能直接确认，请在用户画像中手动填写必要信息",
        "USER_INSIGHT_SENSITIVE",
      );
    }
    if (observation.decision === "retracted") {
      throw new UserInsightControlError("已撤回的来源不能确认", "USER_INSIGHT_RETRACTED");
    }
    if (!this.options.enabled()) {
      throw new UserInsightControlError("自动记忆写入未开启", "USER_INSIGHT_WRITE_DISABLED");
    }
    const evidence = this.repository.listByClaim(observation.claimKey)
      .filter((entry) => entry.sensitivity === "low" && entry.decision !== "retracted");
    this.promoteObservation(observation, evidence, evidence, true);
    this.lifecycle.refreshRealityProfileProjection();
    return this.repository.get(id) ?? observation;
  }

  reject(id: string): UserInsightObservation {
    const observation = this.requireObservation(id);
    this.archiveClaim(observation.claimKey, "user_insight_rejected");
    this.repository.blockClaim(observation.claimKey, this.now());
    this.lifecycle.refreshRealityProfileProjection();
    this.options.onAction?.("user_insight_rejected", {
      observationId: id,
      claimKey: observation.claimKey,
    });
    return this.repository.get(id) ?? observation;
  }

  unlock(id: string): UserInsightObservation {
    const observation = this.requireObservation(id);
    this.repository.unlockClaim(observation.claimKey, this.now());
    this.recalculateClaim(observation.claimKey);
    this.lifecycle.refreshRealityProfileProjection();
    this.options.onAction?.("user_insight_unlocked", {
      observationId: id,
      claimKey: observation.claimKey,
    });
    return this.repository.get(id) ?? observation;
  }

  reconcile(): void {
    for (const item of this.scheduleService.list({ ownerType: "user" })) {
      const type = item.status === "cancelled"
        ? "cancelled"
        : item.status === "completed"
          ? "completed"
          : "created";
      this.observeSchedule({ type, item }, false);
    }
    for (const claimKey of this.repository.listClaimKeys()) this.recalculateClaim(claimKey);
    this.lifecycle.refreshRealityProfileProjection();
  }

  status(limit = 30): UserInsightStatus {
    const counts = this.repository.counts();
    return {
      enabled: this.options.enabled(),
      observationCount: counts.total,
      promotedCount: counts.promoted,
      pendingCount: counts.pending,
      blockedCount: counts.blocked,
      conflictCount: counts.conflicted,
      userBlockedCount: counts.userBlocked,
      recentObservations: this.repository.listRecent(limit),
    };
  }

  private upsertRecurring(item: ScheduleItem): UserInsightObservation {
    const title = cleanTitle(item.title);
    const sensitive = isSensitiveScheduleText(`${item.title}\n${item.notes ?? ""}`);
    const decision = this.initialDecision(sensitive, false);
    return this.upsert({
      sourceType: "schedule",
      sourceId: item.id,
      sourceSessionId: item.sourceSessionId,
      kind: "recurring_schedule",
      claimKey: scheduleClaimKey(title),
      claimType: "user_fact",
      claimText: sensitive
        ? "[敏感日程内容未进入用户画像]"
        : `用户在日历中设置了${recurrenceLabel(item.recurrenceRule!)}的“${title}”${scheduleKindLabel(item)}。`,
      evidence: scheduleEvidence(item, sensitive),
      confidence: 0.94,
      sensitivity: sensitive ? "sensitive" : "low",
      decision,
      observedAt: item.updatedAt,
    });
  }

  private upsertOneOff(item: ScheduleItem): UserInsightObservation {
    const sensitive = isSensitiveScheduleText(`${item.title}\n${item.notes ?? ""}`);
    return this.upsert({
      sourceType: "schedule",
      sourceId: item.id,
      sourceSessionId: item.sourceSessionId,
      kind: "one_off_schedule",
      claimKey: `reality.schedule.current.${shortHash(item.id)}`,
      claimType: "user_fact",
      claimText: sensitive ? "[敏感一次性日程未进入用户画像]" : `一次性用户日程：“${cleanTitle(item.title)}”。`,
      evidence: scheduleEvidence(item, sensitive),
      confidence: 1,
      sensitivity: sensitive ? "sensitive" : "low",
      decision: sensitive ? "blocked_sensitive" : "context_only",
      observedAt: item.updatedAt,
    });
  }

  private upsertCompleted(item: ScheduleItem): UserInsightObservation {
    const title = cleanTitle(item.title);
    const sensitive = isSensitiveScheduleText(`${item.title}\n${item.notes ?? ""}`);
    return this.upsert({
      sourceType: "schedule",
      sourceId: item.id,
      sourceSessionId: item.sourceSessionId,
      kind: "completed_schedule",
      claimKey: scheduleClaimKey(title),
      claimType: "user_fact",
      claimText: sensitive
        ? "[敏感完成记录未进入用户画像]"
        : `用户近期在多个日期完成了“${title}”相关${scheduleKindLabel(item)}。`,
      evidence: scheduleEvidence(item, sensitive),
      confidence: 0.9,
      sensitivity: sensitive ? "sensitive" : "low",
      decision: this.initialDecision(sensitive, false),
      observedAt: item.updatedAt,
    });
  }

  private upsertSnooze(item: ScheduleItem, sourceId: string, minutes: number): UserInsightObservation {
    const normalizedMinutes = Math.max(1, Math.min(24 * 60, Math.round(minutes)));
    return this.upsert({
      sourceType: "reminder",
      sourceId,
      sourceSessionId: item.sourceSessionId,
      kind: "reminder_snooze",
      claimKey: `reality.reminder.snooze.${normalizedMinutes}`,
      claimType: "preference",
      claimText: `用户多次选择将提醒延后 ${normalizedMinutes} 分钟。`,
      evidence: {
        scheduleItemId: item.id,
        snoozeMinutes: normalizedMinutes,
        timezone: item.timezone,
      },
      confidence: 0.88,
      sensitivity: "low",
      decision: this.initialDecision(false, false),
      observedAt: this.now(),
    });
  }

  private upsert(input: UserInsightObservationInput): UserInsightObservation {
    return this.repository.upsert(input, this.idGenerator.next("user-insight"), this.now());
  }

  private recalculateClaim(claimKey: string): void {
    const all = this.repository.listByClaim(claimKey);
    if (all.some((entry) => entry.decision === "user_blocked")) {
      this.repository.setClaimDecision(claimKey, "user_blocked", undefined, this.now());
      return;
    }
    const candidates = all.filter((entry) =>
      entry.sensitivity === "low" &&
      entry.decision !== "context_only" &&
      entry.decision !== "blocked_sensitive" &&
      entry.decision !== "user_blocked" &&
      entry.decision !== "retracted"
    );
    if (!candidates.length) {
      this.archiveClaim(claimKey, "user_insight_evidence_retracted");
      return;
    }
    if (!this.options.enabled()) {
      this.repository.setClaimDecision(claimKey, "write_disabled", undefined, this.now());
      return;
    }

    const recurringCandidates = candidates.filter((entry) => entry.kind === "recurring_schedule");
    if (new Set(recurringCandidates.map((entry) => entry.claimText)).size > 1) {
      this.repository.setClaimDecision(claimKey, "conflicted", undefined, this.now());
      this.archiveClaim(claimKey, "user_insight_conflicting_evidence");
      this.options.onAction?.("user_insight_conflict", {
        claimKey,
        evidenceCount: recurringCandidates.length,
      });
      return;
    }
    const recurring = recurringCandidates.at(-1);
    const completed = candidates.filter((entry) =>
      entry.kind === "completed_schedule" && withinWindow(entry.observedAt, this.clock.now(), completedWindowMs)
    );
    const snoozes = candidates.filter((entry) =>
      entry.kind === "reminder_snooze" && withinWindow(entry.observedAt, this.clock.now(), snoozeWindowMs)
    );
    const completionDates = new Set(completed.map((entry) => localDateKey(entry.observedAt, evidenceTimezone(entry))));
    const completionTimes = completed.map((entry) => new Date(entry.observedAt).getTime()).sort((left, right) => left - right);
    const completedEligible = completionDates.size >= 3 && completionTimes.length >= 3 &&
      completionTimes.at(-1)! - completionTimes[0] >= completedMinimumSpanMs;
    const conversation = candidates.filter((entry) => entry.kind === "conversation_statement").at(-1);
    const selected = conversation ?? recurring ?? (completedEligible ? completed.at(-1) : undefined) ??
      (snoozes.length >= 5 ? snoozes.at(-1) : undefined);
    if (!selected) {
      this.repository.setClaimDecision(claimKey, "accumulating", undefined, this.now());
      this.archiveClaim(claimKey, "user_insight_evidence_below_threshold");
      return;
    }

    this.promoteObservation(selected, candidates, all, false);
  }

  private promoteObservation(
    selected: UserInsightObservation,
    candidates: UserInsightObservation[],
    all: UserInsightObservation[],
    userConfirmed: boolean,
  ): void {
    const claimKey = selected.claimKey;
    const evidenceIds = candidates.map((entry) => entry.id).sort();
    const evidenceRevision = all.map((entry) =>
      `${entry.id}\0${entry.decision}\0${entry.claimText}`
    ).sort().join("\n");
    const active = this.lifecycle.activeRealityByKey(selected.claimKey);
    if (
      active &&
      (!active.tags.includes("user-insight") || active.tags.includes("user-corrected"))
    ) {
      this.repository.setClaimDecision(claimKey, "user_blocked", undefined, this.now());
      this.options.onAction?.("user_insight_user_blocked", {
        claimKey,
        memoryId: active.id,
        memoryValidity: active.validity,
      });
      return;
    }
    if (active?.tags.includes("user-insight") && active.content === selected.claimText) {
      this.repository.markClaimPromoted(claimKey, active.id, this.now());
      return;
    }
    const evidenceSalience = typeof selected.evidence.salience === "number"
      ? selected.evidence.salience
      : Number.NaN;
    const evidenceTags = Array.isArray(selected.evidence.tags)
      ? selected.evidence.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => [...tag.trim()].slice(0, 80).join(""))
        .filter(Boolean)
        .slice(0, 12)
      : [];
    const memoryInput: MemoryCandidateInput = {
      realm: "reality",
      type: selected.claimType,
      key: selected.claimKey,
      content: selected.claimText,
      sourceSessionId: safeIdentifier(selected.sourceSessionId) ?? "user-insight",
      sourceMessageId: `user-insight-${selected.id}`,
      salience: Number.isFinite(evidenceSalience)
        ? Math.max(0, Math.min(1, evidenceSalience))
        : selected.kind === "conversation_statement" ? 0.74
          : selected.kind === "recurring_schedule" ? 0.76 : 0.68,
      confidence: selected.confidence,
      tags: [
        "user-insight",
        selected.kind === "conversation_statement"
          ? "daily-auto-capture"
          : selected.kind === "reminder_snooze" ? "reminder-preference" : "schedule-pattern",
        ...(selected.kind === "conversation_statement" ? ["user-quote-evidence"] : []),
        ...(userConfirmed ? ["user-confirmed-insight"] : []),
        selected.kind,
        ...evidenceTags,
      ],
      idempotencyKey: `user-insight:${selected.claimKey}:${shortHash(`${evidenceIds.join("\0")}\n${evidenceRevision}\n${userConfirmed}`)}`,
    };
    let memory = this.lifecycle.createControlPlane(memoryInput);
    if (
      memory.validity !== "active" &&
      memory.tags.includes("user-insight") &&
      memory.statusReason?.startsWith("user_insight_")
    ) {
      memory = this.lifecycle.createControlPlane({
        ...memoryInput,
        idempotencyKey: `${memoryInput.idempotencyKey}:reactivate:${shortHash(`${memory.id}\0${memory.updatedAt}`)}`,
      });
    }
    if (memory.validity !== "active" || !memory.confirmed) {
      this.repository.setClaimDecision(claimKey, "user_blocked", undefined, this.now());
      this.options.onAction?.("user_insight_user_blocked", {
        claimKey,
        memoryId: memory.id,
        memoryValidity: memory.validity,
      });
      return;
    }
    this.repository.markClaimPromoted(claimKey, memory.id, this.now());
    this.options.onAction?.("user_insight_promoted", {
      claimKey,
      memoryId: memory.id,
      observationKind: selected.kind,
      evidenceCount: candidates.length,
      userConfirmed,
    });
  }

  private requireObservation(id: string): UserInsightObservation {
    const observation = this.repository.get(id);
    if (!observation) {
      throw new UserInsightControlError(`User insight ${id} was not found`, "USER_INSIGHT_NOT_FOUND");
    }
    return observation;
  }

  private archiveClaim(claimKey: string, reason: string): void {
    const memory = this.lifecycle.archiveActiveRealityByKey(claimKey, reason);
    if (!memory) return;
    this.options.onAction?.("user_insight_archived", { claimKey, memoryId: memory.id, reason });
  }

  private initialDecision(sensitive: boolean, contextOnly: boolean): UserInsightDecision {
    if (sensitive) return "blocked_sensitive";
    if (contextOnly) return "context_only";
    return this.options.enabled() ? "accumulating" : "write_disabled";
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function scheduleClaimKey(title: string): string {
  return `reality.schedule.pattern.${shortHash(title.toLocaleLowerCase("zh-CN"))}`;
}

function normalizeConversationClaimKey(key: string, type: string, quote: string): string {
  const normalized = key.trim().toLocaleLowerCase("en-US");
  if (normalized && [...normalized].length <= 240 && /^[a-z0-9._:-]+$/u.test(normalized)) {
    return normalized;
  }
  return `reality.conversation.${type}.${shortHash(quote.toLocaleLowerCase("zh-CN"))}`;
}

function recurrenceLabel(rule: string): string {
  const frequency = rule.match(/FREQ=(DAILY|WEEKLY)/)?.[1];
  const interval = Math.max(1, Number(rule.match(/INTERVAL=(\d+)/)?.[1] ?? "1"));
  if (frequency === "DAILY") return interval === 1 ? "每天" : `每 ${interval} 天`;
  return interval === 1 ? "每周" : `每 ${interval} 周`;
}

function scheduleKindLabel(item: ScheduleItem): string {
  if (item.kind === "reminder") return "提醒";
  if (item.kind === "task") return "任务";
  return "安排";
}

function cleanTitle(value: string): string {
  return [...value.replace(/\s+/gu, " ").trim()].slice(0, 100).join("");
}

function scheduleEvidence(item: ScheduleItem, sensitive: boolean): Record<string, unknown> {
  return {
    scheduleItemId: item.id,
    scheduleKind: item.kind,
    ...(sensitive ? { titleRedacted: true } : { title: cleanTitle(item.title) }),
    recurrenceRule: item.recurrenceRule ?? null,
    status: item.status,
    timezone: item.timezone,
    startAt: item.startAt ?? null,
  };
}

function isSensitiveScheduleText(value: string): boolean {
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return false;
  if (/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/u.test(text)) return true;
  if (/(?:密码|验证码|身份证|护照|银行卡|信用卡|账号|密钥|token|password|credential)/iu.test(text)) return true;
  if (/(?:医院|门诊|体检|吃药|服药|用药|病历|诊断|心理咨询|精神科|癌症|手术|doctor|hospital|therapy|medication)/iu.test(text)) return true;
  if (/(?:贷款|还款|银行|税务|报税|工资|薪资|投资|股票|基金|债务|loan|bank|salary|investment|debt)/iu.test(text)) return true;
  if (/(?:党派|政治活动|宗教|教会|寺庙|清真寺|性取向|性生活|political|religion|church|sexuality)/iu.test(text)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text)) return true;
  if (/(?:\+?86[- ]?)?1[3-9]\d{9}/u.test(text)) return true;
  if (/(?:路|街|巷|弄|号|室)\s*\d{1,5}/u.test(text)) return true;
  return false;
}

function withinWindow(value: string, now: Date, windowMs: number): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= now.getTime() && time >= now.getTime() - windowMs;
}

function evidenceTimezone(observation: UserInsightObservation): string {
  return typeof observation.evidence.timezone === "string" ? observation.evidence.timezone : "UTC";
}

function localDateKey(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function safeIdentifier(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]+$/u.test(value) ? value : undefined;
}
