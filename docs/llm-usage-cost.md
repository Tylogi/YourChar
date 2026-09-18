# LLM usage and cost

YourChar keeps a monthly ledger of real provider token usage and estimates the
equivalent API cost in CNY. The **用量** (Usage) page in the left rail shows it.

## What is recorded

One row per real model call, holding `provider`, `model`, and the token bucket
the provider reported: `input`, `output`, `cacheRead`, `cacheWrite`. Rows are
bucketed by calendar month in `Asia/Shanghai`.

The ledger stores only usage a provider actually returned. When a provider
returns no usage, nothing is written; YourChar never estimates tokens or invents
a call. Reasoning tokens are not stored yet, and the streaming hook covers the
main conversation only: subagent runs and the Creator Assistant are not counted.

## Where the numbers come from

- Non-streaming calls report through the `ModelProviderRegistry` usage observer.
- Streaming calls report on pi's `message_end` event for assistant messages.

Both feed `UsageService.recordModelCall()`, which reuses the existing
`normalizeActualProviderUsage` mapping. A failing usage write is swallowed, so
accounting can never break a model call.

## Storage

Migration 70 adds `usage_events` (append-only ledger); migration 71 adds
`usage_settings`, whose single `default` row holds the monthly budget and price
overrides.

## Pricing

`src/usage/pricing.ts` ships a catalog of CNY-per-million-token prices. A model
missing from the catalog is still counted, but stays unpriced and is left out of
the cost total; the page reports how many calls are unpriced. The Usage page can
also override the four prices for the currently configured model, and overrides
accept any model key, so local or brand-new models can be priced without a code
change. Invalid prices (negative or non-numeric values) are dropped before the
row is written.

## Monthly budget

`usage_settings.monthly_budget_yuan` holds an optional cap in CNY. The page
warns from 80% of the cap and flags an over-budget month. A budget never blocks a
model call.

## HTTP

- `GET /api/v1/usage?month=YYYY-MM` — tokens, per provider/model rows, cost, and
  budget state; defaults to the current month.
- `POST /api/v1/usage/settings` — `{ monthlyBudgetYuan, priceOverrides }`; an
  omitted field keeps its stored value.
