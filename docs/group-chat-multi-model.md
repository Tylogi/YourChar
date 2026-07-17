# Group Chat and Multi-Model Contract

Status: implemented baseline

## Model profiles

- Model settings are stored as a versioned profile collection in `model-api.json`.
- Existing singleton settings migrate to the `default` profile without exposing the API key.
- One profile is always the system default. Background jobs such as reminder composition and memory extraction use it.
- A character may bind `modelProfileId`. An unbound character inherits the system default.
- A missing or deleted binding falls back to the default. A bound but disabled profile remains unavailable by intent.
- Deleting a profile clears matching character bindings. At least one profile must remain.

## Group persistence

Group chats, ordered membership, turns, messages, and participation decisions are stored in SQLite. A group contains 2-8 unique characters and has a fixed SMS or RP mode. `maxSpeakers` limits the number of distinct participating characters and defaults to at most three. Active and archived groups share the same batch-management lifecycle as direct sessions.

Group messages keep an explicit sender type and character ID. They are not stored as a direct Pi session because a Pi session has one character identity and one model binding.

## Turn scheduling

One user message creates exactly one group turn:

1. Candidates are rotated after the previous character speaker; explicitly mentioned characters move to the front.
2. Each candidate receives a participation gate call with its own model profile.
3. A silent decision advances to the next candidate.
4. A speaking decision triggers one separate reply call with the same character model.
5. The reply is persisted before the next candidate is evaluated, so later characters see earlier replies from the same turn.
6. After one complete pass produces a reply, eligible characters are evaluated again against the expanded transcript.
7. A character can send at most ten messages in one user turn. Scheduling stops when a complete pass produces no replies or every eligible character reaches its cap.

The gate must return `{ "speak": boolean, "reasonCode": string }`. Reasoning-capable providers receive enough output budget to finish the JSON, and fenced or lightly wrapped JSON is accepted. Only the bounded decision is persisted; provider reasoning is not written into the group transcript.

## Context and safety

Each actor receives its own SOUL.md, the manual user profile, relevant confirmed reality memory, relevant confirmed character memory, current time, and a bounded JSON group transcript. Group bootstrap retrieval is disabled to avoid repeated low-signal memory injection.

SMS group replies are first-person instant messages. RP group replies use third-person limited narration and may control only the selected character. No actor may decide speech, actions, or internal state for the user or another character.

The initial group baseline has no MCP, shell, schedule, or workspace tools. This prevents concurrent actors from producing duplicate or conflicting side effects. Tool access should be added later through a group-level coordinator with explicit arbitration and idempotency, not independently to every actor.

## Failure behavior

- A missing or disabled model marks only that character as failed and scheduling continues.
- Invalid gate output is `gate_failed`; invalid reply output is `generation_failed`.
- A turn is `completed`, `partial`, `failed`, or `cancelled` according to aggregate outcomes.
- SSE exposes lifecycle states (`evaluating`, `silent`, `typing`, `failed`), persisted messages, and the final turn result. The UI keeps evaluation and silence in the background and creates a visible placeholder only after a character enters `typing`.
- Gate and reply provider payloads are retained in the bounded Debug Trace as `group_gate` and `group_reply`.

## Test requirements

Changes must preserve tests for legacy model migration, secret masking, per-character routing, deleted-profile fallback, serial transcript visibility, silent roles, participant and per-character message caps, group archive/delete lifecycle, HTTP/SSE persistence, backup compatibility, and desktop/mobile browser layout.
