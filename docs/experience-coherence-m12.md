# M12 Experience Coherence and Active User Understanding

Status: in progress. Phase 1 schedule insights, Phase 2 conversation insights and
context budgets, and Phase 3 controlled character initiative are implemented.
Voice interaction is explicitly out of scope for this milestone.

## 1. Product outcome

The companion should feel like one coherent character rather than a collection of
memory, schedule, relationship, world, interaction, and tool subsystems. Internal
MCP names, state repairs, context compression, and model retries remain hidden in
normal chat while staying inspectable in Debug.

M12 prioritizes:

1. one canonical live character state in the chat header;
2. natural SMS message batching and multi-bubble reply rhythm;
3. a durable handoff before conversation sleep and a bounded wake orientation;
4. valuable, rate-limited proactive messages with user feedback controls;
5. inspectable memory provenance and correction;
6. relationship changes expressed through behavior rather than exposed scores;
7. model capability evaluation and compatibility labels;
8. active, evidence-based User Profile maintenance;
9. proactive context-budget control with visible remaining capacity.

## 2. Current User Profile limitation

The existing Memory Coordinator sees completed conversation text, but it does not
consume structured user-calendar events or notification behavior. The main Agent
is also instructed to update the manual profile only after an explicit stable user
statement. Consequently, ordinary schedule creation, completion, cancellation,
snoozing, and repeated interaction patterns cannot become profile evidence.

The existing safety boundary remains valid: a one-off appointment is not a stable
user trait, a planned action is not proof that it happened, and fictional
character schedules must never affect the real User Profile.

## 3. Target insight pipeline

Use a controlled background pipeline instead of allowing the dialogue model to
rewrite Markdown from guesses:

```text
conversation and domain events
  -> User Insight Coordinator
  -> durable source observations with provenance and policy state
  -> deduplication, conflict, sensitivity, and confidence policy
  -> confirmed reality memory or pending insight
  -> deterministic User Profile projection
```

Supported evidence sources:

- explicit facts and preferences in completed SMS/reality user messages;
- user-calendar create, update, complete, cancel, and recurrence events;
- reminder snooze, dismissal, lead-time, and quiet-hour choices;
- repeated communication preferences and corrections;
- direct user edits to the profile and memory control plane.

RP-only text, character calendars, generated assistant claims, failed turns, and
uncompleted tool calls are excluded.

Every observation records a source type, source identifier, observed time,
normalized claim key, confidence, sensitivity class, and validity. These records
provide OKF-compatible provenance without cluttering the human-readable Markdown.

### 3.1 Phase 1 and 2 implementation contract

Schema 24 stores schedule, reminder, and completed SMS evidence in
`user_insight_observations`. Schedule
mutations publish an in-process event only after their SQLite transaction commits;
observer failure is audited and cannot roll back or misreport an already committed
calendar change. Startup reconciliation rebuilds policy state from durable user
calendar items and persisted reminder choices.

The Phase 1 coordinator is enabled only when both `mcp:memory-coordinator` and
`realityMemoryWriteEnabled` are enabled. `userProfileWriteEnabled` independently
controls deterministic Markdown projection. Re-enabling either permission runs a
reconciliation, and semantic no-op projection does not rewrite the profile.

Implemented decisions are `context_only`, `accumulating`, `promoted`,
`blocked_sensitive`, `write_disabled`, `conflicted`, `user_blocked`, and
`retracted`. A user correction receives the `user-corrected` tag; a user archive
or deletion creates a claim-level block so a later scan or duplicate source cannot
silently recreate the old automatic conclusion. System withdrawals caused by
conflict or changing evidence remain eligible for deterministic reactivation.

`GET /api/v1/user-insights` returns bounded recent observations and aggregate
counts. The User Profile management tab renders the same state with expandable,
redacted evidence. Export and test-runtime snapshots include this state; full user
data deletion removes it. `PATCH /api/v1/user-profile` updates only the user-owned
manual section and deterministically rebuilds the managed section, preventing a
UI save from desynchronizing visible Markdown and confirmed reality memory. A
built-in `schedule-profile-insight` model test checks the complete tool-to-profile
path.

Conversation-derived facts use the existing Memory Coordinator extractor, but
high-confidence low-risk exact user quotes now enter User Insight Coordinator
before becoming confirmed reality memory. The semantic model proposes type and
stable key; the stored claim remains the verified quote. Broader self-disclosure
prefiltering reduces missed ordinary statements while acknowledgements and
transient mood stay cheap. Assistant claims, failed turns, RP text, and sensitive
quotes remain excluded from global profile inference.

Users can confirm, reject, or unlock observations through Management or
`POST /api/v1/user-insights/{id}/{confirm|reject|unlock}`. Rejection archives the
generated memory and creates a claim-level block. A successful background
conversation promotion may show one quiet `已记住` receipt after the completed
private-message burst.

## 4. Promotion policy

| Evidence | Default treatment |
|---|---|
| Explicit, low-risk stable user statement | Confirm immediately |
| Explicit recurring user schedule | Confirm as a routine, not as identity |
| One-off user schedule | Keep in calendar/current context; do not profile |
| Repeated completed activity | Infer only after multiple observations across distinct days |
| Repeated reminder preference | Infer after a minimum sample and use cautious wording |
| Cancelled or merely planned activity | Never treat as completed behavior |
| Health, finance, politics, religion, sexuality, credentials, contact data, or exact address | Never auto-promote; require trusted user confirmation or exclude |
| Conflicting evidence | Preserve both sources and request confirmation; do not silently overwrite |

Suggested initial thresholds are three completed observations across at least
seven days for a routine, and five independent choices for an interaction or
reminder preference. Explicit recurrence configured by the user is direct
evidence and does not need repeated completion, but should be phrased as a
scheduled routine rather than a proven habit.

Examples:

- `明天下午提醒我拿快递` remains a one-off calendar item.
- A user-created weekly Monday meeting may project as `周一上午通常安排组会`.
- Three completed exercise items across two weeks may project as `近期有规律安排锻炼`.
- A recurring event titled with an organization name must not infer employment.

## 5. Profile and context placement

The canonical `reality/user-profile.md` remains user-editable and bounded to 2000
Unicode characters. Manual text is never truncated or overwritten by managed
projection. Managed content is grouped into stable facts, preferences and
boundaries, recurring routines, goals/projects, and interaction preferences.

Context uses three different lifetimes:

- stable profile core: compact confirmed facts that change infrequently;
- retrieved durable memory: query-relevant evidence selected per turn;
- volatile current-user context: near-term calendar commitments and current
  focus, replaced every turn and never promoted solely because it is current.

Observation ingestion may be immediate, but the profile file and stable context
version change only when the rendered semantic content changes. This preserves
KV-cache reuse. A pre-sleep flush settles pending high-confidence observations,
open promises, and current scene state before conversation compaction.

### 5.1 Context budget and proactive compaction

Each model profile can define its context window. A budget snapshot is resolved
from the model bound to the
current character and reports:

- model context window and whether it is configured or using the documented default assumption;
- canonical provider input, including the tool schema;
- reserved output tokens and a safety margin for tool continuations;
- remaining usable tokens, utilization percentage, and estimate confidence;
- current lifecycle state and the last compaction result.

When provider usage is available, the completed turn displays actual input usage.
Before the next request, the controller uses the canonical provider-payload
estimate. Remaining capacity is therefore always labelled as measured or
estimated; the UI must not present the character-only history estimate as the
whole model context.

Compaction has three bounded levels:

1. provider-only hygiene continues to omit historical thinking and compact old
   tool payloads without rewriting the transcript;
2. planned compaction runs after a completed, side-effect-free turn when the
   projected next request crosses the model-relative warning boundary;
3. emergency preflight compaction runs before a request that cannot fit the
   configured window, rather than sending a request known to overflow.

Planned or emergency compaction first flushes accepted User Insights, promises,
scene state, and other durable coordinator work. It then uses the existing
deterministic roleplay checkpoint, resets resident-memory accounting, and records
before/after budget snapshots. It never starts while streaming, during an MCP
mutation, while a private-message burst is still open, or after a failed turn.
Hysteresis and a minimum growth interval prevent repeated compaction near one
threshold. Failure leaves the original branch usable and exposes a retryable
status without discarding the completed reply.

The existing 32k tired and 60k hard-rest thresholds remain default experience
limits for large-context models, but effective thresholds are capped by the
configured model budget. A smaller model must compact before overflow instead of
waiting for an impossible fixed threshold.

The chat header shows one quiet capacity indicator: percentage on narrow screens
and estimated remaining tokens plus percentage on wider screens. Selecting it
opens a compact breakdown and a guarded manual `整理上下文` action. Debug retains
the exact measured/estimated values, component token counts, trigger reason,
checkpoint identifier, and before/after deltas.

## 6. User control and visibility

Management separates:

- manually written profile text;
- automatically summarized profile facts;
- pending or conflicting insights;
- a bounded profile change history with source summaries.

The user can confirm, edit, reject, forget, or lock an item. A rejected or
corrected observation creates a durable tombstone so the same historical evidence
cannot recreate it. Character-private disclosures are not promoted into the
global profile unless the user explicitly permits cross-character sharing.

Normal chat may show a quiet `已记住` receipt only for high-value changes. Debug
shows the exact observation, policy decision, resulting memory, profile diff, and
context version change.

### 6.1 Controlled character initiative

Schema 25 upgrades proactive world events from a FIFO outbox to an inspectable
candidate pipeline. Events with salience below `0.45` remain ordinary world
history. Other events receive a stable topic, a deterministic score, and a
durable decision code before any message model is called.

The score combines event salience, age, novelty, source, event type, and direct
topic feedback. Delivery requires a score of at least `0.70`. Permanent
rejections include stale or missing events, muted topics, and low scores.
Temporary deferrals include quiet hours, daily budget, retry cooldown, global
and topic cooldowns, recent user activity, an active private-message burst,
model streaming, confirmed co-presence, and a user pause. Eligible candidates
are sorted by score, then event time and ID. Only one candidate reaches the
message model per tick; lower candidates remain pending, while duplicate
candidates for the same topic are superseded.

The default global cooldown is 120 minutes and is configurable from 15 to 1440
minutes. A normal topic has a minimum six-hour cooldown. `less_often` changes
that topic to a reduced 48-hour cadence; `mute_topic` suppresses pending and
future candidates for that topic. `pause_24h` pauses all proactive delivery for
the character. `helpful`, topic reset, and explicit resume provide reversible
controls. Daily limits and topic mute still apply to manual life simulation;
manual simulation only bypasses timing gates so it remains useful as a test
hook.

Feedback is available only on delivered messages and is idempotent. The chat
bubble shows a compact option menu, Character > Life exposes current pause,
cooldown, recent decisions and topic modes, and Debug > 主动决策 exposes scores
and complete decision metadata. The built-in `proactive-message-quality` case
tests scoring, delivery and prompt-leakage behavior against the configured
character model.

Relationship state, SOUL, retrieved memory and current world state may shape the
wording of a selected message through the normal bounded context plan. A
relationship delta does not itself enqueue an immediate message. This prevents
feedback loops in which intimacy scores create manipulative or excessive
contact. New candidate sources must enter the same deterministic policy rather
than calling the message model directly.

### 6.2 Same-world character contact

The World State MCP now supports a narrow, auditable relay between agents. When
the user clearly asks character A to have character B contact them, A first
reads the same-world public directory and then calls
`request_character_contact`. The server rejects self and cross-world targets.
It records one interaction event and one proactive candidate owned by B; no
private transcript, memory, SOUL, relationship metrics, or model settings move
from B to A.

B evaluates the quoted 500-character request in a separate background call
using B's own model profile, SOUL, relationship, canonical private-thread
context and current world runtime. The structured decision is either `send` or
`decline`. Only the final in-character SMS from a `send` decision enters B's
thread. A decline is durable as `character_declined` but creates no user-visible
message. Existing quiet hours, pause, daily budget, cooldown, recent-user,
busy-thread and co-presence gates apply before B is called.

Delivered proactive messages and completed foreground character replies share
one conversation unread counter. A reply is acknowledged only when completion
finds the exact private thread on the visible, focused chat page; leaving during
generation therefore preserves it as unread. The conversation list shows the
red count on both the private-thread row and character group header, so a
collapsed group cannot hide incoming messages. Opening the thread clears both
the unified counter and any associated proactive-message read markers. The
built-in `cross-character-contact` case plus `test/character-contact.test.ts`
and `test/conversation-unread.test.ts` cover routing, decline, isolation,
completion-time unread state and read acknowledgement.

## 7. Delivery order

1. Add structured user-observation events and repository contracts. **Implemented.**
2. Feed user-calendar and reminder lifecycle events into the coordinator. **Implemented.**
3. Add deterministic promotion, conflict, sensitivity, and expiry rules. **Implemented for schedule and exact-quote conversation evidence.**
4. Rework profile projection and split stable versus volatile user context.
5. Add profile insight controls and provenance UI. **Implemented for confirm, reject, unlock, correction/archive blocking, and redacted evidence.**
6. Add per-model context budgets, visible remaining capacity, proactive
   compaction, pre-sleep state handoff, and wake orientation. **Implemented.**
7. Add ranked proactive delivery, feedback controls and decision observability.
   **Implemented.**
8. Complete remaining relationship-expression and model-capability UI work.

## 8. Required tests

- a one-off reminder never changes the profile;
- an explicit recurrence can become a bounded routine;
- repeated completion strengthens evidence while cancellation does not;
- RP and character calendars cannot leak into reality profile;
- sensitive inference remains pending or absent;
- corrections and manual locks prevent stale facts from reappearing;
- projector output stays within 2000 characters and is deterministic;
- semantic no-op events do not change the stable context hash;
- restart and retry are idempotent;
- profile, retrieval, and pre-sleep handoff remain consistent after compaction;
- remaining capacity includes tool schema, output reserve, and safety margin;
- model-bound sessions use their own configured context windows;
- proactive compaction never splits a tool mutation or an open private-message burst;
- a failed compaction preserves the active branch and completed reply;
- successful compaction raises displayed capacity without losing durable memory;
- hysteresis prevents repeated checkpoints when usage stays near one threshold.
- proactive ranking is deterministic across retries and calls at most one message model per tick;
- same-topic candidates deduplicate, while cross-topic lower-ranked candidates remain pending;
- quiet hours, recent activity, busy conversations, co-presence, cooldowns, daily limits and pauses defer without losing work;
- stale, low-score, missing-event and muted-topic candidates are permanently auditable;
- feedback updates topic policy atomically and cannot be recorded on undelivered messages;
- the configured-model initiative test catches empty, leaked-internals or undelivered proactive output.
