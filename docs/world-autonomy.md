# Shared World and Character Autonomy

Status: implemented MVP / trial baseline
Audience: maintainers, coding agents, reviewers, and test agents
Last updated: 2026-07-19

## 1. Product Contract

This feature gives characters a small canonical life outside the current chat:

- multiple characters may belong to one shared fictional world;
- a world contains user-managed places with fixed functional capabilities;
- each character has a home, current place, activity, availability, energy, and autonomy policy;
- the background Coordinator may create character calendar events, settle completed activities into world events and RP memories, and send a bounded proactive SMS;
- the Agent can inspect and mutate its own fictional state through a fixed MCP.

The canonical world is available only in private `sms` conversations. `rp`
sessions remain independent scenes and do not read or write this state. This is
intentional: SMS represents the character speaking in first person from an
ongoing life, while RP may stage an unrelated third-person story. A future
explicit scene-to-world link must be opt-in and must not silently change this
boundary.

World actions are fictional. They cannot mutate the user's schedule, reminders,
files, profile, permissions, or real-world state.

## 2. Architecture

```text
Character UI / HTTP API
        |
    WorldService -------------------- World State MCP
        |                                   |
    WorldRepository                    private SMS Pi session
        |
 SQLite schema 19
        |
 WorldAutonomyCoordinator (60 s tick)
        |             |                 |
 character calendar  RP plot memory    proactive SMS queue
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
| `character_autonomy_policies` | enable flags, daily message limit, quiet hours, planning checkpoint |
| `character_runtime_states` | current place, activity, availability, energy, expected end |
| `character_activity_plans` | link from an autonomous or foreground-Agent world plan to a character schedule item |
| `world_events` | settled or explicit fictional events with idempotency keys |
| `world_event_participants` | character participants; supports future shared encounters |
| `proactive_messages` | durable pending/delivered/skipped/failed delivery queue |

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

Daily planning uses the model profile bound to that character. The call receives
a bounded SOUL excerpt, bounded world rules, compact place IDs/names/capability
IDs, current runtime, and at most 20 existing schedule entries. Output is strict
JSON and is validated against these rules:

- zero to four activities;
- an existing place and one capability assigned to that place, except that travel targets any place in the same world;
- start at least five minutes in the future and within 30 hours;
- duration from 15 minutes to four hours;
- bounded title, summary, and salience.

Malformed, failed, empty, or unavailable model output uses a deterministic local
fallback. No raw model draft becomes durable state. Planning is idempotent per
membership/day/index; process retry returns the same schedule item.

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

Proactive delivery additionally requires:

- the character policy enables proactive messages;
- event salience is at least `0.65`;
- the character has a canonical private SMS session, created lazily when the first proactive message is ready;
- the local time is outside quiet hours;
- the per-character local-day limit has not been reached;
- a configured character model can produce non-empty final text.
- the selected private session is not currently in confirmed physical co-presence with the user.

Only the final first-person SMS is appended to Pi history. The call receives the
stable character context, latest bounded runtime/relationship/memory context,
the triggering event, and the last four visible messages. It receives no tools.
Failures retry after ten minutes and become `failed` after three attempts.
Disabling proactive delivery skips existing pending work so re-enabling it does
not unexpectedly send stale events.

Confirmed co-presence temporarily owns the character runtime projection. The
Coordinator still settles due work and may plan future activities, but it does
not overwrite the meeting activity or deliver a proactive SMS. Ending the
meeting restores the compact pre-meeting runtime before normal schedule
projection resumes.

`POST /api/v1/characters/{id}/life/moment` is an explicit user-facing simulation
hook. It creates one valid event at the current/home/first place and immediately
attempts proactive delivery while still respecting the daily limit.

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
current place/activity/availability/energy, optional expected end, the two
latest events, and at most three upcoming linked plans. Past runtime snapshots
are removed by the existing latest-only turn-context filter.

The `World State MCP` schema is loaded only when all conditions are true:

- mode is `sms`;
- a character is bound to the private session;
- the module is enabled;
- that character has a world membership.

It is not sent to unrelated SMS sessions, RP sessions, or group actors. The UI
estimate is approximately 420 tokens per loaded turn. Background MLX planning
and proactive calls explicitly disable thinking and use 1,200 and 640 output
tokens respectively; providers without the MLX control use conservative 2,400
and 1,200 fallbacks.

## 7. MCP Contract

`mcp:world-state` is enabled by default but conditionally loaded. It exposes:

- `get_character_world_state`: read the bound character's runtime and recent events;
- `list_world_places`: read places and their fixed capabilities;
- `perform_place_action`: record an action that happens now; travel means immediate arrival at its destination.

The MCP is character-bound by the application session. The model cannot submit
a different `characterId` or `worldId`. `perform_place_action` uses the Pi tool
call ID as its idempotency key, writes an audited action, and may create a
salient RP memory. It never creates a proactive message from the same foreground
turn.

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

POST   /api/v1/world-autonomy/tick
GET    /api/v1/proactive-messages
POST   /api/v1/proactive-messages/read
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
    "dailyMessageLimit": 1,
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
4. Enable **自主安排日程** and optionally **允许主动发消息**.
5. Use **安排今日** to inspect generated entries in the character calendar.
6. Use **模拟生活片段** to verify runtime, event memory, and optional proactive SMS.
7. Open the character's private SMS conversation and inspect Debug Trace for
   `world_planning`, `proactive_message`, `world_core`, and `world_runtime`
   records. If no private conversation existed, successful proactive delivery
   creates it automatically.

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
- quiet hours, daily limits, retry cooldown, and attempt limits are deterministic;
- same-world setting updates preserve runtime state;
- switching worlds cancels old plans and pending proactive work;
- module disable removes tools and both context sections;
- schema 19 survives backup/restore and delete-all;
- desktop and mobile browser workflows can create, bind, plan, and simulate.

The focused suite is `test/world-autonomy.test.ts`; the full browser workflow is
`test/browser.mjs`.

## 11. Deferred Extensions

The following are not part of this MVP:

- autonomous multi-character encounter synthesis;
- travel graphs, duration, economy, inventory, or location-specific custom code;
- character-to-character proactive messages;
- a canonical-world link for selected RP scenes;
- weather or external real-world feeds;
- a dedicated low-cost planner/message model profile;
- user-editable event correction and replay UI;
- simulation of every missed minute during long downtime.

`world_event_participants` and shared world IDs are intentionally present so a
later encounter Coordinator can add one event with per-character perspectives.
That extension must keep one canonical event, write separate character memories,
and inject only the current character's perspective. It must not create
long-running per-character agents or copy all world history into every prompt.

## 12. Implementation Map

- `src/world/types.ts`: fixed vocabulary and domain contracts
- `src/world/repository.ts`: schema-19 persistence
- `src/world/service.ts`: validation, assignment, actions, context projection
- `src/world/coordinator.ts`: planning, settlement, memory, proactive delivery
- `src/mcp/world-server.ts`: fixed character-bound MCP
- `src/context/planner.ts`: stable/dynamic placement and budgets
- `src/domain/kernel.ts`: model calls, lifecycle wiring, public control plane
- `src/http/router.ts`: production and test HTTP routes
- `src/http/ui.ts`: character Life tab and world manager
