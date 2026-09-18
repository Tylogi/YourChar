export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTokenBucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageEvent = UsageTokenBucket & {
  provider: string;
  model: string;
};

export type UsageSettings = {
  monthlyBudgetYuan: number | null;
  priceOverrides: Record<string, ModelPrice>;
};

export type UsageModelRow = UsageTokenBucket & {
  provider: string;
  model: string;
  calls: number;
  price: ModelPrice | null;
  costYuan: number;
};

export type UsageBudget = {
  limitYuan: number | null;
  usedYuan: number;
  remainingYuan: number | null;
  ratio: number | null;
  exceeded: boolean;
};

export type UsageSummary = {
  month: string;
  bucket: UsageTokenBucket;
  calls: number;
  unpricedCalls: number;
  costYuan: number;
  models: UsageModelRow[];
  settings: UsageSettings;
  budget: UsageBudget;
  current: {
    provider: string;
    model: string;
    price: ModelPrice | null;
  };
};
