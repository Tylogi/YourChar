# World Conversation Mode

Status: implemented baseline
Audience: product, application, model, storage, and test maintainers
Last updated: 2026-07-20

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
conversation is not a renamed group chat: it has a world-level Director and
Analyzer, a durable event lifecycle, and observer-scoped state.

The sidebar has two top-level sections:

- **Worlds**: one row per active world, shown with a member-avatar mosaic;
- **Characters**: one row per canonical private chat, shown with the character
  avatar.

World rows are not archivable or batch-deletable as conversations. Their
lifecycle follows the owning world. Batch chat operations apply only to private
threads.

## 2. Identity And Model Binding

Model selection is intentionally split by responsibility:

| Responsibility | Binding |
|---|---|
| World Director | `role_worlds.director_model_profile_id`, then default profile |
| Character actor | the character's `modelProfileId`, then default profile |
| Post-turn Analyzer | `role_worlds.analyst_model_profile_id`, then Director profile, then default profile |

The Director never writes character dialogue or private thoughts. Each actor
call controls exactly one character and receives that character's SOUL.md and
memory. The Analyzer never writes user-visible prose. It proposes bounded state
changes after visible output has been generated.

Deleting a model profile clears world and character bindings through the model
profile service. A bound but disabled profile remains unavailable by intent;
that failure is isolated to the corresponding stage.

## 3. Turn Pipeline

One user submission creates one durable World turn:

1. Persist the user message and attachments before any model call.
2. Call the Director with trusted world/roster/place/event state and a bounded
   visible timeline.
3. Validate its strict JSON plan: optional place, optional environment-only
   opening narration, and an ordered set of character cues.
4. Call at most six selected actors serially. Persist each valid contribution
   before calling the next actor, so later actors can observe earlier output.
5. If any visible output exists, call the Analyzer once.
6. Apply only Analyzer changes that pass deterministic ID, range, evidence, and
   confidence gates.
7. Finish the turn as `completed`, `partial`, `failed`, or `cancelled` and update
   unread state.

The current baseline allows one contribution per selected actor in a user turn.
Repeated autonomous passes and unbounded character loops are not allowed.

When the Director is unavailable or invalid, a deterministic fallback selects
explicitly mentioned characters, active-event participants, co-located
characters, then other members, capped at three. An unavailable actor is marked
failed and does not block other actors. Analyzer failure preserves all visible
messages and marks the turn partial; it never rolls back character output.

SSE lifecycle events are:

- `director_state`: planning or failed;
- `participant_state`: typing, silent, or failed for one character;
- `message`: persisted Director narration or character output;
- `analysis_state`: analyzing, applied, or failed;
- `turn_done` and `done`.

Director planning, silent candidates, and analysis stay in status chrome. A
typing bubble appears only after a selected character actually enters its actor
call.

## 4. Context Contract

### Director

The Director receives:

- world ID, name, timezone, description, and Markdown rules;
- valid places and fixed capability IDs;
- member IDs, names, public runtime location/activity/availability;
- the current open story event;
- the latest visible World timeline, capped at 60 messages and approximately
  20,000 serialized characters;
- metadata for the current user attachments.

It receives no MCP, shell, workspace, schedule, private relationship, private
memory, User Profile write, or SOUL write capability.

### Character actor

Each actor receives:

- the actor-only control policy;
- the selected character's complete bounded SOUL.md;
- the manual User Profile section when User Profile MCP is enabled;
- relevant confirmed reality and character memory when Memory Coordinator is
  enabled;
- the character's user relationship state when Relationship State MCP is
  enabled;
- stable world rules, current runtime, relevant observations, the current event,
  and character-to-character relationship summaries;
- the Director cue and visible timeline including earlier output from this turn.

Actor calls have no tools. They cannot schedule, browse, edit files, mutate
profiles, or claim an external action completed. The context planner currently
uses the internal `rp` realm key for character-memory compatibility. That key is
not a user-visible conversation mode and must not recreate standalone RP
sessions.

### Analyzer

The Analyzer receives trusted pre-turn world state, the validated Director plan,
the user input, and generated visible messages. Its JSON output is parsed into:

- event lifecycle decision;
- character runtime updates;
- observer-scoped observations;
- directional character-to-character relationship deltas.

No hidden chain-of-thought is persisted. Provider payloads are visible in Debug
as `world_director`, `world_actor`, and `world_analysis` traces.

## 5. State And Memory Rules

Only one `planned` or `active` story event may exist per world. Legal decisions
are `propose`, `begin`, `resolve`, `cancel`, and user-control `undo`. Every
applied transition stores before/after state and revision provenance.

Analyzer application thresholds are part of the trusted policy:

- event change confidence: at least `0.70`;
- runtime update confidence: at least `0.75`;
- stored observation salience: at least `0.35`;
- character relationship delta confidence: at least `0.70`;
- proposed long-term observation memory: `remember=true`, salience at least
  `0.65`, Memory Coordinator enabled, and Character Memory Write enabled.

Observations are character-scoped as `direct`, `heard`, or `inferred`. A fact is
never copied to every world member merely because it appeared in the shared
timeline. Character-to-character relationships are directional and independent
from each character's relationship with the user.

World state is fictional. It cannot directly mutate user schedules, reminders,
files, credentials, permissions, or the reality-memory realm.

## 6. Persistence

SQLite migration 26 adds:

| Table | Purpose |
|---|---|
| `world_conversations` | one timeline identity, read state, and timestamps per world |
| `world_conversation_turns` | aggregate turn status and model-call counts |
| `world_conversation_messages` | ordered user, Director, character, and system messages |
| `world_story_events` | current and historical event state |
| `world_story_event_participants` | explicit event membership |
| `world_story_event_transitions` | revisioned event provenance and undo |
| `world_character_observations` | observer-scoped knowledge |
| `world_character_relationships` | directional inter-character state |

World messages are application-owned SQLite records, not Pi JSONL sessions.
Private character chats remain Pi-owned canonical sessions. Deleting a world
cascades its World timeline and derived state. User attachments remain files in
the confined Workspace and are referenced by validated relative metadata.

## 7. Unread Semantics

A World turn increments unread once when it finishes with any Director or
character output. User-only and fully failed turns do not increment unread.
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
| `GET` | `/api/v1/worlds/{id}/conversation/messages` | read ordered visible messages |
| `POST` | `/api/v1/worlds/{id}/conversation/messages` | deterministic JSON turn endpoint |
| `POST` | `/api/v1/worlds/{id}/conversation/messages/stream` | SSE turn endpoint |
| `POST` | `/api/v1/worlds/{id}/conversation/read` | acknowledge World unread state |
| `POST` | `/api/v1/worlds/{id}/conversation/event` | trusted event transition or undo |

World create/update accepts optional `directorModelProfileId` and
`analystModelProfileId`. Sending requires at least one current world member and
either non-empty text or a validated attachment.

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
- Director, actor, and Analyzer calls use their respective model bindings;
- each actor receives only its own SOUL and sees prior same-turn output;
- actor tools remain empty and malformed IDs/deltas are rejected;
- partial actor/Analyzer failures preserve already persisted output;
- event transitions, observation scope, relationship direction, and unread
  acknowledgement survive restart;
- migration deletes legacy group rows and startup purges legacy RP sessions;
- backup, export, and delete-all include all schema-26 tables;
- Debug uses the three World trace labels;
- desktop, compact, and mobile browser workflows show the Worlds/Characters
  hierarchy without overlap, keep World rows out of batch mutation, and render
  member-avatar mosaics and event details.

Focused coverage is in `test/world-conversation.test.ts`,
`test/canonical-private-session.test.ts`, `test/http-ui.test.ts`, and
`test/browser.mjs`.

## 11. Implementation Map

- `src/world/conversation-repository.ts`: schema-26 persistence
- `src/world/conversation-service.ts`: timeline, event, observation, relation, and unread policy
- `src/world/conversation-prompts.ts`: strict Director, actor, and Analyzer contracts
- `src/domain/kernel.ts`: serial model orchestration and trusted analysis application
- `src/http/router.ts`: JSON and SSE APIs
- `src/http/ui.ts`: Worlds/Characters sidebar and World timeline UI
- `src/pi/session-runtime.ts`: retired RP cleanup and canonical private migration
