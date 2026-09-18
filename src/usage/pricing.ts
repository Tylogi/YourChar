import type { ModelPrice, UsageTokenBucket } from "./types.js";

type PriceCatalogEntry = {
  model: string;
  label: string;
  price: ModelPrice;
};

const localPrice: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 单价单位：元 / 百万 token。与已确认过的演示价目保持一致。 */
export const modelPriceCatalog: readonly PriceCatalogEntry[] = Object.freeze([
  { model: "deepseek-chat", label: "DeepSeek Chat", price: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
  { model: "deepseek-reasoner", label: "DeepSeek Reasoner", price: { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 } },
  { model: "gpt-4o-mini", label: "GPT-4o mini", price: { input: 1.1, output: 4.3, cacheRead: 0.55, cacheWrite: 1.1 } },
  { model: "gpt-4o", label: "GPT-4o", price: { input: 18, output: 72, cacheRead: 9, cacheWrite: 18 } },
  { model: "claude-3-5-haiku", label: "Claude 3.5 Haiku", price: { input: 5.8, output: 28.8, cacheRead: 0.58, cacheWrite: 7.2 } },
  { model: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", price: { input: 21.6, output: 108, cacheRead: 2.16, cacheWrite: 27 } },
  { model: "gemini-1.5-flash", label: "Gemini 1.5 Flash", price: { input: 0.54, output: 2.16, cacheRead: 0.14, cacheWrite: 0.54 } },
  { model: "gemini-1.5-pro", label: "Gemini 1.5 Pro", price: { input: 9, output: 36, cacheRead: 2.25, cacheWrite: 9 } },
  { model: "qwen3-32b-local", label: "Qwen3 32B（本地）", price: localPrice },
]);

export function normalizeModelKey(model: string): string {
  return String(model ?? "").trim().toLowerCase();
}

export function isModelPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every((key) => {
    const price = candidate[key];
    return typeof price === "number" && Number.isFinite(price) && price >= 0;
  });
}

export function normalizeModelPrice(value: ModelPrice): ModelPrice {
  return {
    input: Number(value.input),
    output: Number(value.output),
    cacheRead: Number(value.cacheRead),
    cacheWrite: Number(value.cacheWrite),
  };
}

export function sanitizePriceOverrides(value: unknown): Record<string, ModelPrice> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, ModelPrice> = {};
  for (const [key, price] of Object.entries(value as Record<string, unknown>)) {
    const model = normalizeModelKey(key);
    if (!model || !isModelPrice(price)) continue;
    output[model] = normalizeModelPrice(price);
  }
  return output;
}

/** 先查用户覆盖价，再按模型名从内置价目里取。取不到就返回 null，不猜价格。 */
export function resolveModelPrice(
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | null {
  const key = normalizeModelKey(model);
  if (!key) return null;
  const override = overrides?.[key];
  if (override) return normalizeModelPrice(override);
  let best: PriceCatalogEntry | null = null;
  for (const entry of modelPriceCatalog) {
    if (key === entry.model) return { ...entry.price };
    if (key.startsWith(entry.model) && (!best || entry.model.length > best.model.length)) {
      best = entry;
    }
  }
  return best ? { ...best.price } : null;
}

export function usageCost(bucket: UsageTokenBucket, price: ModelPrice): number {
  return bucket.input / 1e6 * price.input +
    bucket.output / 1e6 * price.output +
    bucket.cacheRead / 1e6 * price.cacheRead +
    bucket.cacheWrite / 1e6 * price.cacheWrite;
}

export function emptyUsageBucket(): UsageTokenBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
