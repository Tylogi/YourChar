# Companion Kernel

Headless companion agent kernel prototype.

The product model is one continuous companion with two views:

- `sms`: first-person direct message view. The character contacts the user as an NPC-like real companion.
- `rp`: third-person life narrative view. The character and user are described inside a shared everyday scene.

The internal API still uses `sms` and `rp` as stable runtime labels. User-facing copy should present them as message and life-narrative views, not as two separate bots.

## Product Principles

- Shared timeline first: the companion should remember common experiences with the user.
- One reality timeline: both views share real time, schedule, reminders, tasks, and proactive events.
- View changes expression, not capability: `sms` is direct first-person messaging; `rp` is third-person life narration.
- Fiction cannot silently mutate reality: story markers such as plot, scene, character setting, or fictional framing stay in memory and do not write real calendar, reminder, or task state.
- Real-world writes are decided by intent and safety gates, not by mode alone.
- Product copy should avoid exposing mode mechanics unless a safety boundary needs to be clear.

## Run

```bash
uv sync
uv run rp-agent-kernel
```

Default service URL: `http://127.0.0.1:8765`.

Chat-first browser UI:

```text
http://127.0.0.1:8765/ui
```

The UI includes message/life-narrative chat, session history reload, keyboard send, slash commands, schedule and reminder panels, runtime reminder/task event subscription, OpenAI-compatible API settings, character settings/card import, feature flag toggles, eval runner, model-call logs, and context trace viewer.

Useful UI commands: `/sms`, `/rp`, `/calendar`, `/features`, `/model`, `/characters`, `/trace`, `/eval`, `/clear`.

When OpenAI-compatible API settings are enabled, chat replies call the configured `/chat/completions` endpoint. Planner and tool execution stay local and deterministic; model failures are recorded as `external_model_render:failed` and fall back to the local renderer.

In the UI model panel, save the Base URL/API Key first, then click `拉取模型` to read `{baseUrl}/models` and select an existing model from the dropdown. Manual model entry remains available for providers that do not expose `/models`.

## External Model Prompt Layout

The OpenAI-compatible renderer uses a cache-friendly message order:

1. `system`: stable render contract for the selected view.
2. `system`: semi-stable companion profile and current character card.
3. recent chat history.
4. final `user`: dynamic runtime context plus the current user message.

Dynamic data such as current time, retrieved memory, action results, nearby schedule, reminders, and shared-present projection intentionally stays in the final user message. This preserves KV-cache reuse for stable prefixes and avoids invalidating the whole prompt whenever memory or time changes.

Reasoning content is never returned to the user. The adapter logs structured reasoning fields (`reasoning_content`, `reasoning`, `reasoningContent`) and also treats `<think>...</think>` / `<reasoning>...</reasoning>` content as reasoning by default. Visible replies are sanitized; model-call logs keep sanitized raw completion text for debugging.

## Core Contracts

- `POST /api/sessions/{id}/messages`
- `GET /api/sessions/{id}/messages`
- `GET /api/events/stream`
- `GET /api/events/poll`
- `GET /api/events/pending`
- `POST /api/runtime/tick`
- `POST /api/events/{deliveryId}/delivery`
- `GET/PATCH /api/companion-profile`
- `GET/PATCH /api/debug/time`
- `GET /api/shared-timeline`
- `GET/POST/PATCH/DELETE /api/calendar/events`
- `GET/POST/PATCH/DELETE /api/tasks`
- `GET/POST/PATCH/DELETE /api/reminders`
- `GET/POST/PATCH/DELETE /api/characters`
- `POST /api/characters/import-card`
- `GET/PATCH /api/model-config/openai-compatible`
- `GET /api/model-config/openai-compatible/models`
- `GET/PATCH /api/features`
- `GET /api/context-traces/{id}`
- `POST /api/confirmations/{id}`
- `GET /api/eval/capabilities`
- `POST /api/eval/run`

## Agent Tools And Intents

Schedule, reminder, and task changes are deterministic kernel tools, not free-form model text. The planner maps natural-language intent to tool operations, then the renderer explains the result.

Current agent tool operations:

- calendar: `create_calendar`, `list_calendar`, `delete_calendar`, `reschedule_calendar`, `bulk_delete_calendar`;
- reminders: `create_reminder`, `delete_reminder`, `update_reminder`;
- tasks: `create_task`, `list_tasks`, `delete_task`;
- memory: `write_secretary_memory`, `write_rp_memory`.

Single clear matches are executed directly. Ambiguous multi-match deletes require confirmation when `confirmation_safety` is enabled. Large destructive actions such as deleting all calendar events always require confirmation under the same safety flag. The tool contract is exposed through `GET /api/eval/capabilities` as `agentTools`.

## Companion Identity

The companion has a configurable profile:

```bash
curl -X PATCH http://127.0.0.1:8765/api/companion-profile \
  -H 'content-type: application/json' \
  -d '{
    "name": "林岚",
    "practicalVoice": "简短、可靠、带一点熟悉感。",
    "immersiveVoice": "克制、细腻、像和用户共享同一条时间线。",
    "addressStyle": "自然称呼，不提系统模式。"
  }'
```

This profile enters context for both postures. It shapes wording and continuity, not tool authorization.

## Shared Timeline

Immersive interactions write `SharedEpisode` records. These are common-experience memories:

- visible to both postures for continuity;
- marked `usableForRealWorldTools=false` by default;
- available through `GET /api/shared-timeline`;
- included in context trace as `shared_timeline`.

Direct-message replies can refer to the existence of a recent shared experience without treating fictional details as real schedule state.

## Debug Time

Long-run tests can accelerate the kernel clock:

```bash
curl -X PATCH http://127.0.0.1:8765/api/debug/time \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"now":"2026-07-08T08:00:00+08:00","timezone":"Asia/Shanghai"}'
```

When a message or event poll omits `now`, the kernel uses this debug clock. Explicit per-request `now` still wins. Clear it with:

```bash
curl -X PATCH http://127.0.0.1:8765/api/debug/time \
  -H 'content-type: application/json' \
  -d '{"clear":true}'
```

## Runtime Events

The production service starts an in-process runtime scheduler by default. It periodically checks due reminders/tasks and creates pending event deliveries. Tests that instantiate `create_app(db_path=...)` do not auto-start the scheduler unless `RP_AGENT_RUNTIME_SCHEDULER=true` is set. The interval is controlled by `RP_AGENT_RUNTIME_INTERVAL_SECONDS` and defaults to 15 seconds.

Agent-friendly manual push test:

```bash
curl -X PATCH http://127.0.0.1:8765/api/debug/time \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"now":"2026-07-08T08:00:00+08:00","timezone":"Asia/Shanghai"}'

curl -X POST http://127.0.0.1:8765/api/sessions/push-eval/messages \
  -H 'content-type: application/json' \
  -d '{"mode":"sms","text":"五分钟后提醒我喝水"}'

curl -X PATCH http://127.0.0.1:8765/api/debug/time \
  -H 'content-type: application/json' \
  -d '{"now":"2026-07-08T08:05:00+08:00"}'

curl -X POST http://127.0.0.1:8765/api/runtime/tick
```

`POST /api/runtime/tick` creates due deliveries but leaves them `pending`, which makes it safe for an SDK/UI/client agent to claim them. Consume and claim them through SSE:

```bash
curl -N "http://127.0.0.1:8765/api/events/stream?follow=true&includePending=true&clientId=eval-agent&leaseSeconds=30&intervalSeconds=1"
```

Then acknowledge the returned `eventDeliveryId` with the same client id:

```bash
curl -X POST http://127.0.0.1:8765/api/events/{deliveryId}/delivery \
  -H 'content-type: application/json' \
  -d '{"status":"acked","clientId":"eval-agent"}'
```

The Python and TypeScript SDKs expose the same flow as `subscribeEvents(handler, follow=true, includePending=true, clientId=...)` plus `ackEvent(deliveryId, clientId=...)`. The temporary WebUI subscribes automatically and displays `ReminderDue`/`TaskOverdue` events as chat messages, then acknowledges them.

## Shared Reality

Normal life-narrative replies receive a compact `shared_reality` projection:

- local time;
- nearby real-world calendar/reminders;
- rough task pressure.

This projection may shape pacing and care. It is not an authoritative tool result and cannot create or modify real-world state by itself. Real-world calendar/reminder/task writes are available in both views when the user's intent is real-world and the usual safety gates pass.

## Feature Flags

Every major capability has an independent switch through `GET/PATCH /api/features`:

`calendar`, `tasks`, `reminders`, `characters`, `rp_memory`, `secretary_memory`, `shared_timeline`, `companion_persona`, `reality_projection`, `debug_time`, `context_trace`, `confirmation_safety`, `ics`, `event_stream`, `metrics`, `deterministic_eval`, `fts_search`.

Example:

```bash
curl -X PATCH http://127.0.0.1:8765/api/features \
  -H 'content-type: application/json' \
  -d '{"flags":{"calendar":false}}'
```

Disabled features return `403` on their direct CRUD endpoints. Message handling returns an `action` with `status: "feature_disabled"` so tests can assert behavior without treating it as transport failure.

## Agent Evaluation

The stable evaluation rubric is in [docs/evaluation.md](docs/evaluation.md). It covers product quality, task reliability, memory boundaries, performance, token cost, context-window health, UI usability, and the five-round evaluator/modifier subagent protocol.

The eval endpoint is deterministic and returns assertion results plus latency, context, token, and cost-estimation metrics. If model token prices are not configured, cost is reported as `unknown` with input/output token counts instead of being treated as zero.

```bash
curl -X POST http://127.0.0.1:8765/api/eval/run \
  -H 'content-type: application/json' \
  -d '{
    "cases": [{
      "id": "practical-reminder",
      "sessionId": "eval-s1",
      "request": {
        "mode": "sms",
        "text": "三小时后提醒我喝水",
        "now": "2026-07-02T12:00:00+08:00"
      },
      "assertions": {
        "actionType": "create_reminder",
        "replyContains": "已设置提醒",
        "maxLatencyMs": 1000
      }
    }]
  }'
```

Supported assertions: `replyContains`, `replyNotContains`, `actionType`, `actionStatus`, `contextTracePresent`, `maxLatencyMs`, `minReplyChars`, `maxTokenEstimate`, `maxContextUsageRatio`, `maxGeneratedTokens`.

## SDKs

Python:

```python
from rp_agent_kernel.sdk import KernelClient

client = KernelClient("http://127.0.0.1:8765")
response = client.sendMessage("s1", "sms", "今晚八点安排项目会")
```

TypeScript SDK source is in `sdk/typescript/index.ts`.

## Verification

```bash
uv run pytest -q
```
