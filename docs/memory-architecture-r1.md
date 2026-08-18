# Memory Architecture R1

> Historical R1 contract. The current normative behavior is documented in
> [`memory-architecture-r3.md`](memory-architecture-r3.md). Tool names and the
> reality-memory source-of-truth model below describe the earlier round.

## Status

R1 establishes enforceable realm and prompt-cache contracts around the existing
Markdown user profile and SQLite RP memory store. SQLite remains the RP memory
source of truth in this round. The Obsidian-compatible Vault becomes the human
readable source of truth in the next migration round.

## Realm Contract

| Data | Realm | Scope | Owner | Write path |
| --- | --- | --- | --- | --- |
| Real user identity, preferences, goals, and boundaries | `reality` | `global` | User Profile | Trusted UI/API or the separately permissioned User Profile MCP module |
| Character relationship, fictional facts, plot, and continuity | `roleplay` | `character` | RP Memory | Character-bound trusted API/UI writes or pending `write_memory` proposals |
| R0 rows without a character, or rows using profile-only memory types | `legacy` | `quarantine` | Compatibility view | Management, export, correction, and deletion only; never model context |
| Current RP location, participants, objective, and open threads | `roleplay` | Session scene | Scene service | Character-bound scene API/tool flow |

`write_memory` is not a user-profile writer. Its tool schema has no `confirmed`
field, requires a selected character, fixes `realm=roleplay` and
`scope=character`, and always calls the pending proposal path. Extra model
arguments cannot promote a proposal to active memory. Explicit confirmation is
a trusted application operation: the memory UI/API may create a confirmed
record by explicitly sending `confirmed=true`, or update a pending record.
Omitting `confirmed` from an API create leaves the record pending. The service validates realm, scope, and
character binding even when callers bypass the HTTP layer.

New roleplay memory accepts only `relationship_event`, `world_fact`,
`plot_event`, and `boundary`. `user_fact` and `preference` are profile-only
semantics and are rejected by the model tool schema, UI, HTTP API, and service.

The current SQLite schema does not yet persist separate realm/scope columns.
Those values are enforced and materialized by the RP service/repository contract.
Existing rows with `character_id IS NULL`, plus historical character rows with
profile-only types, are deterministically exposed as `legacy/quarantine` without
rewriting SQLite. Their original type, character ID if any, validity, content,
links, and timestamps remain available for list, export, correction, deletion,
backup, and restore. Role-context queries require `realm=roleplay`, a character,
and an allowed RP type, so quarantined rows cannot be injected. This derived view
is idempotent and rollback-compatible because no data migration is applied.

## Cache Contract

The provider request is split into a stable prefix and a volatile turn suffix.

Stable System content:

- SMS/RP mode rules and real-world mutation policy
- realm and runtime trust contracts
- User Profile and selected character `SOUL.md`
- stable module, permission, search, and workspace capability state

Volatile `rp-agent/turn_context` content:

- current time
- selected character and conversation mode
- current scene
- query-selected confirmed RP memories

The Pi `before_agent_start` extension returns both the stable System override and
a hidden custom message. This uses Pi's native lifecycle; no provider payload is
rewritten. Pi persists each normal turn as
`user -> rp-agent/turn_context -> assistant`. Consequently the second provider
request retains the first request's complete message prefix, including its old
turn context, and appends the new turn after the first assistant response.

The System override is built directly from YourChar's stable inputs so Pi's
automatically generated wall-clock date is not included. Tests hash consecutive
System messages and calculate the provider-message longest common prefix.

Time uses one compact line on every model-backed turn as the current low-cost
policy. It contains an IANA timezone local timestamp and UTC timestamp, both
truncated to minute precision. Seconds and milliseconds are excluded. A future
intent classifier may omit this line for turns that provably cannot depend on
time, but must preserve the same suffix placement.

## Trust And Visibility

The `rp-agent/turn_context` envelope and the runtime's selection of its fields are
trusted runtime data. Profile, SOUL, scene, memory, search result, tool output,
and user-authored text quoted inside either System or turn context remain
untrusted data. They cannot alter permissions, realm ownership, tool
authorization, or higher-priority rules.

Turn context is stored with `display=false`. The conversation API filters hidden
custom messages, the session list counts only visible messages, and the browser
client independently discards any hidden custom message. Internal session and
provider context still retain it for continuity and cache-prefix stability.

## Restart And Compaction

Pi session JSONL persistence retains custom turn-context entries across process
restart. Compaction may replace old transcript ranges with a trusted continuity
checkpoint, while recent hidden turn contexts remain ordinary session messages.
After compaction and restart, the next turn receives current confirmed character
memory in a fresh turn context; volatile memory and time do not move back into
System.

## Current Limitations

- SQLite is still the RP memory source of truth and cannot yet be rebuilt from a Vault.
- Realm and scope are enforced in code rather than stored as migrated database columns.
- Legacy quarantine is derived from old columns and has no persisted review/disposition metadata yet.
- Query retrieval is lexical and has no embedding index or provenance revision tracking.
- Model proposals remain pending until a trusted application flow confirms them; there is no automatic post-turn extractor.
- Hidden turn contexts consume transcript tokens and eventually participate in compaction.
- Actual provider cache reuse still depends on the provider's cache policy; R1 proves payload-prefix eligibility.
- HTTP confirmation trusts the deployment's existing API access boundary; R1 does not add per-actor authentication or confirmation provenance.

## R2 Vault Plan

1. Define an Obsidian-compatible Vault layout with YAML frontmatter IDs, realm,
   scope, character ID, status, source, timestamps, and revision metadata.
2. Export existing User Profile and RP memory into atomic Markdown files while
   preserving SQLite IDs and recording a migration checkpoint.
3. Make Vault Markdown the authoritative write target and rebuild SQLite tables,
   FTS data, and future embedding indexes from validated documents.
4. Add reconciliation for external Obsidian edits, duplicate IDs, invalid
   frontmatter, deleted files, and concurrent application writes.
5. Add backup/restore and deterministic rebuild tests before removing SQLite as
   an authoritative memory store.
