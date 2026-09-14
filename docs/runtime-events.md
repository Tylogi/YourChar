# Runtime Event and Replay Contract

YourChar schema 69 adds an append-only reconstruction layer around the durable
runtime. It does not replace the existing repositories, execute commands during
replay, or make SQLite events a second permission system. Repositories remain
the live source of truth; the event layer records the facts needed to audit and
rebuild their state.

## What is recorded

Every persistent SQLite table is inventoried in
`runtime_event_capture_catalog` as one of:

- `projection`: mutable rows mirrored into a runtime stream;
- `native_event`: an existing append-only typed domain ledger, also mirrored
  into the common envelope so one replay/export path is sufficient;
- `excluded`: runtime-event internals, derived FTS tables, process leases,
  migration markers, or a credential-bearing table that must not be copied.

Projection streams use the table name and ordered primary-key values as their
aggregate identity. Startup writes a `bootstrap` snapshot for pre-schema-69
rows. A changed table schema writes a `migration` snapshot. If the database was
changed while capture hooks were absent, startup writes a `reconcile` snapshot
or deletion marker. Inserts, updates, and deletes made through the active
connection are captured in the same SQLite transaction as the source write.

The capture hooks are connection-local temporary SQLite triggers. This matters
for rollback: no trigger that depends on newer application functions remains
in the database when an older binary opens it. Schema 69 is additive and its
tables can remain inert after a code rollback. Because the trigger schema is
temporary, every application connection pins SQLite temporary storage to
memory so trigger definitions and query spill never create an ambient temp
file.

File-backed session metadata has an explicit event stream. Its transitions are
`bootstrap`, `created`, `updated`, `archived`, `restored`, and `deleted`.
Machine-local `piSessionFile` paths are deliberately omitted. A settled turn
records the complete request, system prompt, final reply, actions, status, and
ordered semantic event types. Transient streaming payloads are not retained.

`model_context_traces` stores the exact provider payload after the existing
credential and binary-data sanitizer. Its mirrored projection is therefore the
authoritative record of what was model-visible, including file-backed SOUL,
profile, system-prompt, Skill, memory, and conversation material as assembled
for that request. `agent_module_provider_settings` is intentionally excluded
because it may contain write-only provider secrets. API keys and authorization
values must never be copied into this ledger.

## Envelope and version migration

Each event has a global sequence and a stream-local sequence, stable aggregate
identity, event type, event schema version, JSON payload, privacy scope,
previous hash, event hash, and occurrence time. The supported event types are:

- `runtime.projection.upserted` (v1 and v2);
- `runtime.projection.deleted` (v1);
- `runtime.session.snapshotted` (v1);
- `runtime.session.deleted` (v1);
- `runtime.turn.settled` (v1).

Replay validates the version before applying an event. The included v1-to-v2
projection migration demonstrates the compatibility rule: old payloads are
converted at the reader boundary, not rewritten in place. New incompatible
payload shapes require a new event version and a deterministic migration in
`src/runtime-events/schema.ts`.

The event hash is SHA-256 over the previous hash, stream sequence, event type,
event version, and exact stored payload JSON. This detects accidental changes,
partial writes, broken stream order, and inconsistent heads. It is not a
signature against an administrator who can rewrite the whole database and the
application code.

## Replay and checkpoints

`RuntimeEventStore.replay(streamId, throughStreamSequence?)` reconstructs the
latest projection, session, or settled-turn state. Replay never invokes a
model, tool, shell command, provider, notification, or any other side effect.

A checkpoint is created for the first event in a stream and thereafter after
64 events or 256 KiB of payload since the previous checkpoint, whichever comes
first. Only the latest four checkpoints per stream are retained. Events are
not pruned by checkpointing; checkpoints are disposable acceleration data.
Their state hash and anchor event are validated before use.

`RuntimeEventStore.verifyIntegrity()` walks every chain, validates event
versions and payloads, compares stream heads and counts, and checks checkpoint
anchors. Kernel readiness reports its result under `runtimeEvents` with stream,
event, and checkpoint counts. A `corrupt` result is an operator-visible failure
and must be investigated before trusting replay or backups.

The local `GET /api/v1/runtime-events/health` endpoint runs the same full
verification and returns counts plus bounded diagnostics. Schema-69 backup
validation independently recomputes every event and checkpoint hash before a
backup is accepted or restored.

The package exports the typed API from both the root and
`yourchar/runtime-events`:

```ts
const state = kernel.runtimeEvents.replay(streamId);
const characters = kernel.runtimeEvents.replayProjection("characters");
const health = kernel.runtimeEvents.verifyIntegrity();
const normal = kernel.runtimeEvents.exportScope("normal");
const secret = kernel.runtimeEvents.exportScope("secret", characterId);
```

## Privacy, export, and deletion

Every event inherits normal/secret ownership, character, and session scope from
the source row. Foreign-key traversal carries that scope into child tables such
as Subagent runs, execution attempts, and reminder delivery rows. The legacy
`memory_retrieval_stats` table has no declared foreign key, so capture treats
its `memory_id` as an explicit ownership link to `rp_memories`. Session and turn
events set scope explicitly.

Normal export includes only normal and host-global streams. Secret export
requires the exact owning character and includes only that partition. The user
data export includes the corresponding runtime event bundle, catalog, and
checkpoint policy; it never includes checkpoint copies or machine-local Pi
session paths.

Deleting a conversation removes every stream bearing its session ID. Deleting
a character removes its character/secret streams and all of its session
streams. Delete-all removes all streams, events, and checkpoints while keeping
the non-secret schema inventory. SQLite foreign-key cascades make those
deletions atomic. An incognito snapshot discards the parent's event ledger
before removing secret and parent-only projections; child startup then builds a
fresh ledger from that sanitized state. The rebuilt ledger exists only inside
the disposable tmpfs snapshot and is destroyed with it, so historical
checkpoints or tombstones cannot retain excluded data.

Events intentionally survive ordinary observability retention and source-row
updates so prior model-visible states remain reconstructable. Owner deletion is
the exception and physically removes the complete hash chains. Backups should
therefore include all schema-69 tables together with the rest of SQLite; never
restore events independently from their stream heads and checkpoints.
