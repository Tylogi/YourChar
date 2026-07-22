# Memory Architecture R5: Crash Consistency and Recovery

R5 keeps the Obsidian-compatible Markdown Vault authoritative. SQLite, FTS,
resident-memory state, economics, the operation journal, and compatibility
mirrors are operational state that can be validated or rebuilt from the Vault.
R1-R4 realm, confirmation, retrieval, budget, and provider-isolation contracts
remain unchanged.

## Durable mutation protocol

Every application mutation that can affect Vault documents, the managed profile
mirror, scenes, projection rows, or projection state runs under one operation:

1. Acquire and assert the current writer fence.
2. Persist a `prepared` journal record and a complete before snapshot.
3. Commit every Vault file using a full-write loop, file `fsync`, atomic rename,
   parent-directory `fsync`, and a fence renewal immediately before rename.
4. Persist the after snapshot and advance to `files_committed`.
5. Replace the SQLite/FTS projection in a transaction and advance to
   `projection_committed`.
6. Commit projection state and compatibility mirrors with the same durable
   write and fencing rules, then advance to `state_committed` and `completed`.

The operation record includes a random operation ID, caller idempotency key,
operation name, fencing token, stage, timestamps, and before/after manifests of
paths, sizes, and SHA-256 hashes. Journal records are atomic `0600` files under
`<stateDir>/memory-vault-journal/`; operation directories are `0700`. Completed
records retain metadata for the latest 100 operations and remove their body
snapshots. A pending operation snapshot contains the protected Vault and mirror
content needed for recovery, so the journal directory is sensitive user data.

Normal exceptions restore the before state before returning an error. A
simulated or real process exit leaves the last durable stage for startup replay.
Recovery is deterministic:

- `prepared`, or a record without a valid after manifest, converges to before;
- `files_committed`, `projection_committed`, or `state_committed` converges to
  the verified after snapshot;
- `completed` and `rolled_back` are already terminal.

After restoring either snapshot, recovery validates the Vault, rebuilds the
SQLite/FTS projection, and aligns profile/SOUL mirrors. Replaying recovery again
is idempotent. Fault-injection tests cover every journal stage, each durable
rename boundary, pair corrections, touch batches, scene deletion, forget plus
managed profile, projection state, and compatibility mirrors. Failpoints are
constructor-only test hooks; ordinary HTTP requests cannot enable them.

## Single-writer and job leases

App-controlled Vault mutation, sync, and rebuild require the singleton writer
lease in SQLite. A writer has a random owner ID, Linux process-start identity,
20-second expiry, 5-second heartbeat, and monotonically increasing fencing
token. A second live instance fails quickly with
`MEMORY_VAULT_WRITER_BUSY`. An expired lease can be taken over, but the old
writer must renew and assert its fence before every Vault, journal, projection
state, or mirror rename/unlink; its next commit fails with
`MEMORY_VAULT_STALE_WRITER`. Graceful kernel disposal releases the lease before
closing SQLite, and constructor failure releases both lease and heartbeat.

Coordinator jobs use independent owner and claim tokens with a 30-second lease
and 10-second renewal. Claim, lease renewal, lifecycle write, and completion
are fenced. Startup only returns expired running jobs to pending. A late worker
cannot write or complete after another owner has taken over, while graceful
dispose releases its claims for immediate restart.

These leases assume one local filesystem and SQLite database with a reasonably
consistent wall clock. They are not a distributed-filesystem consensus
protocol.

## Startup order

`CompanionKernel` completes the following before context planning or provider
injection:

1. Open/migrate SQLite and acquire the Vault writer lease.
2. Replay pending journal operations.
3. Strictly parse the Vault and deterministically rebuild SQLite/FTS and state.
4. Align compatibility profile/SOUL mirrors from canonical Markdown.
5. Project existing confirmed `person` memories into the reality person directory.
6. Remove resident-memory versions that are absent, inactive, unconfirmed, or
   no longer match current document content.
7. Recover expired Coordinator jobs, then initialize Pi session runtime.

This ordering prevents a provider request from observing half a correction,
forgotten content, a stale managed profile, or a stale resident snapshot.
External Obsidian edits still use whole-document CAS: the next safe read/sync
accepts a valid external version or reports a conflict, never last-write-wins.

## Backup and restore

Backup schema v3 contains a per-file path, SHA-256, and size manifest; creation
time; SQLite schema and `integrity_check`; Vault document and projection hashes;
and database-to-Vault consistency results. Credentials may be present in the
encrypted/protected backup payload but their values never enter the manifest.

The writer must be stopped for backup. The script checks the lease before and
after its staged copy, uses SQLite online backup, validates the copied Vault and
database, and atomically publishes the destination. Restore supports `--verify`
and `--dry-run`. A real restore validates the source, copies it into a sibling
staging directory, validates it again, and only then switches directories by
rename. Failure restores the original target and never promotes an invalid
backup.

## Health and observability

`GET /api/v1/memory-vault/health` reports writer mode/fence/expiry, pending
journal count, last checkpoint and recovery, projection hashes/consistency, and
backup freshness/verification. `GET /api/v1/memory-vault/recovery` is a smaller
recovery-focused view. Both return metadata and hashes only: no profile, SOUL,
scene, memory, provider, credential, or transcript content.

The Settings page renders the same fields in a fixed-height, internally
scrolling Vault Health panel on desktop and mobile. Memory management retains
realm, character, status, and type filters and exposes readable titles and
Vault-relative paths without changing UUID IDs or strict frontmatter.

## Data and realm boundaries

- Reality/global Markdown remains under `reality/`; character continuity stays
  under `roleplay/characters/<id>/`; legacy records remain quarantined.
- Confirmed reality `person` memories keep their original evidence records and
  also project into `reality/people/person_<stable-hash>.md`. A person profile
  stores a stable person key, display name, aliases, relationship label,
  source-memory IDs, aggregate confidence, and either global or selected-character
  visibility. Its generated fact block contains only active confirmed sources;
  user-authored Markdown outside that block survives later source updates.
- Person profiles remain Markdown authority and are not duplicated into SQLite
  or FTS. Retrieval first applies the selected-character visibility policy, then
  builds a query-relevant compact excerpt that fits the reality-memory budget.
  The complete profile is never injected wholesale.
- Trusted HTTP/UI and explicit-user authorization can activate or forget
  memory. Direct Agent/MCP proposals remain pending. When Reality Memory Write
  is enabled, the trusted background Coordinator may activate only low-risk
  reality facts with high confidence and exact user-quote evidence; sensitive
  facts remain pending.
- Pending, rejected, archived, superseded, deleted, legacy, and wrong-character
  records never enter provider context.
- Turning Memory Coordinator off disables extraction, tools, and all memory
  injection on the next request; preview remains read-only.
- User Profile manual text is stable context. Its managed memory section is a
  human-visible mirror and is not injected into the provider system prompt.

## Exhausted output-guard recovery

Internal-analysis titles are blocked before UI streaming or transcript
persistence. Pi rewinds and regenerates once while preserving the original user
message. If that second generation is also blocked, the native model turn stays
audited as failed. A deterministic recovery is allowed only for two explicit
SMS intents:

- a parseable real reminder executes the `create_schedule_item` ToolDefinition
  from the current session's in-memory Pi MCP bridge. The call therefore passes
  through the normal MCP adapter, schedule server validation, audit action, and
  same-turn deduplication;
- an explicit remember or forget instruction creates a persistent Coordinator
  job from the trusted original user text. Confirmation provenance remains
  `explicit_user_authorization`; ambiguous forget matches require UI selection.

RP, disabled modules, ordinary questions, and turns with an already-completed
side effect never enter the mutation path. A recognizable reminder with an
ambiguous time returns a blocked `input_required` system event without calling
MCP or creating a schedule item. Recovery writes a hidden custom result plus a
visible system event with `recoveryReason` set to
`output_guard_exhausted`; it never fabricates an assistant reply. Responses and
evaluation reports expose `nativeModelSuccess` separately from `recoveryUsed`.

After invoking the MCP ToolDefinition, the recovery path treats the audited
completed action as the source of truth. If the bridge response fails after the
schedule handler committed, it reports the existing item as created and records
`bridgeErrorAfterCommit`; it never claims that no item was created or invokes
the tool again.

## Limits

- A process killed after the underlying filesystem reports `fsync` success
  relies on that filesystem and storage device honoring durability semantics.
- Directory `fsync` support and atomic rename are required for the strongest
  guarantee; unsupported or network filesystems are outside the contract.
- Unsynchronized external editor changes are authoritative Vault changes but
  do not receive an app journal operation until a safe sync observes them.
- Pending journal snapshots duplicate protected user content temporarily.
- The deterministic release gate always runs locally. The real-model gate is a
  separate configured evaluation and must report unavailable or failure
  honestly; estimates never masquerade as provider usage.
