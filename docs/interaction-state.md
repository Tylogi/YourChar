# Private Conversation Interaction State

Status: implemented trial baseline
Audience: maintainers, coding agents, reviewers, and test agents
Last updated: 2026-09-04

## 1. Product Contract

Private conversation mode and narrative lens are separate concerns:

- `sms` is the character's canonical ongoing life and remains a first-person remote-message surface. For a normal-space character assigned to a World, confirmed arrival hands the interaction to that World's shared Scene instead of continuing physical narration inside SMS.
- `rp` is an isolated narrative sandbox. It keeps close third-person narration and does not enter the canonical meeting state machine.
- Secret and incognito conversations cannot enter a normal-space World. Their existing one-character observable scene is retained as an isolated compatibility path.
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

`remote` and `meeting_pending` use first-person direct messages. For a World-bound
normal conversation, `co_present` means the physical interaction is active on
the linked World Scene; the SMS thread emits only a short handoff and cannot
continue the encounter. The World model writes cohesive third-person prose for
the environment and every plausible co-located participant. Isolated fallback
meetings retain the previous one-character observable-scene output. Neither
surface may invent the user's movement, speech, decisions, sensations, or inner
state.

## 2. Confirmation Experience

The preferred path is semantic and unobtrusive:

1. A future agreement uses `propose_meeting`; an inline event records the plan while the conversation remains remote.
2. A later user arrival uses `begin_meeting`. If the current conversation already semantically establishes immediate co-presence, such as opening the door to the arriving character or returning to the shared scene, `begin_meeting` transitions directly from `remote` with a concrete location. It must not be paired with `propose_meeting` in the same tool batch.
3. Ambiguous, prospective, or negative language such as "我快到了", "我还没到", or "你到了吗" cannot confirm arrival. The character asks a natural in-world follow-up and remains in message form.
4. The header control is a trusted fallback. It lets the user record a place, explicitly confirm "我到了", or undo the latest reversible transition without writing technical commands into chat. A successful World-bound begin opens the World Scene immediately.
5. The World Scene header can explicitly end the encounter and return to the originating SMS thread. A sufficiently supported World Analyzer event resolution also ends the linked interaction state; the final World passage remains visible and the UI offers a return-to-SMS control.

For isolated fallback meetings, ending remains deliberately delayed:
`end_meeting` first creates a pending event and applies it only after the final
reply succeeds. World-bound meetings normally end from the Scene event lifecycle
or its trusted header control. Closing either side closes the other side as one
linked transition.

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
rebuilds the co-presence uniqueness constraint. Migration 51 links a World
story event to its originating SMS session through `meeting_session_id`.

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
  lens="observable_scene" revision="3" world_id="world-1" surface="world_scene">
Physical co-presence is confirmed at: 未来道具研究所.
The in-person interaction now belongs to the linked World scene ...
</interaction_state>
```

`interaction_state` is a peer of `world_runtime`, not a user message and not a
new system message. The Context Planner budget is 180 estimated tokens. Older
runtime snapshots are removed by the existing `rp-agent/turn_context`
latest-only filter, so state does not accumulate over conversation turns.

When a World-bound normal conversation is `co_present`, physical narrative
context is owned by the World narrative ledger rather than the SMS context.
The direct Agent receives a bounded `surface="world_scene"` marker and produces
only a transition message. Private meetings inject only their private
interaction projection and never read or write the normal World Scene.
Returning to `remote` removes the applicable projection on the next turn.

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

For normal conversations, beginning a meeting for a World member opens or joins
the current World event. The event is anchored to the selected canonical place
when available and starts with the primary character plus every character whose
runtime is at that place. This gives the World narrator authority to include
plausible bystanders without summoning absent characters. Beginning also updates
the primary character runtime to activity `与用户见面` and availability `busy`.
The interaction event records the prior compact runtime; ending or undoing
arrival restores it instead of assuming the character was previously free.

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

The SMS header displays `角色私聊`, `约好见面`, or `现场已开始`; its begin divider
offers `进入现场`. The destination World header displays `现场`, its location and
participants, and an `结束现场` action that returns to the originating SMS.
Private space retains `私密对话`, `私密 · 约好见面`, and `私密见面中`. Every
request is scoped by conversation space and, for private space, the selected
character owner. Transition history remains a compact non-message divider.

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
- A World-bound begin opens the linked World event before SMS emits its handoff; subsequent physical prose is generated only in the World Scene.
- `end_meeting` has no keyword recognizer or deterministic fallback. If the model omits the tool, co-presence remains active until a later Agent decision or explicit UI control.
- Failed or cancelled turns leave the prior presence state intact.
- Serialized provider tool syntax is never user-visible. After a real tool call, one corrective generation may run with mutating tools disabled rather than repeat the side effect.
- A character cannot be canonically co-present in two sessions within the same
  conversation space; normal and private co-presence are independent.
- A private meeting cannot use a normal World place ID, World runtime, Scene,
  relationship state, user profile, or meeting preset.
- RP remains a sandbox and cannot mutate canonical interaction/world presence.
- A World meeting event is linked to exactly one originating SMS session; closing that event returns the interaction to `remote` without erasing the World passage or character-scoped settlement memories.
- Interaction runtime context is bounded, latest-only, and labeled as not user-authored.
- Foreground and UI transitions are serialized per conversation and idempotent where model-driven.

Future automatic location inference or RP-to-world linking must add explicit
evidence and conflict rules; neither may weaken these invariants.
