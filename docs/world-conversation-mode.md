# World Conversation Mode

Status: implemented event-driven baseline
Audience: product, application, model, storage, and test maintainers
Last updated: 2026-07-21

## 1. Product Boundary

The chat product has two visible conversation kinds:

1. **Character private chat**: exactly one canonical SMS thread per character.
   Remote messages are first person. A confirmed meeting temporarily widens the
   same thread into observable third-person narration without creating another
   session.
2. **World conversation**: exactly one shared timeline per world. It is a
   third-person multi-character roleplay surface backed by canonical world
   state, events, places, observations, and character-to-character relations.

Standalone RP sessions and ad hoc group chats are retired. The UI must not offer
either kind, and they are not migration sources for World conversations. A World
conversation is not a renamed group chat: one world-level model performs the
entire visible simulation, a background Analyzer maintains state, and the
timeline has a durable event lifecycle with observer-scoped knowledge.

The sidebar has two top-level sections:

- **Worlds**: one row per active world, shown with a member-avatar mosaic;
- **Characters**: one row per canonical private chat, shown with the character
  avatar.

World rows are not archivable or batch-deletable as conversations. Their
lifecycle follows the owning world. Batch chat operations apply only to private
threads.

World Cards are first-class objects in the Character and World management page,
below Character Cards. A World Card owns rules, places, narrative/Analyzer model
bindings, membership projection, and the current event. Character management
only binds a character to a World Card and configures that character's private
runtime/autonomy policy; it does not own world configuration.

## 2. Identity And Model Binding

Model selection is intentionally split by responsibility:

| Responsibility | Binding |
|---|---|
| World narrative | `role_worlds.director_model_profile_id`, then default profile |
| Post-turn Analyzer | `role_worlds.analyst_model_profile_id`, then World narrative profile, then default profile |
| Character private chat | the character's `modelProfileId`, then default profile |

`director_model_profile_id` remains the storage/API field for compatibility,
but the product label is **World narrative model**. It generates one complete
third-person passage, including the environment and all plausible character
actions and dialogue. Character-bound models are never invoked by a World turn;
they are reserved for private chats. The Analyzer never writes user-visible
prose. It proposes bounded state changes after visible output has been generated.

Deleting a model profile clears world and character bindings through the model
profile service. A bound but disabled profile remains unavailable by intent;
that failure is isolated to the corresponding stage.

## 3. Turn Pipeline

One user submission creates one durable World turn:

1. Persist the user message and attachments before any model call.
2. Reuse the active event's immutable narrative System snapshot and append one
   compact trusted turn-data/User message to its internal prompt ledger.
3. Call the World narrative model with the exact prior User/World message prefix.
   The model returns the complete user-visible prose directly.
4. Validate and persist that prose as one message sent by the World and append
   the exact assistant message to the event-local prompt ledger.
5. If visible output exists, call the Analyzer once.
6. Apply only Analyzer changes that pass deterministic ID, range, evidence, and
   confidence gates.
7. Finish the turn as `completed`, `partial`, `failed`, or `cancelled` and update
   unread state.

There is no actor loop and no deterministic prose fallback. If the World model
is unavailable or returns invalid/internal output, the turn fails rather than
silently substituting a character model. Analyzer failure preserves the World
passage and marks the turn partial; it never rolls back visible output.

SSE lifecycle events are:

- `director_state`: planning, writing, or failed;
- `message`: the persisted World passage;
- `analysis_state`: analyzing, applied, or failed;
- `turn_done` and `done`.

Planning and analysis stay in status chrome. Storage retains legacy character
sender support for old rows, but new World turns write exactly one `director`
message, rendered with the World Card's name in one continuous, unframed
third-person fiction block.

## 4. Context Contract

### World narrative model

The first request in a narrative context receives one fixed System prefix:

- world ID, name, timezone, description, and Markdown rules;
- valid places and fixed capability IDs;
- selected participant IDs, names, bounded SOUL.md excerpts, schedules,
  relevant confirmed memories, observer-scoped knowledge, and relationship
  state;
- the bounded User Profile when its module is enabled;
- the event state at snapshot time, a bounded Chronicle, and at most 16 prior
  visible messages used as the event/checkpoint handoff.

The fixed System string is stored once and is not rebuilt as clock, runtime,
schedule, or relationship state changes. Every turn appends one User message
containing:

- a canonical latest local timestamp containing date, weekday, clock time, and
  period such as `上午`; UTC is included only as provenance;
- the latest open-event summary and selected participants' compact runtime;
- full snapshots only for characters newly joining the active narrative;
- attachment metadata and the literal User input in separately delimited blocks.

Successful assistant messages are then appended unchanged. Consequently request
N+1 starts with the exact System/User/Assistant prefix sent in request N; only
the tail is new. The provider can reuse KV cache without losing genuine
multi-turn story continuity. Current turn-data blocks are trusted control data,
not User speech, and the latest block overrides stale runtime values in the
fixed snapshot.

A narrative context begins with an event, or with the opening beat that the
Analyzer subsequently binds to a new event. It closes when the event resolves,
is cancelled/replaced, the narrative model binding changes, or a context
checkpoint is required. Before a request, the planner includes the pending turn
in its estimate. At 32,000 input tokens, or earlier when the configured model
window requires it, it closes the old ledger and creates a fresh snapshot with a
bounded visible-timeline handoff. This is a deliberate cache break, not repeated
rolling-summary rewriting.

The local timestamp is authoritative for daylight, greetings, routines, and
ambience. The World model has no MCP, shell, workspace, schedule mutation,
profile-write, or SOUL-write capability. Schedules and memories are read-only
state snapshots, not permissions.

### Analyzer

The Analyzer receives trusted pre-turn world state, the user input, and the
generated World passage. Its JSON output is parsed into:

- event lifecycle decision;
- character runtime updates;
- observer-scoped observations;
- directional character-to-character relationship deltas.

World narrative reasoning blocks may be replayed only inside the active
event-local prompt ledger when the provider emits them; they are not visible
story canon. The ledger is purged when its event/checkpoint context closes.
Analyzer reasoning is neither required nor added to the narrative ledger.
Provider request payloads are visible in Debug as `world_director` (shown as
World narrative) and `world_analysis` traces.

## 5. State And Memory Rules

Only one `planned` or `active` story event may exist per world. Legal decisions
are `propose`, `begin`, `advance`, `resolve`, `cancel`, and user-control `undo`.
`advance` updates the rolling summary, objective, place, or participants without
changing open status. Every applied transition stores before/after state and
revision provenance.

Analyzer application thresholds are part of the trusted policy:

- event change confidence: at least `0.70`;
- runtime update confidence: at least `0.75`;
- stored observation salience: at least `0.35`;
- character relationship delta confidence: at least `0.70`;
- observations remain provisional while the event is open;
- only observations attached to the current open event enter fixed character perspective context;
- on `resolve` or `cancel`, the event receives one durable settlement checkpoint;
- each participant or observer receives one character-scoped `plot_event`
record containing only that character's observations when Memory Coordinator
and Character Memory Write are enabled.

After closure, raw observations leave the fixed character perspective context. The bounded World
Chronicle carries the shared outcome, while observer-specific settlement memory
is retrieved only when relevant to a later turn.

Observations are character-scoped as `direct`, `heard`, or `inferred`. A fact is
never copied to every world member merely because it appeared in the shared
timeline. Character-to-character relationships are directional and independent
from each character's relationship with the user.

World state is fictional. It cannot directly mutate user schedules, reminders,
files, credentials, permissions, or the reality-memory realm.

Closing an event releases a still-`busy` participant at the event place when the
Analyzer supplied no more specific runtime update. This prevents completed
events from leaving character runtime permanently stuck. Explicit travel,
resting, or Analyzer updates are preserved.

## 6. Persistence

SQLite migration 26 adds:

| Table | Purpose |
|---|---|
| `world_conversations` | one timeline identity, read state, and timestamps per world |
| `world_conversation_turns` | aggregate turn status and model-call counts |
| `world_conversation_messages` | ordered user and World messages, with legacy character/system sender support |
| `world_story_events` | current and historical event state |
| `world_story_event_participants` | explicit event membership |
| `world_story_event_transitions` | revisioned event provenance and undo |
| `world_character_observations` | observer-scoped knowledge |
| `world_character_relationships` | directional inter-character state |

World messages are application-owned SQLite records, not Pi JSONL sessions.
Private character chats remain Pi-owned canonical sessions. Deleting a world
cascades its World timeline and derived state. User attachments remain files in
the confined Workspace and are referenced by validated relative metadata.

SQLite migration 27 adds event settlement text/time, enables the `advance`
transition, and adds an event/observer lookup index used by settlement. Recent
settled summaries form a bounded World Chronicle injected as durable event
checkpoints; raw historical observations are not copied into every character.

SQLite migration 28 adds:

| Table | Purpose |
|---|---|
| `world_narrative_contexts` | one fixed System snapshot, model/cache identity, participant set, and lifecycle per active world event/checkpoint |
| `world_narrative_prompt_messages` | exact append-only User/assistant provider messages for the active narrative context |

Migration 28 also permits `world_director` records in `context_economics`.
Closed context metadata remains auditable, while its private prompt ledger is
deleted. Visible World messages, event settlements, and Chronicle checkpoints
remain durable. A full SQLite backup contains an active ledger; normal user-data
export exposes only its safe identity/hash/count summary, not private reasoning.

## 7. Unread Semantics

A World turn increments unread once when it finishes with World output.
User-only and fully failed turns do not increment unread.
Opening the exact World timeline acknowledges it only while the chat page is
visible and focused. The row and the Worlds section show the aggregate red
count. Actor count and message count do not multiply the unread increment.

Private-chat unread behavior remains independent and is aggregated under the
Characters section.

## 8. HTTP Contract

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/world-conversations` | list one enriched timeline per active world |
| `GET` | `/api/v1/worlds/{id}/conversation` | read event, member, and relationship state |
| `DELETE` | `/api/v1/worlds/{id}/conversation` | reset the canonical timeline after exact World-name confirmation |
| `GET` | `/api/v1/worlds/{id}/conversation/messages` | read ordered visible messages |
| `POST` | `/api/v1/worlds/{id}/conversation/messages` | deterministic JSON turn endpoint |
| `POST` | `/api/v1/worlds/{id}/conversation/messages/stream` | SSE turn endpoint |
| `POST` | `/api/v1/worlds/{id}/conversation/read` | acknowledge World unread state |
| `POST` | `/api/v1/worlds/{id}/conversation/event` | trusted event transition or undo |

World create/update accepts optional `directorModelProfileId` and
`analystModelProfileId`. Sending requires at least one current world member and
either non-empty text or a validated attachment.

Reset does not create a second timeline identity. It waits for the World's turn
queue, then recreates the one canonical conversation with a fresh timestamp. It
deletes visible messages and turns, every event-local narrative context/prompt
ledger, bounded Debug traces/economics owned by those model sessions, and the
current unfinished event with its provisional observations. Participants left
busy only by that event are released. World Cards, places, memberships,
schedules, character runtime unrelated to the event, directional relationships,
completed-event Chronicle, settled character memories, and optional append-only
Trace archive files remain intact. The UI exposes this as **Reset World
conversation** in the active World's conversation-actions menu and requires the
exact World name.

## 9. Retirement And Upgrade Policy

This release intentionally performs no RP/group transcript migration:

- migration 26 deletes all legacy `group_chats`; foreign-key cascades remove
  their members, turns, messages, and decisions;
- startup discards every legacy application conversation whose mode is `rp`;
- a retired RP Pi JSONL file is removed only after path confinement confirms it
  is inside the configured Pi session directory;
- RP scene/session rows, pending real mutations, extraction jobs, context
  economics, resident context, traces, and summaries tied to that session are
  removed;
- confirmed character memories are not rewritten or copied into a World
  timeline;
- no old transcript is merged into a World conversation.

Canonical SMS migration is separate: retain only the most recent private thread
per character and archive older SMS sessions without transcript merging.

Legacy group domain code and routes may remain temporarily for source
compatibility, but no visible UI may call them and release tests must seed no new
group records. New development targets the World contract only.

## 10. Required Tests

Changes must preserve:

- exactly one visible private thread per character and one World timeline per
  world;
- a World turn calls only the World narrative and Analyzer bindings and never a
  character-bound model;
- the World request contains an explicit canonical local date/time/period plus
  bounded character state, schedules, and event context;
- malformed Analyzer IDs/deltas are rejected;
- Analyzer failures preserve already persisted World output;
- event transitions, observation scope, relationship direction, and unread
  acknowledgement survive restart;
- open-event observations do not become long-term memory before closure, while
  closure creates idempotent per-character settlement records;
- migration deletes legacy group rows and startup purges legacy RP sessions;
- an event's second and later narrative requests preserve the exact prior
  provider message prefix across process restart;
- event/model/checkpoint transitions close the old narrative context and purge
  its private prompt ledger;
- reset rejects an incorrect confirmation without mutation, waits for an active
  turn, preserves settled continuity, and leaves one empty canonical timeline;
- Context Economics reports stable-prefix hash, longest common prefix, projected
  reuse ratio, provider cache usage, and an explicit cache-break reason;
- backup, export, and delete-all accept database schema 28;
- Debug uses the two active World trace labels;
- desktop, compact, and mobile browser workflows show the Worlds/Characters
  hierarchy without overlap, keep World rows out of batch mutation, and render
  member-avatar mosaics and event details.

Focused coverage is in `test/world-conversation.test.ts`,
`test/canonical-private-session.test.ts`, `test/http-ui.test.ts`, and
`test/browser.mjs`.

## 11. Implementation Map

- `src/world/conversation-repository.ts`: schema-26/27/28 persistence
- `src/world/conversation-service.ts`: timeline, event, observation, relation, and unread policy
- `src/world/conversation-prompts.ts`: strict World narrative and Analyzer contracts
- `src/domain/kernel.ts`: serial model orchestration and trusted analysis application
- `src/http/router.ts`: JSON and SSE APIs
- `src/http/ui.ts`: Worlds/Characters sidebar and World timeline UI
- `src/pi/session-runtime.ts`: retired RP cleanup and canonical private migration
