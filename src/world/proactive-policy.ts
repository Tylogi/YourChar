import type {
  CharacterAutonomyPolicy,
  ProactiveDecisionCode,
  ProactiveMessage,
  ProactiveTopicPolicy,
  WorldEvent,
  WorldPlace,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const PROACTIVE_SCORE_THRESHOLD = 0.7;
export const PROACTIVE_EVENT_MAX_AGE_MS = 72 * HOUR_MS;
export const PROACTIVE_RECENT_USER_WINDOW_MS = 10 * MINUTE_MS;
export const PROACTIVE_RETRY_COOLDOWN_MS = 10 * MINUTE_MS;

export type ProactiveBlockReason = "co_present" | "conversation_busy";

export type ProactiveCandidateEvaluation = {
  score: number;
  decisionCode: ProactiveDecisionCode;
  permanent: boolean;
  details: Record<string, unknown>;
};

export function deriveProactiveTopic(
  event: WorldEvent,
  place?: Pick<WorldPlace, "id" | "name">,
): { topicKey: string; topicLabel: string } {
  if (event.type === "travel") {
    return {
      topicKey: `world.travel:${place?.id ?? "general"}`,
      topicLabel: place ? `行程 · ${place.name}` : "行程动态",
    };
  }
  if (event.type === "interaction") {
    return { topicKey: "world.interaction", topicLabel: "社交动态" };
  }
  if (event.type === "world_change") {
    return { topicKey: "world.change", topicLabel: "世界变化" };
  }
  return {
    topicKey: `world.activity:${place?.id ?? "general"}`,
    topicLabel: place ? `生活片段 · ${place.name}` : "生活片段",
  };
}

export function scoreProactiveCandidate(input: {
  event: WorldEvent;
  now: Date;
  topicPolicy?: ProactiveTopicPolicy;
  lastTopicDeliveryAt?: string;
  topicCooldownMinutes?: number;
}): { score: number; breakdown: Record<string, number> } {
  const ageMs = Math.max(0, input.now.getTime() - validTime(input.event.startsAt, input.now.getTime()));
  const salience = input.event.salience * 0.65;
  const timeliness = ageMs <= 30 * MINUTE_MS
    ? 0.15
    : ageMs <= 3 * HOUR_MS
      ? 0.1
      : ageMs <= 12 * HOUR_MS
        ? 0.04
        : 0;
  const lastTopicAt = validOptionalTime(input.lastTopicDeliveryAt);
  const timeSinceTopic = lastTopicAt === undefined ? undefined : input.now.getTime() - lastTopicAt;
  const topicCooldownMs = (input.topicCooldownMinutes ?? 360) * MINUTE_MS;
  const novelty = timeSinceTopic === undefined
    ? 0.12
    : timeSinceTopic >= 7 * DAY_MS
      ? 0.1
      : timeSinceTopic >= 2 * DAY_MS
        ? 0.06
        : timeSinceTopic >= topicCooldownMs
          ? 0.03
          : -0.08;
  const source = input.event.source === "manual"
    ? 0.04
    : input.event.source === "autonomy"
      ? 0.01
      : 0;
  const eventType = input.event.type === "world_change"
    ? 0.06
    : input.event.type === "interaction"
      ? 0.04
      : input.event.type === "travel"
        ? 0.03
        : 0;
  const topicMode = input.topicPolicy?.mode === "reduced" ? -0.12 : 0;
  const learnedPreference = Math.min(0.04, (input.topicPolicy?.helpfulCount ?? 0) * 0.01) -
    Math.min(0.08, (input.topicPolicy?.lessOftenCount ?? 0) * 0.02);
  const breakdown = { salience, timeliness, novelty, source, eventType, topicMode, learnedPreference };
  return { score: roundScore(clamp(Object.values(breakdown).reduce((sum, value) => sum + value, 0))), breakdown };
}

export function evaluateProactiveCandidate(input: {
  message: ProactiveMessage;
  event?: WorldEvent;
  policy: CharacterAutonomyPolicy;
  topicPolicy?: ProactiveTopicPolicy;
  deliveredMessages: ProactiveMessage[];
  deliveredToday: number;
  now: Date;
  inQuietHours: boolean;
  lastUserAt?: string;
  blockReason?: ProactiveBlockReason;
  force?: boolean;
}): ProactiveCandidateEvaluation {
  const baseDetails = { threshold: PROACTIVE_SCORE_THRESHOLD };
  if (!input.event) return decision(input.message.candidateScore, "event_missing", true, baseDetails);
  if (!input.policy.proactiveEnabled) {
    return decision(input.message.candidateScore, "policy_disabled", true, baseDetails);
  }

  const eventAgeMs = Math.max(0, input.now.getTime() - validTime(input.event.startsAt, input.now.getTime()));
  if (eventAgeMs > PROACTIVE_EVENT_MAX_AGE_MS) {
    return decision(input.message.candidateScore, "stale", true, {
      ...baseDetails,
      eventAgeMinutes: Math.floor(eventAgeMs / MINUTE_MS),
    });
  }
  if (input.topicPolicy?.mode === "muted") {
    return decision(input.message.candidateScore, "topic_muted", true, baseDetails);
  }

  const deliveredForTopic = input.deliveredMessages
    .filter((message) => message.topicKey === input.message.topicKey && message.deliveredAt)
    .sort((left, right) => String(right.deliveredAt).localeCompare(String(left.deliveredAt)));
  const topicCooldownMinutes = input.topicPolicy?.mode === "reduced"
    ? 48 * 60
    : Math.max(input.policy.proactiveCooldownMinutes, 6 * 60);
  const scored = scoreProactiveCandidate({
    event: input.event,
    now: input.now,
    topicPolicy: input.topicPolicy,
    lastTopicDeliveryAt: deliveredForTopic[0]?.deliveredAt,
    topicCooldownMinutes,
  });
  const details = {
    ...baseDetails,
    breakdown: scored.breakdown,
    eventAgeMinutes: Math.floor(eventAgeMs / MINUTE_MS),
    topicMode: input.topicPolicy?.mode ?? "normal",
  };

  const pausedUntil = validOptionalTime(input.policy.proactivePausedUntil);
  if (pausedUntil !== undefined && pausedUntil > input.now.getTime()) {
    return decision(scored.score, "paused", false, {
      ...details,
      pausedUntil: input.policy.proactivePausedUntil,
    });
  }
  if (input.deliveredToday >= input.policy.dailyMessageLimit) {
    return decision(scored.score, "daily_limit", false, {
      ...details,
      deliveredToday: input.deliveredToday,
      dailyMessageLimit: input.policy.dailyMessageLimit,
    });
  }
  if (!input.force && input.inQuietHours) {
    return decision(scored.score, "quiet_hours", false, details);
  }
  const lastAttemptAt = validOptionalTime(input.message.lastAttemptAt);
  if (
    input.message.lastError && lastAttemptAt !== undefined &&
    input.now.getTime() - lastAttemptAt < PROACTIVE_RETRY_COOLDOWN_MS
  ) {
    return decision(scored.score, "retry_cooldown", false, {
      ...details,
      retryAfter: new Date(lastAttemptAt + PROACTIVE_RETRY_COOLDOWN_MS).toISOString(),
    });
  }
  if (!input.force) {
    const lastProactiveAt = validOptionalTime(input.policy.lastProactiveAt);
    if (
      lastProactiveAt !== undefined &&
      input.now.getTime() - lastProactiveAt < input.policy.proactiveCooldownMinutes * MINUTE_MS
    ) {
      return decision(scored.score, "global_cooldown", false, {
        ...details,
        availableAfter: new Date(
          lastProactiveAt + input.policy.proactiveCooldownMinutes * MINUTE_MS,
        ).toISOString(),
      });
    }
    const lastTopicAt = validOptionalTime(deliveredForTopic[0]?.deliveredAt);
    if (lastTopicAt !== undefined && input.now.getTime() - lastTopicAt < topicCooldownMinutes * MINUTE_MS) {
      return decision(scored.score, "topic_cooldown", false, {
        ...details,
        availableAfter: new Date(lastTopicAt + topicCooldownMinutes * MINUTE_MS).toISOString(),
        topicCooldownMinutes,
      });
    }
  }
  if (input.blockReason) return decision(scored.score, input.blockReason, false, details);
  const lastUserAt = validOptionalTime(input.lastUserAt);
  if (
    !input.force && lastUserAt !== undefined &&
    input.now.getTime() - lastUserAt < PROACTIVE_RECENT_USER_WINDOW_MS
  ) {
    return decision(scored.score, "recent_user_activity", false, {
      ...details,
      availableAfter: new Date(lastUserAt + PROACTIVE_RECENT_USER_WINDOW_MS).toISOString(),
    });
  }
  if (scored.score < PROACTIVE_SCORE_THRESHOLD) {
    return decision(scored.score, "low_score", true, details);
  }
  return decision(scored.score, "candidate_ready", false, details);
}

function decision(
  score: number,
  decisionCode: ProactiveDecisionCode,
  permanent: boolean,
  details: Record<string, unknown>,
): ProactiveCandidateEvaluation {
  return { score: roundScore(score), decisionCode, permanent, details };
}

function validOptionalTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validTime(value: string, fallback: number): number {
  return validOptionalTime(value) ?? fallback;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
