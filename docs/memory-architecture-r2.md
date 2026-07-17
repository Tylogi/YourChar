# Memory Architecture R2

> Historical R2 contract. The current normative behavior is documented in
> [`memory-architecture-r3.md`](memory-architecture-r3.md), including reality
> memories, automatic safe-read sync, and the persistent Coordinator.

## Status

R2 makes `<stateDir>/memory-vault/` the human-readable source of truth for the
global user profile, character SOUL documents, roleplay scenes, and long-term
memory. The directory can be opened directly in Obsidian. SQLite `scene_states`,
`rp_memories`, and `rp_memories_fts` are disposable projections.

R2 does not add a model post-turn extractor. Model `write_memory` proposals
remain character-bound and pending, and explicit confirmation remains a trusted
UI/API operation under the R1 realm contract.

## Physical Boundary

```text
<stateDir>/memory-vault/
  README.md
  reality/user-profile.md
  roleplay/characters/<id>/SOUL.md
  roleplay/characters/<id>/memories/<id>.md
  roleplay/scenes/<sessionId>.md
  legacy/quarantine/<id>.md
  archive/
```

The Vault contains no SQLite database, credentials, provider payloads, Pi state,
or transcripts. Projection and migration bookkeeping are adjacent to, but not
inside, the Vault:

```text
<stateDir>/memory-vault-state.json
<stateDir>/memory-vault-migration.json
```

Directories are mode `0700`; generated Markdown and state files are mode `0600`.
Writes use a same-directory temporary file followed by rename. Identifiers,
resolved paths, every existing path component, and recursive scans reject parent
escape and symbolic links.

## Document Contract

Every fact document has strict YAML frontmatter parsed with `yaml`, followed by
a free-form Markdown body. Unknown, missing, duplicate, or kind-incompatible
keys fail the entire read or rebuild.

The fixed frontmatter order is:

```text
schemaVersion, id, kind, realm, scope, type, characterId, sessionId,
validity, confirmed, sourceSessionId, sourceMessageId, createdAt, updatedAt,
lastUsedAt, revision, supersedes, tags, quarantineReasons, contentHash,
memoryKey, salience, confidence, idempotencyKey, scene
```

Nullable fields are emitted as `null`; arrays are always emitted. Timestamps are
canonical UTC ISO strings. Tags and quarantine reasons are deterministically
deduplicated and sorted. `contentHash` is the SHA-256 of the normalized Markdown
body. The projection state additionally records the SHA-256 of each complete
Markdown file.

For scene documents, location, in-world time, participants, objective, and open
threads are structured under `scene` in frontmatter. The scene summary exists
only in the Markdown body, avoiding two competing sources for the same fact.

## CAS And Obsidian Edits

Application writes compare both `revision` and the last explicitly synchronized
whole-document hash. Therefore a frontmatter-only or body-only Obsidian edit
cannot be silently overwritten by an API, UI, MCP, scene, SOUL, or memory write.
The direct profile/SOUL read reflects an external body edit immediately, while
an explicit Vault Sync validates the complete Vault, normalizes body hash and
revision where needed, rebuilds SQLite, and advances the whole-document hash
baseline. A conflict returns `MEMORY_VAULT_CAS_CONFLICT` and HTTP 409.

Multi-document memory correction uses a Vault checkpoint. A second-file or
projection failure restores every canonical Markdown file from the checkpoint;
the SQLite transaction independently rolls back. Atomic rename protects each
file, but R2 does not provide a filesystem journal for process or power loss
between multiple renames. A subsequent status/sync detects such divergence.

## Projection Contract

Rebuild performs these steps:

1. Parse every fact document and reject invalid YAML, wrong placement, duplicate
   IDs, unknown character/session references, invalid supersede links, and
   duplicate memory idempotency keys.
2. Begin one `IMMEDIATE` SQLite transaction.
3. Delete the old scene, memory, and FTS projections.
4. Insert scenes and memories in deterministic ID order and restore inverse
   `superseded_by_id` links.
5. Commit, then atomically advance `memory-vault-state.json` with the Vault hash,
   per-document hashes, count, and rebuild time.

Any insert or FTS failure rolls back to the previous complete projection and
does not advance projection state. Legacy documents project with a null SQLite
character ID so the R1 compatibility mapper continues to expose them as
`legacy/quarantine`. They are never returned by roleplay retrieval.

## Migration Contract

The first R2 startup captures the R0/R1 profile file, character SOUL files,
scenes, and every SQLite memory validity state. It preserves IDs, content,
realm/scope derivation, source session/message, timestamps, last-use time,
confirmation, idempotency keys, tags, salience/confidence, quarantine reasons,
and supersede relationships.

Dry-run emits deterministic `create`, `unchanged`, or `preserve_vault` actions.
Apply writes an `in_progress` manifest before files, records each completed ID,
and is safe to rerun after interruption. Existing divergent Vault content is
never replaced by an older source. A completed manifest prevents deleted Vault
documents from being recreated from stale SQLite on restart.

The old `<stateDir>/user-profile.md` and `<stateDir>/characters/<id>/SOUL.md`
paths remain write-only compatibility mirrors for R1 backup consumers. Runtime
reads and all canonical writes go through the Vault.

## Realm And Cache Contracts

R1 realm enforcement remains unchanged:

- `reality/global` user facts, preferences, goals, and boundaries belong only
  to User Profile.
- New `roleplay/character` memory accepts only `relationship_event`,
  `world_fact`, `plot_event`, and `boundary`.
- Historical null-character or profile-type memory is exported as
  `legacy/quarantine` and is never injected.
- Model proposals cannot set `confirmed`; trusted UI/API flows can.

Provider payload assembly reads only the profile, SOUL, scene, and selected
memory Markdown bodies. Vault paths, frontmatter, migration/projection state,
and quarantined bodies are not sent. Stable System and hidden volatile
`rp-agent/turn_context` placement continue to follow the R1 cache contract.

## Operations And API

The Settings view shows the Vault path and sync state and provides Sync and
Rebuild controls. HTTP endpoints are:

| Method | Path |
| --- | --- |
| GET | `/api/v1/memory-vault/status` |
| GET | `/api/v1/memory-vault/documents` |
| POST | `/api/v1/memory-vault/sync` |
| POST | `/api/v1/memory-vault/rebuild` |
| POST | `/api/v1/memory-vault/migration/dry-run` |
| POST | `/api/v1/memory-vault/migration/apply` |

Document listing exposes metadata and hashes, not Markdown bodies. Operational
backup and restore copy the complete Vault plus both state files byte-for-byte;
the backup command verifies every copied document against the copied projection
hash map and asks the operator to retry if the Vault changed during copying.
SQLite still uses its online backup API. Delete-all removes all fact documents
and projection/migration state, then recreates an empty safe Vault layout.

## Current Limits

- Character names and role-session bindings remain authoritative SQLite
  metadata; only SOUL, scene, profile, and memory facts are Vault-sourced.
- R2 assumes one application writer. SQLite serializes projection rebuilds, but
  there is no cross-process filesystem lease for two RP Agent processes sharing
  one state directory.
- Obsidian must preserve the strict frontmatter schema. Invalid YAML blocks sync
  without replacing the previous projection.
- Archive is a reserved physical area; no automatic retention policy moves
  documents into it yet.
- A later round may add a trusted extraction/review queue, filesystem journaling
  for crash-atomic multi-file commits, and richer conflict resolution. Those
  changes must preserve the realm, cache, and rebuild contracts above.
