# Private Conversation Interaction State

Status: implemented trial baseline
Audience: maintainers, coding agents, reviewers, and test agents
Last updated: 2026-07-19

## 1. Product Contract

Private conversation mode and narrative lens are separate concerns:

- `sms` is the character's canonical ongoing life. It normally renders first-person remote messages, but may enter a confirmed in-person scene without creating a new conversation.
- `rp` is an isolated narrative sandbox. It keeps close third-person narration and does not enter the canonical meeting state machine.
- The product never asks the user to confirm a technical "mode switch" in character dialogue. It confirms an in-world fact: a meeting was planned, the user arrived, or the meeting ended.

An SMS meeting follows this state machine:

```text
remote --propose_meeting--> meeting_pending --begin_meeting--> co_present
   |___________________________________________________________^
             begin_meeting (immediate established scene)
   ^                              |                              |
   |                        cancel_meeting                       |
   +------------------------------+--------- end_meeting --------+
```

`remote` and `meeting_pending` use first-person direct messages. `co_present`
uses observable-scene output: environment plus the character's visible actions,
expression, and dialogue. The model must never invent the user's movement,
speech, decisions, sensations, or inner state.

## 2. Confirmation Experience

The preferred path is semantic and unobtrusive:

1. A future agreement uses `propose_meeting`; an inline event records the plan while the conversation remains remote.
2. A later user arrival uses `begin_meeting`. If the current conversation already semantically establishes immediate co-presence, such as opening the door to the arriving character or returning to the shared scene, `begin_meeting` transitions directly from `remote` with a concrete location. It must not be paired with `propose_meeting` in the same tool batch.
3. Ambiguous, prospective, or negative language such as "我快到了", "我还没到", or "你到了吗" cannot confirm arrival. The character asks a natural in-world follow-up and remains in message form.
4. The header control is a trusted fallback. It lets the user record a place, explicitly confirm "我到了", end a meeting, or undo the latest reversible transition without writing technical commands into chat.

Ending is deliberately delayed. `end_meeting` first creates a pending event; the
current reply remains an in-person farewell. Only after a successful final reply
does the runtime return to remote messages. A failed or cancelled generation
cancels the pending transition, avoiding a silent state change without a visible
farewell.

In normal space, if the main Agent omits `end_meeting`, a completed co-present
turn is eligible for the bounded fallback in
[post-turn-coordinator.md](./post-turn-coordinator.md). That fallback uses exact
evidence and the unchanged interaction revision. It does not handle arrival
and cannot end a later meeting. Private-space meetings intentionally do not
enter the shared relationship/post-turn pipeline; they end through the scoped
Interaction tool or the trusted UI control.

## 3. Durable State and Conversation Spaces

SQLite migration 20 originally added the interaction tables. Migration 40
adds an explicit `conversation_space` and private owner to both tables and
rebuilds the co-presence uniqueness constraint.

| Table | Purpose |
|---|---|
| `conversation_interaction_states` | latest continuity, presence, lens, location, pending event, and monotonic revision per private role session |
| `interaction_transition_events` | append-only transition provenance, before/after snapshots, evidence kind, idempotency key, and apply/revert status |

Only one canonical SMS session per character and conversation space may be
`co_present` at a time. The same character can therefore have one normal and
one private meeting without either state blocking or revealing the other. A
private row is additionally bound to the selected character as its private
owner. RP sandbox sessions are excluded from this uniqueness rule. Character
or role-session deletion cascades to interaction state and events. Complete
user-data deletion removes both tables, and schema version 40 participates in
normal backup/restore compatibility checks.

Transition events distinguish `agent_tool`, `user_control`, `system`, and
`post_turn_coordinator` sources. MCP mutations use the Pi tool-call ID as an idempotency key. UI
mutations run through the same per-conversation execution queue as model turns,
so they cannot race an active reply.

## 4. Context and Cache Economics

The stable SMS system prompt contains both remote-message and co-present-scene
contracts. It does not change when a meeting starts, preserving the provider's
stable prefix and KV-cache opportunity.

Only the latest compact projection is added to the volatile turn carrier:

```xml
<interaction_state continuity="canonical" presence="co_present"
  lens="observable_scene" revision="3">
Physical co-presence is confirmed at: 未来道具研究所.
Use observable-scene output ...
</interaction_state>
```

`interaction_state` is a peer of `world_runtime`, not a user message and not a
new system message. The Context Planner budget is 180 estimated tokens. Older
runtime snapshots are removed by the existing `rp-agent/turn_context`
latest-only filter, so state does not accumulate over conversation turns.

When a normal conversation is `co_present`, the current scene projection may
also enter the latest volatile context even though the conversation mode
remains SMS. Private meetings inject only their private interaction projection;
they never read or write the normal Scene projection. Returning to `remote`
removes the applicable projection on the next turn. Tool results communicate a
successful begin/end decision to the remainder of the current model loop, so
the visible reply does not need to wait one extra turn.

## 5. Interaction State MCP

`mcp:interaction-state` is enabled by default and contributes approximately 650
provider-schema tokens only when loaded. It is available only in a direct SMS
conversation with a bound character while the module is enabled.

Tools:

- `propose_meeting` records a future concrete plan but does not claim co-presence;
- `begin_meeting` uses the Agent's semantic reading of immediate co-presence, accepts a direct remote transition at a concrete location, and deterministically rejects current messages that explicitly negate or defer arrival;
- `end_meeting` schedules the transition until the farewell reply succeeds.

The model cannot submit a character, session ID, conversation space, or private
owner. The bridge binds all four to trusted active-session metadata. In private
space, `placeId` is rejected and only a bounded human-readable location is
accepted. Disabling the module removes transition tools while retaining stored
state, injected state interpretation, and trusted UI controls. This lets a user
finish or repair an existing meeting without re-enabling model mutation.

## 6. World and Autonomy Coordination

For normal conversations, when a canonical world place is selected, beginning a meeting updates the
character runtime to that place with activity `与用户见面` and availability
`busy`. The begin event records the previous compact world runtime; ending or
undoing arrival restores that place, activity, availability, and expected end
instead of assuming the character was previously free. Historical world and
scene records remain available for continuity.

The World Coordinator may continue planning and retaining pending events while
the character is co-present, but it must not deliver a proactive SMS into the
same conversation or overwrite the meeting with a background schedule runtime
projection. Eligible pending messages remain durable and may be delivered after
separation.

Private meetings do none of those projections: they do not enumerate World
places, change character runtime, read the normal scene, suppress normal
proactive work, or apply a shared meeting preset. Their location and events
exist only in that character's private interaction partition.

## 7. HTTP and UI Contract

```text
GET  /api/v1/sessions/{sessionId}/interaction
POST /api/v1/sessions/{sessionId}/interaction
```

POST actions are `propose`, `begin`, `end`, `cancel`, and `undo`. `begin` and
`end` from the control plane require `userConfirmed: true`. Evidence failures
use HTTP 422 and state conflicts use HTTP 409 with stable `INTERACTION_*` codes.

The conversation header displays `角色私聊`, `约好见面`, or `见面中`; private
space uses `私密对话`, `私密 · 约好见面`, and `私密见面中`. A short location is
shown where relevant. Every request is scoped by conversation space and, for
private space, the selected character owner. Transition history is merged
chronologically into the visible transcript as compact non-message dividers.
These events are not written as user or character speech.

## 8. Agent Test Interface

Three built-in Debug feature tests exercise model compatibility:

- `interaction-meeting-proposal`;
- `interaction-arrival-confirmation`;
- `interaction-meeting-departure`.

`TestRuntime.snapshot()` includes `interactionStates` and
`interactionEvents`. Automated tests use a scripted model, virtual clock, and
isolated SQLite database to cover successful transitions, ambiguous arrival,
semantic Agent-controlled departure, failed farewell rollback, omission without
a hidden fallback, provider tool-protocol leakage, HTTP confirmation, and
proactive-message suppression.

## 9. Required Invariants

- An intention to meet is not evidence of physical co-presence.
- Positive arrival/co-presence evidence is interpreted semantically from the current real user message and continuous conversation; explicit future, negative, or questioning language is rejected. UI confirmation remains a separate trusted path.
- The Agent may end co-presence for the user only by semantically reading a clear current user decision or completed departure; it cannot invent user movement.
- Beginning applies before the visible scene reply; ending applies after the visible farewell reply.
- `end_meeting` has no keyword recognizer or deterministic fallback. If the model omits the tool, co-presence remains active until a later Agent decision or explicit UI control.
- Failed or cancelled turns leave the prior presence state intact.
- Serialized provider tool syntax is never user-visible. After a real tool call, one corrective generation may run with mutating tools disabled rather than repeat the side effect.
- A character cannot be canonically co-present in two sessions within the same
  conversation space; normal and private co-presence are independent.
- A private meeting cannot use a normal World place ID, World runtime, Scene,
  relationship state, user profile, or meeting preset.
- RP remains a sandbox and cannot mutate canonical interaction/world presence.
- Interaction runtime context is bounded, latest-only, and labeled as not user-authored.
- Foreground and UI transitions are serialized per conversation and idempotent where model-driven.

Future automatic location inference, shared encounters, or RP-to-world linking
must add explicit evidence and conflict rules; none may weaken these invariants.
