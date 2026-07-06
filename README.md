# Companion Kernel

Headless companion agent kernel prototype.

The product model is one continuous companion with two postures:

- `sms`: practical posture for real-world schedule, reminders, tasks, and concise confirmations.
- `rp`: immersive posture for character scenes, shared time, and common memories.

The internal API still uses `sms` and `rp` as stable runtime labels. User-facing copy should present them as practical and immersive postures, not as two separate bots.

## Product Principles

- Shared timeline first: the companion should remember common experiences with the user.
- Reality can softly shape immersion: time of day, nearby reminders, and task pressure may influence pacing and care.
- Immersion cannot silently mutate reality: real calendar, reminder, and task writes require practical posture or explicit real-world phrasing.
- Practical replies should still feel like the same person, only shorter and more action-oriented.
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

The UI includes practical/immersive chat, session history reload, keyboard send, slash commands, schedule and reminder panels, OpenAI-compatible API settings, character settings/card import, feature flag toggles, eval runner, model-call logs, and context trace viewer.

Useful UI commands: `/sms`, `/rp`, `/calendar`, `/features`, `/model`, `/characters`, `/trace`, `/eval`, `/clear`.

When OpenAI-compatible API settings are enabled, chat replies call the configured `/chat/completions` endpoint. Planner and tool execution stay local and deterministic; model failures are recorded as `external_model_render:failed` and fall back to the local renderer.

In the UI model panel, save the Base URL/API Key first, then click `拉取模型` to read `{baseUrl}/models` and select an existing model from the dropdown. Manual model entry remains available for providers that do not expose `/models`.

## Core Contracts

- `POST /api/sessions/{id}/messages`
- `GET /api/sessions/{id}/messages`
- `GET /api/events/stream`
- `GET /api/events/poll`
- `GET /api/events/pending`
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

Practical replies can refer to the existence of a recent shared experience without treating fictional details as real schedule state.

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

## Reality Projection

Normal immersive replies receive a read-only `shared_reality` projection:

- local time;
- nearby real-world calendar/reminders;
- rough task pressure.

This projection may shape pacing and care. It is not an authoritative tool result and cannot create or modify real-world state. Explicit real-world phrasing still uses the normal calendar/reminder/task tools and safety gates.

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

The eval endpoint is deterministic and returns assertion results plus latency metrics.

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

Supported assertions: `replyContains`, `replyNotContains`, `actionType`, `actionStatus`, `contextTracePresent`, `maxLatencyMs`, `minReplyChars`.

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
