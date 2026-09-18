import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { AppDatabase } from "../storage/database.js";
import { getZonedDateTimeParts } from "../domain/time.js";
import { sanitizePriceOverrides } from "./pricing.js";
import type { ModelPrice, UsageEvent, UsageSettings } from "./types.js";

type Row = Record<string, unknown>;

export const usageTimezone = "Asia/Shanghai";

export function usageMonthKey(date: Date): string {
  const parts = getZonedDateTimeParts(date, usageTimezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

export function currentUsageMonth(clock: Clock): string {
  return usageMonthKey(clock.now());
}

export class UsageRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  record(event: UsageEvent): void {
    this.database.connection.prepare(`
      INSERT INTO usage_events(
        id, provider, model, month,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idGenerator.next("usage-event"),
      event.provider,
      event.model,
      usageMonthKey(this.clock.now()),
      Math.max(0, Math.trunc(event.input)),
      Math.max(0, Math.trunc(event.output)),
      Math.max(0, Math.trunc(event.cacheRead)),
      Math.max(0, Math.trunc(event.cacheWrite)),
      this.clock.now().toISOString(),
    );
  }

  monthRows(month: string): Row[] {
    return this.database.connection.prepare(`
      SELECT provider, model, COUNT(*) AS calls,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
      FROM usage_events
      WHERE month = ?
      GROUP BY provider, model
      ORDER BY (SUM(input_tokens) + SUM(output_tokens) +
        SUM(cache_read_tokens) + SUM(cache_write_tokens)) DESC
    `).all(month) as Row[];
  }

  settings(): UsageSettings {
    const row = this.database.connection.prepare(
      "SELECT monthly_budget_yuan, price_overrides_json FROM usage_settings WHERE id = 'default'",
    ).get() as Row | undefined;
    if (!row) return { monthlyBudgetYuan: null, priceOverrides: {} };
    return {
      monthlyBudgetYuan: typeof row.monthly_budget_yuan === "number" ? row.monthly_budget_yuan : null,
      priceOverrides: parsePriceOverrides(row.price_overrides_json),
    };
  }

  saveSettings(settings: UsageSettings): UsageSettings {
    this.database.connection.prepare(`
      INSERT INTO usage_settings(id, monthly_budget_yuan, price_overrides_json, updated_at)
      VALUES ('default', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        monthly_budget_yuan = excluded.monthly_budget_yuan,
        price_overrides_json = excluded.price_overrides_json,
        updated_at = excluded.updated_at
    `).run(
      settings.monthlyBudgetYuan,
      JSON.stringify(settings.priceOverrides),
      this.clock.now().toISOString(),
    );
    return this.settings();
  }
}

function parsePriceOverrides(value: unknown): Record<string, ModelPrice> {
  if (typeof value !== "string") return {};
  try {
    return sanitizePriceOverrides(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}
