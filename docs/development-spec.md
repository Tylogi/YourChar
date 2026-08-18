# YourChar Product and Development Specification

Long-conversation lifecycle and compaction behavior are specified in
[`conversation-sleep-lifecycle.md`](./conversation-sleep-lifecycle.md).
Shared fictional worlds, character autonomy, and proactive character messages
are specified in [`world-autonomy.md`](./world-autonomy.md).
Canonical multi-character World timelines and retired RP/group migration are
specified in [`world-conversation-mode.md`](./world-conversation-mode.md).
Private SMS meeting state and in-person narrative transitions are specified in
[`interaction-state.md`](./interaction-state.md).
Character specialization, trusted same-world task routing, one versioned
character-owned Skill, and gated Skill improvement are specified in
[`character-organization-v2.md`](./character-organization-v2.md).

Status: Approved development baseline
Audience: maintainers, coding agents, reviewers, and test agents
Last updated: 2026-07-24

Implementation status: M0-M11 and the M13 baseline are implemented; M12 remains
an incremental experience-quality program. Scheduling uses SQLite,
occurrences, an outbox scheduler, quiet hours, in-app history, an opt-in
`notify-send` adapter, and deterministic test controls. The current workstation
does not provide `notify-send`, so desktop delivery still requires the host
package and notification daemon before the M2 operational exit check can be
performed. RP continuity now includes persistent characters, role sessions,
per-character SOUL.md files, scenes, typed memories, retrieval context,
correction/deletion, and confirmed
real-world mutation policy. M4 adds SSE streaming, cancellation, guarded retry,
model diagnostics, export/deletion, persistent bounded audit summaries,
CloakBrowser regression tests, and managed-service/backup operations.
M5 routes model-driven schedule operations through an MCP server/client boundary
and resumes the source Pi conversation to compose proactive due reminders.
M6 adds runtime MCP/Skill controls and a switchable User Profile MCP backed by
one user-editable Markdown document of at most 2000 Unicode characters.
M7 adds a dedicated Agent workspace, path-confined file tools, an OS-isolated
Bubblewrap shell with independent network authorization, and separate Agent-edit
permissions for User Profile and character SOUL Markdown.
M8 adds optional live web search through a local Tavily MCP, a protected Key
settings flow, source-preserving results, metered-tool policy, and deterministic
fake-upstream tests.
M9 adds shared fictional worlds, fixed-capability places, character runtime
state, autonomous character calendar planning, event-to-memory settlement,
bounded proactive SMS delivery, a conditional World State MCP, and deterministic
world test controls. Schema 26 extends that state into one canonical World
timeline; current World turns use one World narrative call plus one post-turn
Analyzer call and never route visible prose through character-bound models;
schema 27 adds rolling event advances and event-end observer settlement. Schema
28 gives each active World event/checkpoint an immutable System snapshot and an
append-only provider-message ledger, so later turns preserve an exact cacheable
prefix across process restarts. A projected 32k soft limit creates a bounded
visible-timeline checkpoint instead of repeatedly rewriting a rolling summary.
M10 adds durable private-conversation interaction state. Canonical SMS can move
from remote messages through a planned meeting into a confirmed observable
scene without changing conversation mode. Future plans use the pending state;
semantically established immediate co-presence can begin directly at a concrete
location, while explicit future/negative evidence is rejected. Departure settles
only after the farewell reply.
M11 adds a durable private-message Inbox. Rapid user messages are accepted while
the character is generating, grouped with a 5-second initial grace period and a
7-second hard maximum, and delivered to one Pi turn as a single newline-separated
provider user message while remaining separate durable transcript/UI entries.
Messages arriving during generation remain queued for the next turn. SQLite
preserves queued input across restarts, while a session-scoped SSE subscription
streams progress independently of the request that enqueued the message.
M12 Phases 1-2 add durable user-calendar, reminder, and exact-quote SMS
observations. A trusted
policy layer promotes only bounded low-risk recurrence, repeated completion, and
snooze evidence into confirmed reality memory and deterministic profile
projection, with sensitivity redaction, conflict suspension, user overrides,
restart reconciliation, provenance and control UI, and built-in model-path
coverage. Model profiles now include an optional context window; direct sessions
expose measured/estimated remaining input, guarded manual compaction, and
model-relative planned/emergency checkpoints after durable coordinator handoff.
Each character has exactly one canonical SMS private conversation. Opening SMS
again returns that conversation instead of creating another Pi session. Each
world has exactly one shared third-person timeline. Standalone RP and group chat
are retired: schema 26 deletes old groups and startup purges legacy RP sessions
without transcript migration. On upgrade, the most recently updated unarchived
legacy SMS session is retained per character (or the latest archived one when
none are active), and all earlier SMS sessions are archived without transcript
merging or deletion. Queued input from those older sessions is reassigned to the
retained conversation.
Schema 30 adds a separate functional profile for each character, a fixed
capability registry, declared module bindings, concurrency limits, and
idempotent collaboration evidence. World MCP collaboration can keep an explicit
target or request one to three capability IDs for deterministic same-world
routing. Capability declarations never grant module or sandbox permissions.
Schema 31 adds conservative SOUL-based function inference and exactly one
versioned `SKILL.md` per character. The active Skill is visible in the character
manager and loaded only into that character's collaboration workbench. Completed
task milestones let the character-bound model propose a bounded replacement;
static privilege checks, immutable history, and rollback keep this separate
from MCP, shell, network, and workspace authority. Advanced manual edits lock
automatic inference until explicitly re-enabled.
Chat bubbles expose a collapsible execution summary built from sanitized Pi
lifecycle events. It shows request preparation, response generation, tool names,
tool completion, safe reasoning start/end status, and retries, but never tool
arguments, hidden chain-of-thought, credentials, or system prompt content. Tool
result messages are complete but collapsed by default. Full tool results remain
in the Pi transcript and Debug/audit surfaces; the provider-only context copy
caps the current tool phase at 48,000 text characters (32,000 per result) and
retains at most 6,000 characters from the newest historical results. Older
results and their matching historical tool-call blocks are removed together;
large historical call arguments are represented by bounded previews. Management shows
tokenizer-dependent estimates for MCP schemas and Skill index/full-content cost.

This document is the source of truth for evolving YourChar from the current
prototype into a reliable daily scheduling and role-playing application. When
implementation and this document disagree, either update the implementation or
update this document in the same change with an explicit rationale.

## 1. Goals

The product must support two connected but clearly separated use cases:

1. Daily scheduling: create, inspect, update, complete, cancel, and receive
   notifications for events, tasks, and reminders through natural language or
   direct UI operations.
2. Role playing: maintain stable characters, scenes, relationships, and useful
   long-term memory across long conversations and process restarts.
3. Shared companion behavior: an RP character may discuss real schedules, but
   fictional events must never mutate real-world state without explicit user
   intent.
4. Agent-driven development: an automated agent must be able to create an
   isolated test run, control time and model output, exercise the production API,
   and inspect deterministic state without accessing production data.

## 2. Non-goals for the first usable release

- Multi-user accounts and public internet hosting.
- Autonomous actions outside the configured notification adapters.
- Vector databases or distributed queues before SQLite-based retrieval and an
  outbox have demonstrated a concrete limitation.
- Modifying or forking Pi internals for RP-specific behavior.
- Calendar-provider synchronization in the first scheduling milestone.

## 3. Current baseline and known gaps

The application runs the original `@earendil-works/pi-coding-agent` session
runtime with all Pi packages pinned to `0.80.3`. Pi owns JSONL transcripts and
SQLite owns schedule items, reminder occurrences, and notification outbox
state. Private character chats are canonical SMS Pi sessions; shared roleplay is
one application-owned World timeline per world. The browser restores both kinds,
model credentials use mode `0600`, and scheduling is available through
MCP-discovered Pi tools, `/api/v1`, and the Schedule UI.

RP state also uses SQLite migration v2. The Characters view manages character
profiles, per-conversation scenes, and typed memory. Confirmed memory is
retrieved through FTS5 plus salience/recency fallback and assembled into Pi's
system context before every RP turn. This context is external to transcript
history, so it is reassembled after restart and Pi compaction.

Migration v6 stores module enablement overrides. Its original structured profile
table is retained as an unused append-only migration artifact. The canonical
profile is `<stateDir>/memory-vault/reality/user-profile.md`; Management can edit it directly, and
User Profile MCP controls whether the Agent can read it and whether it is
assembled into private SMS and read-only World narrative context. A separate permission
controls whether the Agent receives the update tool.

Generic Agent file access is rooted at `<stateDir>/workspace` and has off,
read-only, and read-write modes. Shell execution is disabled by default and uses
Bubblewrap without host state mounts or inherited environment variables. Shell
network, User Profile writing, and character SOUL writing are independent
permissions. See `workspace-capabilities.md` for the normative capability
contract.

Implemented scheduling behavior includes strict relative/local/weekday/ISO time
resolution, ambiguity and past-time rejection, daily/weekly recurrence,
idempotent create, overlap warnings, snooze, quiet-hour deferral, three delivery
attempts, exactly-once outbox records, visible delivery failures, and manual
retry. The injected server clock is authoritative; clients cannot override time
on normal production requests.

Remaining operational limitations:

- Memory extraction uses a cheap self-disclosure prefilter followed by semantic
  extraction; quality still needs a larger evaluation corpus and relevance metrics.
- Retrieval quality has deterministic coverage but no evaluation corpus or
  relevance metrics yet.
- Desktop delivery is opt-in and depends on a host `notify-send` binary plus a
  working desktop notification daemon.
- Schedule MCP currently uses the official linked in-memory transport. The
  generic adapter permits stdio or Streamable HTTP later without changing Pi or
  schedule domain code.
- Public/LAN hosting remains unsupported until authentication and CSRF controls
  are added; the supported deployment remains loopback-only and single-user.

## 4. Hard architecture decisions

### 4.1 Pi remains the unmodified agent runtime

Use the original Pi programmatic SDK as the conversation substrate. The target
runtime is `@earendil-works/pi-coding-agent` at the same pinned version as
`pi-agent-core` and `pi-ai`.

- Create sessions through Pi's `AgentSession` APIs.
- Disable built-in coding tools with `noTools: "builtin"`.
- Register schedule capabilities through the MCP-to-Pi adapter and keep RP-only
  capabilities as narrow custom tools until they are migrated module by module.
- Replace the coding system prompt through `DefaultResourceLoader` and dynamic
  extension hooks.
- Use Pi `SessionManager` for transcript persistence, resume, and compaction.
- Use Pi streaming, cancellation, retry, and lifecycle events rather than
  recreating those mechanisms in YourChar.
- Do not edit the repository under `agent_references/pi`. Pin a released package
  version or an explicit upstream commit.

The application owns private-session metadata and maps each character to one
canonical SMS Pi session, including remote messages and confirmed in-person
continuity. Reminders and proactive world messages resolve their delivery target
through that mapping and restore the private thread when it was archived.

Multi-character roleplay does not create a Pi session. It uses one SQLite World
timeline per world: one world-bound narrative model reads an event-scoped fixed
snapshot plus append-only User/World history to write the complete visible
passage, and a world-bound Analyzer proposes trusted state changes. Exact
provider messages are durable only for the active event/checkpoint and are
purged on closure; visible passages and event settlements remain durable.
Character model bindings remain private chat concerns. The internal `rp`
context realm remains only a compatibility key for character memory and is not
a creatable UI mode.

### 4.2 Durable application state

Pi JSONL is the source of truth for conversation transcripts. SQLite is the
source of truth for relational application state:

- application conversation metadata;
- queued and processing private messages with client idempotency IDs;
- private-conversation interaction state and transition provenance;
- characters and scene state;
- memories and memory provenance;
- schedule items and reminder occurrences;
- tool actions and idempotency records;
- notification outbox and delivery attempts.

The user profile is intentionally one bounded, user-editable Markdown file at
`<stateDir>/memory-vault/reality/user-profile.md`, written atomically with mode
`0600`; `<stateDir>/user-profile.md` is only a migration mirror. The manual
section is model-visible, while the Coordinator-owned managed reality section
is visible only to the user control plane. It is not split across relational
rows.

Each character's static identity is likewise a bounded Markdown file at
`<stateDir>/characters/<characterId>/SOUL.md`. SQLite retains the character name
and relational ownership, while scene state and memory remain separate dynamic
records.

All schema changes use ordered migrations. Repository interfaces isolate SQLite
from application services. Domain code must not access SQL or mutable global
Maps directly.

Pi transcript writes and SQLite tool actions cannot share one database
transaction. Every mutating tool therefore uses the Pi `toolCallId` as an
idempotency key. Replaying the same tool call returns the original result rather
than applying the mutation twice.

### 4.3 Time, IDs, models, and notifications are injected dependencies

Application code must receive these interfaces instead of calling global
facilities directly:

```ts
interface Clock {
  now(): Date;
}

interface IdGenerator {
  next(kind: string): string;
}

interface ModelGateway {
  createSessionModel(sessionId: string): unknown;
}

interface NotificationSink {
  deliver(notification: NotificationDelivery): Promise<DeliveryResult>;
}
```

Production uses a system clock, UUID generator, configured Pi model, and real
notification adapters. Tests use a virtual clock, seeded IDs, a scripted model,
and a capture-only notification sink.

### 4.4 Real-world mutations have a policy boundary

Pi's `beforeToolCall` hook is the final authorization point for mutating tools.
The policy receives conversation kind, user message provenance, tool arguments,
and confirmation state.

- Fictional RP text cannot create or modify a schedule item.
- Ambiguous real-world time requires clarification.
- Destructive actions require explicit target selection and confirmation.
- A repeated request uses an idempotency key and cannot create duplicates.
- Tool arguments are schema-validated and domain-validated before execution.

`afterToolCall` records a structured audit action without storing secrets or
model reasoning.

## 5. Target component layout

```text
Browser / API client
        |
HTTP routes and stream transport
        |
Durable private Inbox + per-conversation burst coordinator
        |
Application services + per-conversation execution queue
        |
PiSessionRuntimeAdapter (original Pi AgentSession)
        |                    |
ContextAssembler        ToolPolicy
        |                    |
RP repositories    MCP-to-Pi adapter -> Schedule MCP server
        |                                  |
        +--------------- SQLite -----------+
                           |
Scheduler -> resume source Pi session -> freeze outbox payload -> notification sink
```

Recommended source layout:

```text
src/
  app/             application services and dependency composition
  pi/              thin adapters around original Pi SDK
  mcp/             reusable Pi adapter and domain MCP servers
  schedule/        schedule entities, services, tools, scheduler
  rp/              characters, scenes, memories, context assembly
  storage/         SQLite repositories and migrations
  notifications/   outbox worker and delivery adapters
  http/            versioned production and test-control routes
  testing/         deterministic runtime and scripted dependencies
```

## 6. Scheduling domain

### 6.1 Schedule item

The initial `ScheduleItem` contract contains:

```ts
type ScheduleItem = {
  id: string;
  kind: "event" | "task" | "reminder";
  title: string;
  notes?: string;
  startAt?: string;       // UTC ISO 8601
  endAt?: string;         // UTC ISO 8601
  timezone: string;       // IANA name, for example Asia/Shanghai
  allDay: boolean;
  recurrenceRule?: string;
  status: "scheduled" | "completed" | "cancelled";
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
};
```

Reminder occurrences are separate records so recurring schedules can be
claimed, retried, snoozed, and delivered independently.

### 6.2 Required operations

- Create an event, task, or reminder.
- List by day, range, status, and text query.
- Get one item with occurrences and delivery state.
- Update title, notes, time, timezone, and recurrence.
- Complete a task.
- Cancel an item.
- Snooze one reminder occurrence.
- Detect obvious overlaps and return them as warnings, not silent failures.

Corresponding Pi tools use narrow structured schemas:

```text
create_schedule_item
list_schedule_items
update_schedule_item
complete_schedule_item
cancel_schedule_item
snooze_reminder
```

### 6.3 Time rules

- Store instants in UTC and retain the user's IANA timezone.
- Resolve relative expressions from the injected `Clock`, never from browser
  time supplied as an authority.
- Support absolute date/time, relative time, weekday expressions, all-day items,
  and recurrence.
- Reject nonexistent local times during daylight-saving transitions.
- Return an `AMBIGUOUS_TIME` result when multiple interpretations remain.
- Never use a guessed default such as one hour later.

### 6.4 Scheduler and notifications

The scheduler claims due occurrences in a SQLite transaction and writes an
outbox entry. Delivery workers process the outbox with bounded retries. A unique
constraint on occurrence and channel prevents duplicate notification delivery.
For Agent-created reminders, the worker resumes `sourceSessionId`, injects a
hidden `reminder_due` custom event, and persists the Agent's reply in the same
transcript. The generated body is stored in the outbox before sink delivery, so
retries and process restarts do not trigger duplicate Agent turns.

The first usable release requires:

- in-app notification history;
- one background-capable local notification adapter;
- captured notification sink for tests;
- quiet-hour policy;
- visible failed-delivery state and manual retry.

## 7. Role-playing domain

### 7.1 Core records

- `CharacterProfile`: name plus one bounded `SOUL.md` document containing static
  identity, values, voice, behavior, relationship baseline, boundaries, and
  narration style.
- `RoleSession`: character ID, Pi session ID, world/scenario ID, status, and
  continuity settings.
- `SceneState`: location, in-world time, participants, current objective, open
  threads, and latest summary.
- `Memory`: type, content, source message, character, salience, confidence,
  validity state, tags, creation time, and last-used time.

New roleplay memory types are `relationship_event`, `world_fact`, `plot_event`,
and `boundary`. Durable real-user facts use `reality/global` memory types
`user_fact`, `preference`, `goal`, `person`, `project`, and `boundary`; User
Profile is their bounded high-signal summary.
Historical `user_fact`/`preference` rows remain readable as quarantined legacy
data and are never injected into model context.

Implementation note: a persistent post-turn Coordinator creates jobs only for
explicit authorization or durable-signal turns. Explicit user authorization is
confirmed by backend evidence; model extraction and realm-bound
`propose_memory` MCP calls can create only pending candidates. Confirmation is
available only through trusted UI/API operations; pending memory is excluded
from model context.

### 7.2 Memory lifecycle

Do not save every user message as long-term memory. After a completed turn, a
memory extractor may propose high-value candidates. Candidates are normalized,
deduplicated, checked for contradictions, and then committed. User-pinned memory
is committed directly and marked as confirmed.

Retrieval starts with SQLite FTS5 plus filters for character, type, recency, and
salience. Embeddings are deferred until retrieval quality measurements justify
the additional system.

The context assembler budgets context in this order:

1. safety and real-world mutation policy;
2. current clock, locale, and conversation kind;
3. character and user profile;
4. world and current scene summary;
5. retrieved long-term memories;
6. recent complete conversation turns.

Pi compaction summarizes older complete turns. It must never split an assistant
tool call from its tool result.

Before each provider request, tool-result compaction operates only on the
ephemeral provider context, never on session persistence. The current tool phase
keeps enough bounded evidence for the model to finish the operation. On later
user turns, only the newest bounded historical tool evidence remains; any
discarded result and its matching assistant call are removed as a pair. This
prevents search, web, file, and subagent payloads from consuming every later
turn while preserving complete user-visible diagnostics.

The current integration keeps character, scene, and retrieved memory outside
the transcript and injects them through Pi's `before_agent_start` hook on every
turn. Consequently transcript compaction cannot remove durable RP state.

## 8. Production HTTP API

All new endpoints use `/api/v1`. Existing unversioned endpoints remain only as
temporary compatibility adapters until the UI migrates.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Process liveness |
| GET | `/api/v1/readiness` | Database and runtime readiness |
| POST | `/api/v1/sessions` | Legacy fixed-kind compatibility adapter; supported UI uses direct/world endpoints |
| POST | `/api/v1/direct-conversations` | Open or restore one character's canonical SMS conversation |
| GET | `/api/v1/sessions` | List resumable conversations |
| GET | `/api/v1/sessions/{id}/messages` | Read persisted transcript |
| GET | `/api/v1/sessions/{id}/context-budget` | Read measured/estimated model-window capacity and latest checkpoint |
| POST | `/api/v1/sessions/{id}/compact` | Guarded manual deterministic context checkpoint |
| POST | `/api/v1/sessions/{id}/messages` | Synchronous JSON turn for clients and tests |
| POST | `/api/v1/sessions/{id}/messages/stream` | Streaming turn over fetch-compatible SSE |
| GET/POST | `/api/v1/sessions/{id}/inbox` | Inspect active private input or enqueue an idempotent message |
| PATCH/DELETE | `/api/v1/sessions/{id}/inbox/{messageId}` | Edit or retract a message that is still queued |
| GET | `/api/v1/sessions/{id}/inbox/events` | Durable-turn progress over reconnectable SSE |
| POST | `/api/v1/sessions/{id}/messages/cancel` | Abort the active Pi turn |
| POST | `/api/v1/sessions/{id}/messages/retry` | Retry a failed side-effect-free turn |
| GET | `/api/v1/world-conversations` | List one canonical timeline per active world |
| GET | `/api/v1/worlds/{id}/conversation` | Read World timeline and current event state |
| DELETE | `/api/v1/worlds/{id}/conversation` | Reset the canonical World timeline with exact-name confirmation while retaining settled continuity |
| GET/POST | `/api/v1/worlds/{id}/conversation/messages` | Read messages or run one JSON World turn |
| POST | `/api/v1/worlds/{id}/conversation/messages/stream` | Stream World narrative and Analyzer lifecycle events |
| POST | `/api/v1/worlds/{id}/conversation/read` | Acknowledge one World timeline's unread count |
| POST | `/api/v1/worlds/{id}/conversation/event` | Apply or undo a trusted story-event transition |
| GET/POST | `/api/v1/schedule-items` | Query or create schedule items |
| GET/PATCH/DELETE | `/api/v1/schedule-items/{id}` | Inspect, update, or cancel one item |
| POST | `/api/v1/schedule-items/{id}/complete` | Complete a task |
| POST | `/api/v1/reminder-occurrences/{id}/snooze` | Snooze one occurrence |
| GET | `/api/v1/notifications` | Inspect delivery history and failures |
| GET/PATCH | `/api/v1/user-profile` | Read the full profile or update its user-owned manual section |
| GET | `/api/v1/user-insights` | Inspect bounded profile observations, policy decisions, and provenance |
| POST | `/api/v1/user-insights/{id}/{confirm\|reject\|unlock}` | Apply explicit user control to an automatic profile observation |
| POST | `/api/v1/notifications/{id}/retry` | Retry one failed delivery |
| GET/POST | `/api/v1/characters` | List or create characters |
| GET/PATCH | `/api/v1/characters/{id}` | Inspect or update a character |
| GET/PATCH | `/api/v1/sessions/{id}/scene` | Legacy/private continuity scene adapter |
| GET/POST | `/api/v1/memories` | Search or pin memory |
| PATCH/DELETE | `/api/v1/memories/{id}` | Correct, supersede, or remove memory |
| POST | `/api/v1/diagnostics/model/test` | Test configured model completion endpoint |
| GET | `/api/v1/diagnostics/model/models` | Discover provider models when supported |
| GET | `/api/v1/export` | Export user data without model credentials |
| DELETE | `/api/v1/data` | Delete all user data after explicit confirmation |

Mutating requests accept `Idempotency-Key`. Every response contains a
`requestId`. Errors use a stable machine-readable envelope:

```json
{
  "error": {
    "code": "AMBIGUOUS_TIME",
    "message": "提醒时间需要确认",
    "details": {
      "candidates": []
    },
    "requestId": "req_0001"
  }
}
```

The synchronous message endpoint remains available even after streaming is
implemented because it is easier for automation and contract tests.

The browser uses the Inbox endpoints for private chat. A burst is bounded to 10
messages and 12,000 Unicode characters. The model receives each message as its
own Pi `user` entry and is invoked only by the final entry; retrieval, trace,
memory extraction, and relationship extraction receive the bounded combined
text. Tools that require current-message evidence, such as `begin_meeting`, read
only the final real user message. Disconnecting the browser never aborts the
turn, and archiving or deleting a conversation is rejected while its Inbox is
not idle. The default accumulation grace is 1.5 seconds. While a queued burst
exists, composer `input` events send a throttled
`POST /api/v1/sessions/{id}/inbox/typing` heartbeat; each heartbeat defers the
claim until input has been quiet for another 1.5 seconds, even beyond the normal
maximum wait. Message and character-count caps still force bounded batches.

Every completed private character reply first increments the durable unread
count on its conversation. The UI acknowledges it through
`POST /api/v1/sessions/{id}/read` only when that exact private thread is on the
chat page, the document is visible, and the browser window has focus. Switching
threads or application pages, hiding the tab, losing focus, or disconnecting
before completion therefore leaves a red count on both the thread and its
Characters section. System/error events do not create unread character messages.

World unread state is independent. One completed World turn with incoming World
output increments its timeline once. It is acknowledged
only while that exact World timeline is visible and focused.

## 9. Agent-oriented test interfaces

### 9.1 Security and isolation

Test control routes are compiled with the server but disabled unless
`RP_AGENT_TEST_MODE=1`.

- The server must reject test mode when bound to a non-loopback host unless an
  explicit test token is also configured.
- Test requests never access the production database, Pi transcript directory,
  model credentials, or notification adapters.
- Each test run owns a temporary SQLite database, Pi session directory, virtual
  clock, scripted model queue, seeded ID generator, and capture notification
  sink.
- Deleting or expiring a run recursively disposes only that run's resources.
- Test endpoints accept data, not executable code or shell commands.

### 9.2 Test run lifecycle

Control endpoints use `/api/_test/v1`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/_test/v1/runs` | Create an isolated deterministic runtime |
| DELETE | `/api/_test/v1/runs/{runId}` | Dispose the run |
| PUT | `/api/_test/v1/runs/{runId}/clock` | Set absolute virtual time |
| POST | `/api/_test/v1/runs/{runId}/clock/advance` | Advance by milliseconds |
| POST | `/api/_test/v1/runs/{runId}/model/responses` | Queue scripted Pi model responses |
| GET | `/api/_test/v1/runs/{runId}/model/requests` | Inspect captured model contexts and tools |
| POST | `/api/_test/v1/runs/{runId}/scheduler/tick` | Run one scheduler cycle synchronously |
| GET | `/api/_test/v1/runs/{runId}/notifications` | Inspect captured deliveries |
| GET | `/api/_test/v1/runs/{runId}/events` | Read ordered domain and Pi events after a sequence |
| GET | `/api/_test/v1/runs/{runId}/snapshot` | Read canonical sorted application state |

After creating a run, an agent calls the normal `/api/v1` routes with the header
`X-RP-Test-Run-Id: {runId}`. Middleware selects that run's dependencies. The
header is rejected when test mode is disabled. This ensures tests exercise the
same route and application code as production rather than a duplicate API.

Example run creation:

```http
POST /api/_test/v1/runs
Content-Type: application/json

{
  "now": "2026-07-11T09:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "seed": "schedule-create-01"
}
```

Example scripted model queue:

```json
{
  "responses": [
    {
      "kind": "tool_call",
      "name": "create_schedule_item",
      "arguments": {
        "kind": "reminder",
        "title": "喝水",
        "startAt": "2026-07-11T09:05:00.000Z",
        "timezone": "Asia/Shanghai"
      }
    },
    {
      "kind": "assistant_text",
      "text": "已经设好五分钟后的喝水提醒。"
    }
  ]
}
```

The scripted model supports `assistant_text`, `tool_call`, `provider_error`, and
`stream_chunks`. It consumes responses in order and records every received
system prompt, message list, tool schema, and model option. It must never call a
network model.

The snapshot response is canonical: records are sorted by type and ID, volatile
transport fields are omitted, timestamps come from the virtual clock, and IDs
come from the seeded generator. This makes snapshots suitable for automated
comparison without brittle normalization.

### 9.3 In-process test harness

Expose a TypeScript harness from `src/testing/index.ts` for faster integration
tests:

```ts
const runtime = await createTestRuntime({
  now: "2026-07-11T09:00:00.000Z",
  timezone: "Asia/Shanghai",
  seed: "rp-memory-01",
});

await runtime.model.enqueue([...]);
await runtime.app.sendMessage(input);
runtime.clock.advance(5 * 60_000);
await runtime.scheduler.tick();
const snapshot = await runtime.snapshot();
await runtime.dispose();
```

HTTP test controls and this harness use the same `TestRuntime` implementation.
Neither is allowed to maintain a second implementation of business logic.

## 10. Required automated scenarios

Each scenario must be testable through both the in-process harness and the HTTP
contract where applicable:

1. Data remains after application restart and a Pi session can resume.
2. Relative, absolute, weekday, timezone, and recurrence expressions resolve
   correctly from the injected clock.
3. Ambiguous time produces clarification and no schedule mutation.
4. A due occurrence creates one outbox entry and one captured notification, even
   when the scheduler tick is repeated.
5. Snoozing creates the correct next occurrence without redelivering the old one.
6. Concurrent messages in one session execute in deterministic order.
7. Fictional reminder language in a World turn never creates a real schedule item.
8. World narrative calls have no schedule tools; real scheduling remains in a canonical private thread with normal policy checks.
9. A confirmed long-term memory is retrieved after restart and after compaction.
10. Contradictory memory supersedes or requests confirmation instead of silently
    duplicating facts.
11. Provider timeout, cancellation, and retry do not duplicate tool effects.
12. Test mode cannot read production state or deliver a real notification.

## 11. UI requirements

The first usable UI contains four primary views:

- Conversations: Worlds/Characters hierarchy, one timeline per world, one
  private thread per character, persisted history, streaming response, cancel,
  retry, unread state, and visible tool status.
- Schedule: today, upcoming, completed, direct create/edit/cancel, recurrence,
  snooze, and delivery state.
- Characters: card management, model binding, SOUL.md editing, world membership,
  memory search, pin/correct/delete controls, and private/World boundaries.
- Settings and diagnostics: model connection test, model discovery when
  supported, notification adapter status, database status, and bounded logs.

Debug captures the final provider payload from Pi's `before_provider_request`
hook after request-option rewrites. It retains at most 10 calls globally and
shows `system`, `user`, `assistant`, `tool`, tool schema, and request parameters
with distinct colors. A master-detail layout keeps the latest calls selectable
without stacking all payloads vertically. The detail viewer supports semantic/raw
tabs, per-block and global expansion, line wrapping, and payload copy; its content
scrolls independently without per-block height truncation. The semantic view is
accompanied by the sanitized raw JSON payload so provider-specific fields remain inspectable. Credential-shaped fields
are redacted by key, while textual message content and tool schemas are not truncated. Embedded binary data URLs are
replaced with MIME/encoded-size placeholders to keep Debug bounded; this never changes the actual provider request.
The read endpoint is `GET /api/debug/model-traces?limit=10`; the limit is always
clamped to 10. The optional JSONL archive is controlled through
`GET/PATCH /api/settings/trace-archive`, is included in state backups, and is
removed by complete deletion. Bounded Trace data participates in normal
user-data export; the unbounded JSONL archive does not.
Raw token deltas are not stored indefinitely or returned in normal message
responses.

## 12. Security and operations

- Require Node `22.19.0` for development and Node `>=22.19.0` at runtime.
- Store secret files with mode `0600`; prefer Pi `AuthStorage`, environment
  variables, or an operating-system credential store.
- Keep the default bind address on loopback. Add authentication and CSRF
  protection before LAN exposure.
- Limit JSON body size and validate every request with shared schemas.
- Propagate client cancellation to Pi and tool execution.
- Add per-provider timeout and bounded retry settings.
- Provide export and complete deletion of conversations, memories, characters,
  and schedules.
- Run the application as a managed user service for reliable reminders; process
  uptime is part of scheduling correctness.

## 13. Delivery milestones

### M0: Runtime and specification

- Pin and validate Node `22.19.0`.
- Keep all Pi packages on one exact version.
- Adopt this document as the development baseline.

### M1: Original Pi session foundation

- Integrate Pi `AgentSession`, `SessionManager`, custom prompt loader, and custom
  tools with coding tools disabled.
- Add application conversation metadata and a per-conversation execution queue.
- Persist and resume transcripts.
- Add the `TestRuntime`, run lifecycle, virtual clock, scripted model, snapshot,
  and test-mode isolation skeleton.

Exit gate: restart and concurrency scenarios pass without schedule or RP state
loss.

### M2: Scheduling closed loop

Implementation status: complete in code and automated tests. Desktop adapter
activation must still be validated on a host with `notify-send` and an active
notification daemon.

- Add SQLite migrations and scheduling repositories.
- Implement schedule CRUD tools and production APIs.
- Replace fallback time parsing with validated resolution and clarification.
- Implement occurrences, scheduler, outbox, captured sink, and first real local
  notification adapter.
- Add Schedule UI.

Exit gate: all scheduling scenarios pass and a managed local process delivers a
real test notification exactly once.

### M3: RP continuity

Implementation status: complete. Characters, role sessions, scenes, typed
memory lifecycle, FTS5 retrieval, per-turn context assembly, Pi scene/memory
tools, persistent confirmation records, and Characters UI are implemented.

- Add characters, role sessions, scenes, typed memories, extraction, retrieval,
  correction, and deletion.
- Add context assembler and Pi compaction integration.
- Enforce RP/real-world tool policy and confirmation.
- Add Characters UI.

Exit gate: a character retains confirmed facts across restart and compaction,
while fictional content cannot mutate schedule state.

### M4: Product hardening

Implementation status: complete.

- Add streaming UI, cancellation, retry, model connection diagnostics, export,
  deletion, request limits, and bounded observability.
- Add browser-level tests for desktop and mobile layouts.
- Document managed-service installation and backup/restore.

Exit gate: all required automated scenarios, API contract tests, and browser
tests pass from a clean checkout.

### M5: MCP modules and proactive reminders

Implementation status: complete.

- Add a generic MCP client/server adapter for original Pi sessions.
- Move all model-driven schedule operations to the `rp-agent-schedule` MCP
  server while retaining deterministic model-disabled fallback.
- Resolve natural-language `timeExpression` inside the trusted schedule module.
- Resume the source Pi session for due reminders and persist the proactive
  assistant message.
- Freeze Agent-generated notification payloads in outbox migration v4 before
  delivery and reuse them on retries.
- Poll the active browser transcript for background Agent messages.

Exit gate: direct MCP contract, Pi-to-MCP intent, RP authorization, proactive
context resume, and exactly-once reminder-message tests pass.

### M6: capability management and user understanding

Implementation status: complete.

- Discover built-in and project-local Skills through Pi's original Skill loader.
- Persist MCP/Skill enablement overrides without modifying source files.
- Rebuild Pi handles after toggles while preserving transcript continuity.
- Restrict the custom `read` tool to directories of enabled Skills.
- Add one user-editable Markdown profile with a 2000-character hard limit.
- Add switchable User Profile MCP tools for manual-section read and replacement.
- Inject only the manual profile section while its MCP module is enabled.
- Provide Management UI and production APIs for both capability and profile state.

Exit gate: module API persistence, Pi Skill context, MCP tool removal, transcript
resume, profile MCP execution and limits, file persistence, and desktop/mobile
browser workflows pass.

### M7: confined workspace and protected-document permissions

Implementation status: complete.

- Add a dedicated Agent workspace with off, read-only, and read-write modes.
- Add path-confined read/write/edit tools and Bubblewrap-isolated shell execution.
- Keep shell network, User Profile edits, and character SOUL edits independently
  authorized and disabled by default where side effects are possible.

Exit gate: traversal and symlink escapes are blocked, shell policy is enforced,
and all permission combinations have API and browser coverage.

### M8: Tavily Search MCP

Implementation status: complete.

- Add a local `rp-agent-tavily-search` MCP backed by Tavily's REST API.
- Require both a disabled-by-default module switch and a configured API Key.
- Store the Key atomically with mode `0600` and expose only a safe mask.
- Return bounded source titles, URLs, and snippets through `tavily_search`.
- Keep raw queries, credentials, and results out of persistent audit summaries.
- Block the metered tool during proactive reminder composition.
- Add injectable fake-upstream tests and desktop/mobile settings coverage.

Exit gate: tool gating, search mapping, credential redaction, persistence,
diagnostics, module lifecycle, and browser workflows pass without production
network traffic.

### M9: shared worlds and character autonomy

Implementation status: complete.

- Add canonical worlds, fixed-capability places, memberships, runtime state, and character autonomy policy.
- Reuse character calendars for autonomous plans and settle completed activities into events and memories.
- Add bounded proactive SMS delivery and a conditional World State MCP.

Exit gate: planning, settlement, context isolation, proactive limits, world
reassignment cleanup, and desktop/mobile world-management workflows pass.

### M10: private meeting continuity

Implementation status: complete.

- Add durable `remote`, `meeting_pending`, and `co_present` state with append-only transition events.
- Add Interaction State MCP tools with actual-message arrival validation and delayed departure settlement.
- Keep the stable SMS prompt cacheable while replacing only one bounded volatile interaction projection.
- Add inline transition history, trusted manual controls, undo, and proactive-message suppression during co-presence.

Exit gate: tool flow, evidence rejection, failure rollback, HTTP confirmation,
context isolation, Agent test cases, and desktop/mobile browser workflows pass.

### M12: experience coherence and active user understanding

Implementation status: in progress. Structured user-calendar, reminder, and SMS
observations; bounded policy decisions; deterministic profile projection;
restart reconciliation; provenance controls; model-relative context budgets;
active compaction; canonical chat-header state; remote SMS multi-bubble
rendering; and ranked, user-controlled proactive delivery are complete.

- Unify the visible character status with canonical world, activity, and interaction state. **Implemented.**
- Add natural private-message batching, multi-bubble replies, and explicit queue controls. **Implemented.**
- Flush durable memories, promises, and scene state before conversation sleep, then wake from a bounded orientation packet. **Implemented for Memory and Post-turn Coordinators.**
- Rank and rate-limit proactive messages, with direct user feedback controls. **Implemented.**
- Add same-world character contact requests that route through the target character's own model and private thread, with visible unread state and an independent decline path. **Implemented.**
- Expose memory provenance and corrections while expressing relationship changes through behavior instead of scores.
- Evaluate configured model capabilities against built-in feature tests.
- Extend user understanding from text-only extraction to evidence-based schedule and interaction observations without profiling one-off or sensitive behavior. **Implemented for conversation, schedule, completion, and snooze evidence.**
- Track a per-model context budget, expose measured or estimated remaining capacity,
  and compact proactively at safe turn boundaries before provider overflow. **Implemented.**

Detailed product, context, safety, and test requirements are defined in
[`experience-coherence-m12.md`](experience-coherence-m12.md).

### M13: canonical World conversations

Implementation status: complete baseline.

- Retire standalone RP and ad hoc group chat from the visible product.
- Keep exactly one canonical private SMS Pi session per character and one
  application-owned World timeline per world.
- Bind narrative and Analyzer profiles at world scope. The narrative model reads
  bounded SOUL/state snapshots; it never invokes character-bound private models.
- Persist story events, observer-scoped knowledge, and directional
  character-to-character relationships with trusted confidence gates.
- Delete legacy group records and purge legacy RP sessions without transcript
  migration.
- Expose Worlds/Characters navigation, member-avatar mosaics, World unread state,
  event details, SSE lifecycle, and World-specific Debug trace labels.
- Manage World Cards as first-class objects, render one turn as continuous
  third-person interactive fiction, and settle provisional observations only
  when the owning event ends. **Implemented.**

The normative contract, migration policy, API, and required tests are defined in
[`world-conversation-mode.md`](world-conversation-mode.md).

## 14. Development rules for humans and agents

1. Work on the earliest incomplete milestone unless a user explicitly changes
   priority.
2. Do not modify Pi internals; add adapters, tools, and extensions in this
   repository.
3. Do not add direct `Date.now()`, `new Date()`, or `randomUUID()` calls in domain
   and application code; use injected dependencies.
4. Do not perform model or notification network calls in automated tests.
5. Every mutating tool must be schema-validated, policy-checked, idempotent, and
   audited.
6. Every new production endpoint must have a contract test and appear in the API
   documentation.
7. Every migration is append-only after merge and has a repository test.
8. Test-only behavior must remain behind `RP_AGENT_TEST_MODE=1` and isolated
   dependencies.
9. Update this document when an architectural decision or API contract changes.

## 15. Definition of done for a feature

A feature is complete only when:

- behavior and failure modes are defined;
- domain and request schemas validate inputs;
- persistence and idempotency are covered where applicable;
- unit and integration tests cover success, ambiguity, failure, and restart;
- an Agent can exercise it deterministically through the test harness or test
  control API;
- production secrets and external side effects are absent from tests;
- user-facing UI states include loading, empty, success, and error behavior;
- documentation and migrations are updated;
- `npm test` and the relevant browser tests pass under the pinned Node version.
