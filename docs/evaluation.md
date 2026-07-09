# Evaluation Principles

The evaluation target is one companion with two views, not two unrelated bots.

## Product Criteria

| Area | What must hold |
|---|---|
| Identity continuity | SMS and RP share the same companion identity and timeline. |
| Capability parity | Calendar, reminder, task, and proactive flows work in both views when intent is real-world. |
| Fiction boundary | Fictional or scene-marked content cannot silently mutate real calendar, reminder, or task state. |
| Shared memory | Shared episodes improve continuity without becoming authoritative real-world state. |
| View expression | SMS uses first-person direct messaging; RP uses third-person life narration. |

## Harness Criteria

| Area | What must hold |
|---|---|
| Event stability | Turns emit stable lifecycle events for UI/TUI/debug/eval. |
| Tool lifecycle | Tool calls have clear start/end records, action payloads, and safety outcomes. |
| Context economy | Stable prompt/context parts stay cache-friendly; dynamic time, tools, retrieval, and runtime state stay dynamic. |
| Recovery path | Future durable sessions can restore accepted queues and mark unfinished operations interrupted. |
| Test friendliness | Every feature has an independent flag and deterministic eval endpoint coverage. |

## Smoke Cases

1. Direct message creates, queries, updates, and deletes reminders.
2. RP creates a real reminder without requiring a `/real` prefix.
3. Fictional RP schedule phrasing writes memory only.
4. Runtime tick creates pending reminder/task deliveries.
5. SSE/client claim and ack flow is idempotent.
6. External model stream separates visible text from reasoning.
7. Context trace shows stable/semi-stable/dynamic blocks.
8. Debug time accelerates long-running evaluation.
