# Pi-Style Python Refactor

## Goal

The kernel should behave like a durable companion agent, not a chatbot-shaped
collection of routes. The refactor separates generic agent-runtime concerns
from RP/SMS product concerns.

## Layers

### Harness

`rp_agent_kernel.harness` owns the operational shape:

- internal `AgentMessage`;
- `AgentToolCall` and `AgentToolResult`;
- stable `AgentEvent` lifecycle records;
- `AgentHarness.run()` turn sequencing.

This follows Pi's useful split: internal runtime messages are not automatically
model messages. Runtime-only events, reminders, debug notices, UI state, and
future steering messages can exist without polluting the provider request.

### Domain

`rp_agent_kernel.domain` owns product behavior:

- context assembly and trace blocks;
- real-vs-fiction intent boundary;
- calendar/reminder/task/memory tool execution;
- SMS and RP rendering;
- shared-timeline recording.

The domain layer plugs into the generic harness through `CompanionAgent`.

### Adapters

Package-root modules keep external contracts stable:

- `api.py`: FastAPI routes;
- `storage.py`: SQLite persistence;
- `external_model.py`: OpenAI-compatible rendering;
- `runtime.py`: due reminder/task scheduler;
- `character_cards.py`, `ics.py`, `sdk/`: IO adapters.

## Current Turn Flow

1. API receives a message request.
2. `Kernel` calls `CompanionAgent.prepare_message()`.
3. `AgentHarness` emits lifecycle events.
4. Domain handler builds context, plans intent, executes deterministic tools,
   and renders a fallback reply.
5. `Kernel` optionally asks the external model to render the final reply.
6. `Kernel` persists user/assistant messages and records shared episodes.

## Next Refactor Targets

- Persist harness events as append-only session entries.
- Add explicit steering and follow-up queues for proactive reminders.
- Represent tool metadata with idempotency and retry-safety.
- Move external model rendering behind a provider boundary matching the harness
  message model.
- Add RP-specific modules for relationship state, scene state, and shared
  reality projection.
