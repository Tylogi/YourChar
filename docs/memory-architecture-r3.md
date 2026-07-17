# Memory Architecture R3

## Scope

R3 adds a reliable capture and review lifecycle without changing the R2 source
of truth: Markdown in `<stateDir>/memory-vault/` is canonical and SQLite/FTS is
a rebuildable projection. Raw transcripts, provider payloads, credentials, and
the extraction queue remain outside the Vault.

## Realm Contract

| Realm | Scope | Allowed memory types | Canonical path |
| --- | --- | --- | --- |
| `reality` | `global` | `user_fact`, `preference`, `goal`, `person`, `project`, `boundary` | `reality/memories/<id>.md` |
| `roleplay` | `character` | `relationship_event`, `world_fact`, `plot_event`, `boundary` | `roleplay/characters/<id>/memories/<id>.md` |
| `legacy` | `quarantine` | preserved historical type | `legacy/quarantine/<id>.md` |

The codec, service, HTTP adapters, Coordinator, and MCP schemas all enforce the
same partition. SMS extraction is reality-bound. RP extraction is bound to the
selected character and cannot write reality. Legacy/quarantine is management
only and is never retrieved or injected.

`reality/user-profile.md` is a compact, human-editable summary limited to 2000
Unicode code points. Confirmed reality memories are the durable fact store. A
managed block projects high-salience active reality facts into the profile after
confirmation, correction, conflict replacement, archive, or forget. Projection
preserves the manual section, escapes reserved managed-block markers in memory
text, removes stale managed lines, and runs in the same Vault checkpoint as the
memory transition. The Management UI and profile HTTP API expose the complete
document. Agent System context and Profile MCP expose only the manual section;
the Coordinator-owned managed block is never a second provider injection path.
Disabling
`userProfileWriteEnabled` stops managed projection without disabling durable
reality memory.

## Capture Jobs

Every completed user/assistant turn creates one idempotent SQLite job record or
one recorded skip. The job references the bounded `context_log_summaries` row;
it does not copy the transcript into the Vault.

- `explicit`: a current user message beginning with a supported remember or
  forget command. The backend treats this message as authorization evidence.
- `durable_signal`: conservative lexical evidence of a durable reality or RP
  fact. This invokes the extractor and creates pending candidates only.
- `none`: no extractor call; the job records `no_durable_signal` and zero input
  token estimate.
- disabled module: the job records `module_disabled`; queued or in-flight work
  is skipped before any memory write.

Jobs persist status, trigger/reason, attempt count, token estimate, duration,
result count, and bounded error text. Interrupted `running` jobs return to
`pending` on startup. Failed jobs require a trusted manual HTTP/UI retry, which
avoids invisible metered retry loops. Candidate idempotency keys derive from the
source turn and candidate index, so restart and retry do not duplicate files.
Disposal fences the asynchronous worker before every post-extractor repository
or lifecycle operation. An in-flight job remains `running` in SQLite and is
recovered to `pending` by the next process instead of touching a closed database.

The production extractor creates a separate OpenAI-compatible model invocation
from stored model configuration. It never calls `PiSessionRuntime.getOrCreate`
or mutates a live `AgentSession`. Its stable system prompt has no tools; the
single current turn is quoted as untrusted data with trusted realm, mode,
character, session, and message metadata. Output must be strict JSON. Unknown
keys, `confirmed`, cross-realm types, invalid JSON, excessive output, and source
turns above the configured bounds fail the job before any candidate write.

## Trust And Lifecycle

Model and ordinary MCP paths expose `search_memory` and optionally
`propose_memory`. Proposal schemas contain no confirmation field and always
write `pending`, `confirmed=false`. They expose no confirm, reject, archive, or
delete tool.

Only these paths activate memory:

1. The backend verifies an explicit remember command in the current user
   message and stores `explicit_user_authorization` with source session/message.
2. The loopback UI/HTTP control plane confirms a pending candidate or creates a
   manual fixed memory and stores `trusted_control_plane` provenance.

Confirmation with an active same-realm/same-character key supersedes the old
document in one Vault checkpoint and returns the old/new content diff. Editing
an already active memory always creates a replacement ID and supersedes the old
document, including a content-only generic PATCH. R2 schema-1 confirmed memory
is upgraded deterministically to `trusted_control_plane` provenance using its
original update time and source message; it is never labeled explicit-user.

`rejected`, `archived`, `superseded`, and `deleted` documents remain as audit
state but are absent from FTS injection queries. Forget is a soft delete with a
timestamp and reason. RP dialogue cannot authorize reality forget because the
Coordinator searches only its job-bound realm and character.
An explicit forget that matches more than one active memory is rejected as
ambiguous before any transition; the user must select one item in Memory
Management. A single match uses the normal checkpointed lifecycle transition.

All multi-document transitions and managed-profile updates use one in-process
Vault checkpoint plus one SQLite transaction. A parse, CAS, preflight,
projection, or projection-state failure restores the canonical files and leaves
the previous projection usable.

## Module And Permissions

`mcp:memory-coordinator` is enabled by default. Disabling it stops extraction,
memory context injection, and both Agent memory tools while preserving Vault
data and control-plane management.

Agent proposal permissions default to false and are independent:

- `realityMemoryWriteEnabled`: SMS/reality `propose_memory`;
- `characterMemoryWriteEnabled`: selected-character RP `propose_memory`.

`userProfileWriteEnabled` controls manual Agent profile replacement and managed
reality projection. `characterSoulWriteEnabled` controls SOUL only. None of
these permissions implies memory confirmation or deletion.

## Provider And Cache Contract

System contains only stable mode policy, module/permission status, SOUL, and the
bounded profile manual section. Exact local time, current scene, retrieved
confirmed reality memory, and selected-character continuity are emitted in the hidden
`rp-agent/turn_context` custom message. Profile, SOUL, scene, and memory bodies
inside these trusted runtime envelopes remain untrusted quoted data and cannot
change permissions or realm rules.

The managed profile projection is for human inspection and deterministic
maintenance, not provider context. When Memory Coordinator is enabled, selected
active reality memories appear once through turn retrieval. When disabled,
neither turn retrieval nor the managed block enters any provider request, while
the full Vault profile remains visible in Management.

Only active confirmed memory is eligible. SMS can receive confirmed global
reality and current-character continuity; RP receives confirmed global reality
plus only the selected character. Pending, rejected, archived, superseded,
deleted, legacy, and other-character documents never enter provider payloads.
Pi persists `user -> custom -> assistant`, preserving the prior provider request
as the next request's complete message prefix while volatile time changes leave
the stable System hash unchanged.

## Obsidian Sync

Application writes use whole-document revision/hash CAS. An unsynchronized
frontmatter or body edit cannot be overwritten. Safe profile, scene, SOUL, and
memory reads validate changed Vault documents, normalize revision/body hash,
rebuild the projection, and record `memory_vault_auto_sync` with paths and
counts but no body text. The Sync button performs the same validation
immediately and records `memory_vault_sync`. Invalid YAML, path placement,
duplicate IDs, symlinks, or projection references fail without advancing the
projection.

## HTTP Surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/memory-coordinator/status` | Module state, queue count, 24h token estimate, recent jobs |
| GET | `/api/v1/memory-coordinator/memories` | Filterable lifecycle management list |
| POST | `/api/v1/memory-coordinator/jobs/<id>/retry` | Trusted retry of a failed job |
| POST | `/api/v1/reality-memories` | Trusted manual reality memory creation |
| POST | `/api/v1/memories` | Trusted character-memory creation only |
| PATCH | `/api/v1/memories/<id>` | Confirm pending or superseding correction based on server state |
| POST | `/api/v1/memories/<id>/{confirm,correct,reject,archive,forget}` | Explicit lifecycle actions |

The Management memory tab exposes realm/character/status filters, source IDs,
manual creation, confirmation, edit-and-confirm, rejection, archive, forget,
job metrics, and retry. It uses the application dialog on desktop and mobile.

## Current Limits

- Trigger classification is conservative Chinese/English lexical policy rather
  than a learned classifier. Unsupported phrasings may require manual pinning.
- Explicit forget uses bounded lexical retrieval; several similar matches fail
  closed and require UI selection, while no match records a zero-result job.
- Profile projection is deterministic extractive text, not a model-generated
  abstractive summary; facts that do not fit remain available through reality
  retrieval.
- The Coordinator processes bounded jobs in one process. There is no distributed
  worker lease or cross-process Vault writer lock.
- Multi-file rollback protects handled failures, but R2's lack of a filesystem
  journal still leaves a process/power-loss window between renames.
