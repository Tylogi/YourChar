# RP Agent Kernel

Headless dual-mode agent kernel prototype for:

- `sms`: concise real-world secretary interactions.
- `rp`: long-form roleplay interactions with isolated story memory.

The kernel is UI-agnostic. Desktop apps, web apps, IM bots, Codex, or other agents can call it through HTTP/SSE or the SDKs.

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

The UI includes SMS/RP chat, session history reload, keyboard send, slash commands, schedule and reminder panels, OpenAI-compatible API settings, RP character settings/card import, feature flag toggles, eval runner, and context trace viewer.

Useful UI commands: `/sms`, `/rp`, `/calendar`, `/features`, `/model`, `/characters`, `/trace`, `/eval`, `/clear`.

When OpenAI-compatible API settings are enabled, chat replies call the configured `/chat/completions` endpoint. Planner and tool execution stay local and deterministic; model failures are recorded as `external_model_render:failed` and fall back to the local renderer.
In the UI model panel, save the Base URL/API Key first, then click `拉取模型` to read `{baseUrl}/models` and select an existing model from the dropdown. Manual model entry remains available for providers that do not expose `/models`.

## Core Contracts

- `POST /api/sessions/{id}/messages`
- `GET /api/sessions/{id}/messages`
- `GET /api/events/stream`
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

## Feature Flags

Every major capability has an independent switch through `GET/PATCH /api/features`:

`calendar`, `tasks`, `reminders`, `characters`, `rp_memory`, `secretary_memory`, `context_trace`, `confirmation_safety`, `ics`, `event_stream`, `metrics`, `deterministic_eval`, `fts_search`.

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
      "id": "sms-reminder",
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
