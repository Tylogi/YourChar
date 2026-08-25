# Shared World and Character Autonomy

Status: implemented trial baseline with controlled initiative
Audience: maintainers, coding agents, reviewers, and test agents
Last updated: 2026-08-24

## 1. Product Contract

This feature gives characters a small canonical life outside the current chat:

- multiple characters may belong to one shared fictional world;
- a world contains user-managed places with fixed functional capabilities;
- each character has a home, current place, activity, availability, energy, and autonomy policy;
- a world may define up to eight bounded numeric attributes. A definition is either
  world-shared (one value for the whole world) or character-specific (one value
  per character in that world);
- the background Coordinator may create character calendar events, settle completed activities into world events and RP memories, and send a bounded proactive SMS;
- same-world characters may use a persistent private channel for one-hop messages, bounded collaboration, and opt-in autonomous social exchanges;
- the Agent can inspect and mutate its own fictional state through a fixed MCP.

Canonical world state has two projections. A private `sms` thread lets one
character speak in first person from its ongoing life. The world's shared
timeline lets the Director and selected actors stage third-person events against
the same places, runtime, observations, and event lifecycle. Standalone RP and
ad hoc group sessions are retired. See
[`world-conversation-mode.md`](./world-conversation-mode.md).

World actions are fictional. They cannot mutate the user's schedule, reminders,
files, profile, permissions, or real-world state.

## 2. Architecture

```text
Character UI / HTTP API
        |
    WorldService -------------------- World State MCP ------ private SMS Pi session
        |
    WorldRepository -------- WorldConversationService ----- World timeline
        |
 SQLite schema 19 + initiative schema 25 + conversation schema 26
                   + character-channel schema 29 + capability schema 30
                   + character Skill schema 31
        |
 WorldAutonomyCoordinator (60 s tick)
        |             |                 |                    |
 character calendar  RP plot memory    proactive SMS queue  character channels
```

`WorldService` owns validation, assignment, runtime state, context projections,
and fictional actions. `WorldAutonomyCoordinator` owns asynchronous planning,
plan settlement, memory creation, and proactive delivery. `WorldRepository`
contains SQL only. Pi remains unmodified.

The Coordinator is not a continuously running model agent. It wakes on a cheap
timer, evaluates durable state, and makes isolated model calls only when a daily
plan or a proactive message is actually needed.

## 3. Storage Model

SQLite migration 19 adds:

| Table | Ownership and purpose |
|---|---|
| `role_worlds` | world name, timezone, description, Markdown rules, status, revision |
| `role_places` | world-owned place and fixed capability IDs |
| `character_world_memberships` | one canonical world and optional home per character |
| `character_autonomy_policies` | enable flags, daily message limit, global cooldown, quiet hours, optional pause, planning checkpoint |
| `character_runtime_states` | current place, activity, availability, energy, expected end |
| `character_activity_plans` | link from an autonomous or foreground-Agent world plan to a character schedule item |
| `world_events` | settled or explicit fictional events with idempotency keys |
| `world_event_participants` | character participants; supports future shared encounters |
| `proactive_messages` | durable candidate score, topic, decision, delivery, retry and feedback record |
| `proactive_topic_policies` | per-character normal, reduced or muted topic preference derived from direct feedback |

Migration 44 adds world-scoped character attributes, migration 45 replaces
direct Agent mutation with trusted post-turn rule analysis, and migration 46
adds an immutable world-shared/character-specific scope:

| Table | Ownership and purpose |
|---|---|
| `world_attribute_definitions` | up to eight owner-defined keys per world, with immutable value scope, integer range/default, visibility, and independent increase/decrease rules and fixed per-hit magnitudes |
| `world_attribute_values` | the single current value for a world-shared definition; every character in the world sees this value |
| `character_world_attribute_values` | the current value for one world, character, and attribute; values remain available when the character leaves and later returns to that world |
| `world_attribute_events` | append-only requested/applied delta, before/after value, source, explanation, and idempotency key |

The attribute key is immutable and an attribute is archived instead of deleted,
so old values and events remain auditable. The control plane may set an exact
in-range value. Characters have no direct attribute-mutation tool. Completed
normal private turns and completed World narrative turns may be analyzed only
when the owner enables analysis and supplies a direction rule. The model may
classify direction with exact visible evidence but cannot choose a number; the
service applies the separately configured fixed magnitude. The magnitude is a
step for each accepted match, not a per-turn maximum: for example, `increase=4`
requests exactly `+4`. Near the declared minimum or maximum, the applied delta
is clamped and can therefore be smaller; the event ledger keeps both requested
and applied deltas. Character-specific rules settle at most once per
character/key/source turn, while a world-shared rule settles at most once per
world/key/source turn even if several characters participated. Blank direction
rules disable that direction. Failed, cancelled, secret, and incognito turns
do not persist an automatic adjustment. Switching worlds changes both the
active shared set and character-specific set without overwriting values in the
previous world.

Migration 26 adds the canonical shared timeline, story-event transitions,
observer-scoped knowledge, and directional inter-character relationships. Its
storage contract is defined in `world-conversation-mode.md` rather than
duplicated here.

Migration 29 adds:

| Table or field | Ownership and purpose |
|---|---|
| `character_channels` | one persistent canonical channel for each world/character pair, with user-facing unread state |
| `character_channel_episodes` | idempotent social, collaboration, or contact execution with source, objective, result, failure, and model-call status |
| `character_channel_messages` | append-only character or system messages ordered within the channel |
| `character_autonomy_policies.social_*` | independent opt-in, local-day limit, cooldown, and last-exchange time for autonomous character social activity |

Character deletion cascades through its world state. Deleting a world requires
removing all memberships first. Moving or removing a character from a world
cancels its still-planned autonomous calendar items and marks old pending
proactive messages as skipped. Historical delivered messages and memories stay
auditable.

The character calendar is reused instead of introducing a second time system.
Autonomous activities use `ownerType=character`, never create reminders, and
never enter the user's notification outbox.

## 4. Place Capabilities

Places select from a built-in vocabulary:

`rest`, `work`, `study`, `socialize`, `eat`, `shop`, `exercise`, `travel`,
`create`, `observe`, `communicate`.

These IDs are data, not dynamically registered tools. `travel` is special: its
place is the destination, so that destination does not itself need to advertise
the `travel` capability. All other activities require the capability on the
selected place. A place cannot define a new schema, command, prompt, or
executable action. This keeps the provider tool
prefix stable and prevents world content from granting capabilities.

## 5. Coordinator Lifecycle

For each world member, one tick performs this order:

1. Reconcile cancelled or manually completed linked schedule items.
2. Project a currently active character schedule item into runtime state.
3. Settle due plans whose end time has passed and whose world still matches the membership.
4. If autonomy is enabled and the local day has not been planned, create a daily plan.
5. Deliver at most one eligible pending proactive message.
6. Refresh runtime state again.
7. Attempt at most one eligible autonomous character exchange per world.

Daily planning uses the model profile bound to that character. The call receives
a bounded SOUL excerpt, bounded world rules, compact place IDs/names/capability
IDs, current runtime and energy, home place, recent settled experiences, public
runtime for other world members, the active story event, and at most 20 existing
schedule entries. Output is strict JSON and is validated against these rules:

- zero to three activities, where an empty list is valid when no useful plan is needed;
- an existing place and one capability assigned to that place, except that travel targets any place in the same world;
- start at least five minutes in the future and within 30 hours;
- duration from 15 minutes to four hours;
- no overlap with existing or newly accepted activities;
- at least 30 minutes between different places unless the next item is travel;
- no work, study, exercise, or creation plan while energy is below 25;
- no travel whose destination is already the current place;
- bounded title, summary, and salience.

Planner time fields use the world's local wall clock, not UTC. The model receives
an authoritative `currentLocalDateTime` and returns offset-free `startLocal` and
`endLocal` values in `YYYY-MM-DDTHH:mm:ss` form. The Coordinator resolves those
values through the world's IANA timezone before persisting UTC schedule instants.
Values containing `Z`, a numeric offset, or a timezone name are rejected, as are
ambiguous or nonexistent daylight-saving clock readings. Existing schedule and
recent-event times are also presented to the planner in the same local clock so
the model never has to calculate timezone offsets.

Malformed, failed, unavailable, or entirely rejected model output creates no
schedule. The Coordinator no longer samples place capabilities to fabricate a
local fallback; an implausible empty day is less harmful than false continuity.
A valid model response may intentionally return zero plans. No raw model draft
becomes durable state. Planning is idempotent per membership/day/index; process
retry returns the same schedule item. The manual "安排今日" control forces a new
attempt, while the background daily checkpoint prevents repeated failed calls.

If a character is a participant in an open World story event, unrelated
offscreen planning is deferred. The event is the authoritative activity until
it closes; autonomy resumes from the resulting runtime and settlement state.

While travel is active, runtime remains at the origin with availability
`traveling`; the destination is persisted only when the interval ends. Other
activities project their place at start. When a planned activity ends, the
Coordinator persists its place, returns availability to `free`, creates one
idempotent world event, completes its character calendar item, and writes a confirmed character
`plot_event` memory when salience is at least `0.5`. This gives later sessions
durable continuity without preserving the planner prompt.

Runtime reads also perform a bounded catch-up projection. If the process was
asleep or a timer missed the active interval, the newest linked plan whose end
is newer than the stored runtime state advances the character to its final
place. This does not replay every missed minute and never overrides a newer
manual/meeting state.

Proactive delivery uses a deterministic candidate policy before the isolated
message model is called:

- the character policy enables proactive messages;
- the source event has salience of at least `0.45` and the resulting candidate score is at least `0.70`;
- the character has a canonical private SMS session, created lazily when the first proactive message is ready;
- the local time is outside quiet hours;
- the per-character local-day limit has not been reached;
- global and same-topic cooldowns have elapsed;
- the user has not spoken in the last ten minutes;
- the private inbox and model session are idle;
- proactive delivery is not paused and the topic is not reduced beyond its current cadence or muted;
- a configured character model can produce non-empty final text;
- the selected private session is not currently in confirmed physical co-presence with the user.

The score combines salience, timeliness, novelty, event source/type, and direct
topic feedback. Eligible records sort by score, event time, then stable ID. One
message model call is allowed per character tick. Same-topic duplicates are
superseded; lower-ranked candidates for other topics remain pending. Normal
topics have a minimum six-hour cadence. Reduced topics use 48 hours. The default
global cooldown is 120 minutes and is configurable between 15 and 1440 minutes.

Only the final first-person SMS is appended to Pi history. The call receives the
stable character context, latest bounded runtime/relationship/memory context,
the triggering event, and the last four visible messages with their actual send
times. A trusted temporal envelope also supplies current UTC/local time, the
last visible message time and role, exact elapsed seconds, and whether both
timestamps fall on the same world-local date. Relative-time wording must follow
that envelope instead of conversational tone. A deterministic guard rejects
clear contradictions such as referring to a conversation from five minutes ago
as "last night" and permits one corrected generation; the rejected draft is
never appended. It receives no tools. Failures retry after ten minutes using a
dedicated last-attempt timestamp and become `failed` after three attempts.
Disabling proactive delivery skips existing pending work so re-enabling it does
not unexpectedly send stale events.

Delivered-message feedback supports `helpful`, `less_often`, `mute_topic`, and
`pause_24h`. Feedback, topic policy, pause state, and pending-topic suppression
commit in one transaction. Users can restore a topic to normal or resume all
messages explicitly. Relationship state may shape final wording but does not
directly enqueue a message.

Confirmed co-presence temporarily owns the character runtime projection. The
Coordinator still settles due work and may plan future activities, but it does
not overwrite the meeting activity or deliver a proactive SMS. Ending the
meeting restores the compact pre-meeting runtime before normal schedule
projection resumes.

`POST /api/v1/characters/{id}/life/moment` is an explicit user-facing simulation
hook. It creates one valid event at the current/home/first place and immediately
attempts proactive delivery while still respecting the daily limit, global
pause, topic mute, co-presence, and active conversation ownership.

Autonomous character social activity is independent from daily schedule
planning and disabled by default. Both characters must enable it, be free,
remain outside quiet hours and cooldown, and not participate in an active World
story event. The initiator's local-day limit is between zero and five; the
default is one exchange with a four-hour cooldown. A tick creates at most one
exchange per world, so increasing the number of characters cannot create an
unbounded model-call burst.

One autonomous exchange has at most two actor calls: the initiator writes an
opening and the target independently replies or declines. Each actor uses its
own bound model profile and SOUL. The bounded input contains the world card,
trusted current time, both public runtime states, the directed relationship,
and the latest 16 messages from that pair channel. It never contains either
character's private user SMS transcript, user profile, private memory store,
tools, or model credentials.

A completed exchange creates a shared interaction event, one direct observation
and one character-bound RP memory for each participant, and small directional
relationship updates. Failed model calls create a visible channel status and an
audit action. A completed visible exchange remains completed if secondary
memory or relationship settlement fails; that failure is audited separately.

## 6. Context and Token Economics

The context contract is deliberately split:

| Section | Placement | Default budget | Update behavior |
|---|---|---:|---|
| `world_core` | stable system prefix, after SOUL | 900 estimated tokens | changes only when world/place revision changes |
| `world_runtime` | latest volatile turn context | 420 estimated tokens | replaced every turn; never accumulates in transcript history |

The service also applies hard projection ceilings of 4,800 and 2,000 Unicode
characters before Context Planner applies token budgets. Truncation preserves
the closing envelope. User-authored world/place text is XML-escaped and labeled
as quoted, untrusted data; it cannot forge context markers or permissions.

`world_core` includes world identity, compact place descriptions and capability
IDs, then as much world-rule Markdown as fits. `world_runtime` includes only the
current place/activity/availability/energy, visible world-defined attributes, optional expected end, the two
latest events, and at most three upcoming linked plans. Past runtime snapshots
are removed by the existing latest-only turn-context filter.

The `World State MCP` schema is loaded only when all conditions are true:

- mode is `sms`;
- a character is bound to the private session;
- the module is enabled;
- that character has a world membership.

It is not sent to unrelated SMS sessions or World actors. World actors receive a
bounded service projection without an MCP schema or tools. The UI estimate is
approximately 860 tokens per loaded private turn. Background MLX planning
and proactive calls explicitly disable thinking and use 1,200 and 640 output
tokens respectively; providers without the MLX control use conservative 2,400
and 1,200 fallbacks.

Character-channel actor calls also disable MLX thinking. They use 900 output
tokens with enforced thinking-off control or a 1,600-token fallback. Their
stable prefix is the actor SOUL plus world card; current runtime, relationship,
objective, and bounded pair history remain in the dynamic message.

## 7. MCP Contract

`mcp:world-state` is enabled by default but conditionally loaded. It exposes:

- `get_character_world_state`: read the bound character's runtime and recent events;
- `list_world_places`: read places and their fixed capabilities;
- `list_world_characters`: list same-world character identity and public runtime availability without private context;
- `send_character_message`: send one message through the persistent pair channel and wait for the target's own-model reply;
- `request_character_help`: delegate one bounded reasoning or planning task and return the target's result to the source Agent;
- `request_character_contact`: queue a bounded request for another same-world character to consider contacting the user;
- `perform_place_action`: record an action that happens now; travel means immediate arrival at its destination.

The MCP is character-bound by the application session. The model cannot submit
a different `characterId` or `worldId`. `perform_place_action` uses the Pi tool
call ID as its idempotency key, writes an audited action, and may create a
salient RP memory. It never creates a proactive message from the same foreground
turn.

`send_character_message` and `request_character_help` are synchronous, one-hop
character-to-character operations. The source Agent receives the actual target
result and can then answer the user without impersonating the target. The
target sees only the minimum task/message, shared public world state, directed
relationship, and persistent pair-channel history. It receives no tools and
cannot recursively delegate, browse, mutate files, contact the user, or claim
external work. Actor failures return a factual failed tool result instead of
causing the source Agent to invent a response or repeatedly retry the MCP.

Character channels are shown as indented two-avatar rows beneath their world in
the conversation sidebar. Opening one shows a read-only transcript and marks
its unread counter as read. These channels are durable across process restart
and included in export/delete-all and operational SQLite backup flows.

`request_character_contact` is available only from a character-bound SMS
thread. Source and target must be different characters in the same canonical
world, and the target must have proactive messages enabled. The source Agent
submits only a 500-character quoted request envelope; it cannot read the
target's SOUL, relationship, memory, model configuration, or private thread and
cannot write the target's final message. The request becomes one shared-world
interaction event with both characters as participants and one proactive
candidate owned by the target.

The target then uses its own bound model profile, SOUL, relationship, current
world runtime and canonical private-thread context to return an ordinary SMS or
an explicit `[DECLINE]` decision. Legacy JSON decisions remain accepted during
migration. A sent message is appended only to the target's private thread and
remains unread until that thread is opened. A decline is stored as
`character_declined` and creates no visible message. Quiet hours,
daily budget, pause, global/topic cooldown, recent activity, busy-thread and
co-presence gates continue to apply. Tool success means only that the request
was queued; the source character must never claim that the target replied.

Future location changes do not add another MCP schema. The existing Schedule
MCP accepts optional `placeId` and `capabilityId` only for
`calendar=character`. Both fields are required together. The server validates
the target before creation, uses trusted server now when a bound activity omits
its start time, supplies a bounded default end time when omitted (30 minutes
for travel, 60 minutes otherwise), and creates an idempotent
`character_activity_plans` link. Future movement must use this path rather than
calling `perform_place_action` early.

Immediate non-travel actions receive fixed short durations (15 to 90 minutes by
capability) so `busy` and `resting` cannot remain forever. Runtime projection
also clears legacy open-ended non-free states after two hours. Confirmed
co-presence remains exempt because interaction state owns that projection.

## 8. HTTP and Agent Test Interfaces

User control plane:

```text
GET    /api/v1/worlds
POST   /api/v1/worlds
GET    /api/v1/worlds/{id}
PATCH  /api/v1/worlds/{id}
DELETE /api/v1/worlds/{id}
POST   /api/v1/worlds/{id}/places
PATCH  /api/v1/world-places/{id}
DELETE /api/v1/world-places/{id}

GET    /api/v1/characters/{id}/life
PATCH  /api/v1/characters/{id}/life
POST   /api/v1/characters/{id}/life/plan
POST   /api/v1/characters/{id}/life/moment
POST   /api/v1/characters/{id}/life/proactive/resume
POST   /api/v1/characters/{id}/life/proactive-topics/{topicKey}/reset

POST   /api/v1/world-autonomy/tick
GET    /api/v1/proactive-messages
POST   /api/v1/proactive-messages/read
POST   /api/v1/proactive-messages/{id}/feedback

GET    /api/v1/character-channels
POST   /api/v1/character-channels/exchanges
GET    /api/v1/character-channels/{id}
POST   /api/v1/character-channels/{id}/read
```

Example character update:

```json
{
  "worldId": "world-id",
  "homePlaceId": "place-id",
  "currentPlaceId": "place-id",
  "policy": {
    "enabled": true,
    "proactiveEnabled": true,
    "socialEnabled": true,
    "dailyMessageLimit": 1,
    "socialDailyLimit": 1,
    "proactiveCooldownMinutes": 120,
    "socialCooldownMinutes": 240,
    "quietStart": "23:00",
    "quietEnd": "08:00"
  }
}
```

Use explicit `null` to leave a world or clear home/current place. Omitted fields
preserve existing state. Saving policy settings must not reset activity, energy,
or an active schedule projection.

Normal production clients can trigger a deterministic tick through
`POST /api/v1/world-autonomy/tick` with optional `characterId`. Test runs also
expose `POST /api/_test/v1/runs/{runId}/world/tick`. `TestRuntime` accepts
injected `worldPlanner` and `worldMessenger` functions and includes worlds and
character life snapshots in its canonical state. Tests must use a virtual clock;
they must not sleep for real timer intervals.

## 9. UI Trial Flow

1. Open **角色**, select a character, then open **生活**.
2. Open **管理世界**, create a world, and add at least one place with capabilities.
3. Bind the character to the world and save the home/current place.
4. Enable **自主安排日程** and optionally **允许主动发消息** or **允许自主角色私聊**.
5. Use **安排今日** to inspect generated entries in the character calendar.
6. Use **模拟生活片段** to verify runtime, event memory, and optional proactive SMS.
7. Open the character's private SMS conversation to send direct feedback, then
   inspect Debug > 主动决策 for score and deferral reasons. Provider Trace still
   exposes `world_planning`, `proactive_message`, `world_core`, and
   `world_runtime`. If no private conversation existed, successful proactive
   delivery creates it automatically.
8. To test cross-character relay, assign two characters to the same world,
   enable proactive messages for the target, and ask the current character to
   have the target contact you. The target thread uses the same completion-time
   unread counter as ordinary character replies. A red badge appears on the
   Characters section and target private thread only after the target actually
   sends, and remains until that visible, focused conversation is opened.
9. To test direct collaboration, ask one character to message or request help
   from another. The source Agent should call `send_character_message` or
   `request_character_help`, report the returned result, and create a two-avatar
   read-only channel beneath the shared world.
10. To test autonomous social activity, enable **允许自主角色私聊** on both
    characters, keep them free and outside quiet hours, and run a World tick.

## 10. Required Invariants and Tests

Automated coverage must preserve these rules:

- SMS receives canonical world context and tools; RP receives neither;
- dynamic runtime is latest-only and bounded, and stable world markers remain closed;
- world text cannot forge system/runtime envelopes;
- place actions reject unknown capabilities and cross-world place IDs;
- autonomous activities are character calendar events, never user reminders;
- linked travel remains at its origin while active, persists its destination at the end, and catches up after a missed timer window;
- immediate activities expire, and legacy open-ended non-free states recover;
- character Schedule MCP location fields create one linked world plan and reject partial/cross-world bindings;
- settlement creates one event and at most one memory across retries;
- score ranking, same-topic deduplication, quiet hours, recent-user/busy/co-presence gates, daily limits, pauses, cooldowns, retries, and attempt limits are deterministic;
- feedback atomically updates topic policy and can reset or resume without resurrecting stale candidates;
- contact requests reject self/cross-world targets, preserve quoted request metadata across ranking, and use the target model binding;
- a target decline creates no transcript message, while a send enters only the target thread and remains unread until opened;
- character channels reject self/cross-world pairs, persist idempotent episodes, and serialize concurrent work per pair;
- each channel actor uses its own model/SOUL and receives no private user-thread transcript or tools;
- autonomous social activity requires both opt-ins and obeys availability, story-event, quiet-hour, local-day, and cooldown gates;
- completed channel exchanges settle only character-bound observations, memories, and directional relationships;
- same-world setting updates preserve runtime state;
- switching worlds cancels old plans and pending proactive work;
- module disable removes tools and both context sections;
- schemas 19, 25, 26, 29, and 30 survive backup/restore and delete-all;
- desktop and mobile browser workflows can create, bind, plan, and simulate.

The focused suites are `test/world-autonomy.test.ts` and
`test/character-contact.test.ts`, plus `test/character-channel.test.ts`; the full
browser workflow is `test/browser.mjs`.

## 11. Deferred Extensions

The following are not part of this MVP:

- autonomous World turns without a user or trusted scheduled trigger;
- travel graphs, duration, economy, inventory, or location-specific custom code;
- weather or external real-world feeds;
- a dedicated low-cost planner/message model profile;
- user-editable event correction and replay UI;
- simulation of every missed minute during long downtime.

Any future autonomous trigger must reuse one canonical event, write separate
observer-scoped character memories, and inject only the current character's
perspective. It must not create long-running per-character agents or copy all
world history into every prompt.

## 12. Implementation Map

- `src/world/types.ts`: fixed vocabulary and domain contracts
- `src/world/repository.ts`: schema-19 persistence
- `src/world/service.ts`: validation, assignment, actions, context projection
- `src/world/coordinator.ts`: planning, settlement, memory, proactive delivery
- `src/world/proactive-policy.ts`: deterministic topic, scoring, gating, cooldown and ranking policy
- `src/world/conversation-repository.ts`: schema-26 World timeline persistence
- `src/world/conversation-service.ts`: events, observations, relationships, and unread state
- `src/world/conversation-prompts.ts`: World narrative and Analyzer output contracts
- `src/world/character-channel-repository.ts`: schema-29 pair channels, episodes, messages, and unread state
- `src/world/character-channel-service.ts`: same-world validation and persistent channel operations
- `src/world/character-interaction-coordinator.ts`: one-hop messaging, collaboration, autonomous social gating, and settlement
- `src/organization/`: schema-31 automatic profiles, one versioned Skill per character, evidence, and trusted task routing
- `src/mcp/world-server.ts`: fixed character-bound MCP
- `src/context/planner.ts`: stable/dynamic placement and budgets
- `src/domain/kernel.ts`: model calls, lifecycle wiring, public control plane
- `src/http/router.ts`: production and test HTTP routes
- `src/http/ui.ts`: character Life tab, world manager, and Worlds/Characters chat hierarchy
