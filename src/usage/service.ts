import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { AppDatabase } from "../storage/database.js";
import { normalizeActualProviderUsage } from "../context/provider-usage.js";
import { emptyUsageBucket, resolveModelPrice, sanitizePriceOverrides, usageCost } from "./pricing.js";
import { UsageRepository, currentUsageMonth } from "./repository.js";
import type {
  UsageBudget,
  UsageModelRow,
  UsageSettings,
  UsageSummary,
  UsageTokenBucket,
} from "./types.js";

export type ModelCallUsage = {
  provider?: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  } | null;
};

export class UsageService {
  private readonly repository: UsageRepository;

  constructor(
    database: AppDatabase,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
  ) {
    this.repository = new UsageRepository(database, clock, idGenerator);
  }

  /**
   * 记录一次真实模型调用的用量。模型没返回用量就什么都不写，
   * 不做估算、不写假数据。
   */
  recordModelCall(call: ModelCallUsage): void {
    const raw = call.usage;
    if (!raw) return;
    const actual = normalizeActualProviderUsage({
      input: Number(raw.input ?? 0),
      output: Number(raw.output ?? 0),
      cacheRead: Number(raw.cacheRead ?? 0),
      cacheWrite: Number(raw.cacheWrite ?? 0),
      totalTokens: Number(raw.totalTokens ?? 0),
    });
    if (
      actual.inputTokens === null && actual.outputTokens === null &&
      actual.cacheReadTokens === null && actual.cacheWriteTokens === null
    ) return;
    this.repository.record({
      provider: call.provider ?? "",
      model: call.model || "unknown",
      input: actual.inputTokens ?? 0,
      output: actual.outputTokens ?? 0,
      cacheRead: actual.cacheReadTokens ?? 0,
      cacheWrite: actual.cacheWriteTokens ?? 0,
    });
  }

  settings(): UsageSettings {
    return this.repository.settings();
  }

  saveSettings(patch: Partial<UsageSettings>): UsageSettings {
    const current = this.repository.settings();
    const budget = patch.monthlyBudgetYuan === undefined
      ? current.monthlyBudgetYuan
      : normalizeBudget(patch.monthlyBudgetYuan);
    return this.repository.saveSettings({
      monthlyBudgetYuan: budget,
      priceOverrides: patch.priceOverrides
        ? sanitizePriceOverrides({ ...current.priceOverrides, ...patch.priceOverrides })
        : current.priceOverrides,
    });
  }

  summary(
    month: string | undefined,
    configured: { provider: string; model: string },
  ): UsageSummary {
    const settings = this.repository.settings();
    const targetMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : currentUsageMonth(this.clock);
    const bucket = emptyUsageBucket();
    let calls = 0;
    let unpricedCalls = 0;
    let costYuan = 0;
    const models: UsageModelRow[] = this.repository.monthRows(targetMonth).map((row) => {
      const tokens: UsageTokenBucket = {
        input: Number(row.input ?? 0),
        output: Number(row.output ?? 0),
        cacheRead: Number(row.cache_read ?? 0),
        cacheWrite: Number(row.cache_write ?? 0),
      };
      const rowCalls = Number(row.calls ?? 0);
      const price = resolveModelPrice(String(row.model ?? ""), settings.priceOverrides);
      const cost = price ? usageCost(tokens, price) : 0;
      if (!price) unpricedCalls += rowCalls;
      bucket.input += tokens.input;
      bucket.output += tokens.output;
      bucket.cacheRead += tokens.cacheRead;
      bucket.cacheWrite += tokens.cacheWrite;
      calls += rowCalls;
      costYuan += cost;
      return {
        provider: String(row.provider ?? ""),
        model: String(row.model ?? ""),
        calls: rowCalls,
        ...tokens,
        price,
        costYuan: round(cost),
      };
    });
    return {
      month: targetMonth,
      bucket,
      calls,
      unpricedCalls,
      costYuan: round(costYuan),
      models,
      settings,
      budget: buildBudget(settings.monthlyBudgetYuan, costYuan),
      current: {
        provider: configured.provider,
        model: configured.model,
        price: resolveModelPrice(configured.model, settings.priceOverrides),
      },
    };
  }
}

function normalizeBudget(value: number | null): number | null {
  if (value === null) return null;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) return null;
  return round(budget);
}

function buildBudget(limitYuan: number | null, usedYuan: number): UsageBudget {
  if (limitYuan === null) {
    return { limitYuan: null, usedYuan: round(usedYuan), remainingYuan: null, ratio: null, exceeded: false };
  }
  const ratio = limitYuan > 0 ? usedYuan / limitYuan : (usedYuan > 0 ? 1 : 0);
  return {
    limitYuan,
    usedYuan: round(usedYuan),
    remainingYuan: round(limitYuan - usedYuan),
    ratio: Math.round(ratio * 10000) / 10000,
    exceeded: usedYuan >= limitYuan && limitYuan > 0,
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
