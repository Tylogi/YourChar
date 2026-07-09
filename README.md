# Companion Kernel

Headless RP/SMS companion agent kernel prototype.

This version is a Pi-inspired Python refactor. The previous implementation and
docs were preserved under `legacy/pre_pi_refactor_20260709/`.

## Product Model

The product is one continuous companion with two views:

- `sms`: first-person direct message view.
- `rp`: third-person life narrative view.

Both views share real time, calendar, reminders, tasks, proactive events, and
shared relationship memory. View changes expression, not capability.

## Architecture

The new package separates agent harness mechanics from RP product logic:

- `rp_agent_kernel.harness`: provider-neutral messages, lifecycle events,
  tool calls/results, and the turn loop.
- `rp_agent_kernel.domain`: RP/SMS context assembly, intent planning,
  deterministic tools, rendering, and shared-timeline behavior.
- stable adapters at package root: FastAPI API, SQLite storage, OpenAI-compatible
  model adapter, ICS, character-card import, runtime scheduler, and SDKs.

The key design choice follows Pi's taste: the kernel emits structured internal
events and keeps runtime messages separate from model/provider messages. This
makes WebUI, TUI, SDK subscriptions, debug logs, and automated eval easier to
build without contaminating model context.

## Run

```bash
uv sync
uv run rp-agent-kernel
```

Default service URL: `http://127.0.0.1:8765`.

Temporary WebUI:

```text
http://127.0.0.1:8765/ui
```

## Core API

- `POST /api/sessions/{id}/messages`
- `POST /api/sessions/{id}/messages/stream`
- `GET /api/sessions`
- `GET /api/events/stream`
- `GET /api/events/poll`
- `GET /api/events/pending`
- `POST /api/runtime/tick`
- `POST /api/events/{deliveryId}/delivery`
- `GET/POST/PATCH/DELETE /api/calendar/events`
- `GET/POST/PATCH/DELETE /api/tasks`
- `GET/POST/PATCH/DELETE /api/reminders`
- `GET/POST/PATCH/DELETE /api/characters`
- `POST /api/characters/import-card`
- `GET/PATCH /api/model-config/openai-compatible`
- `GET /api/model-config/openai-compatible/models`
- `GET/PATCH /api/features`
- `GET/PATCH /api/companion-profile`
- `GET/PATCH /api/debug/time`
- `GET /api/context-traces/{id}`
- `POST /api/eval/run`

## Development

```bash
uv run pytest -q
```

Architecture notes are in [docs/architecture.md](docs/architecture.md).
Evaluation criteria are in [docs/evaluation.md](docs/evaluation.md).
