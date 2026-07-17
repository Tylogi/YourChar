# OKF Memory Compatibility

## Status

RP Agent supports Open Knowledge Format (OKF) v0.1 as an interchange format.
The internal Memory Vault remains the authoritative store. SQLite and FTS remain
derived indexes, and the existing realm, confirmation, lifecycle, durability,
and context-budget contracts are unchanged.

OKF support does not make imported text trusted. An imported document can only
be staged as a pending memory candidate and must pass the existing review and
confirmation flow before it can enter model context.

## Export

`GET /api/v1/memory-vault/okf/export` returns an OKF ZIP bundle. By default it
contains only active, confirmed, non-legacy memory documents. The following
query flags opt into additional sensitive documents:

- `includeProfile=1`
- `includeSouls=1`
- `includeScenes=1`

Every concept has a non-empty `type`, standard Markdown content, recommended
OKF metadata, and an `rp_agent` extension object. The extension preserves stable
RP Agent IDs and ownership metadata while the OKF concept ID remains the
bundle-relative file path. A generated root `index.md` provides progressive
disclosure and declares `okf_version: "0.1"`.

## Import

`POST /api/v1/memory-vault/okf/import/preview` accepts an OKF ZIP and returns
conformance issues plus a per-document mapping preview. It performs no writes.

`POST /api/v1/memory-vault/okf/import/stage` reparses the ZIP and creates only
the eligible documents as pending memory candidates. It never restores
`confirmed`, `validity`, provenance, source IDs, salience, or confidence from
the archive. Repeated imports are idempotent for the same archive, concept,
target realm, and character.

The optional query parameters are:

- `realm=auto|reality|roleplay`; default `auto`.
- `characterId=<id>`; required when a document is forced or mapped to roleplay.

In `auto` mode, an RP Agent export may supply a reality or roleplay realm in its
extension. Other OKF concepts default to reality. Only the following OKF types
can become memories:

- reality: `user_fact`, `preference`, `goal`, `person`, `project`, `boundary`
- roleplay: `relationship_event`, `world_fact`, `plot_event`, `boundary`

Type matching is case-insensitive and accepts spaces or hyphens in place of
underscores. Unknown OKF types are reported as unsupported. They are not
silently coerced into personal memory.

## Security Limits

- Compressed request: 5 MiB maximum.
- Extracted bundle: 10 MiB maximum.
- Concept count: 500 maximum.
- Individual archive entry: 512 KiB maximum.
- Importable memory body: 2,000 Unicode characters maximum.
- Absolute paths, parent traversal, NUL bytes, duplicate entries, invalid UTF-8,
  and unsupported ZIP compression are rejected. ZIP entries are parsed in
  memory and are never extracted to the filesystem, so archive links cannot be
  followed.
- Frontmatter and bodies remain untrusted data and cannot alter permissions,
  system prompts, realms outside the selected target, or tool authorization.

## Deferred Work

Unknown concept types need a separate read-only external knowledge catalog
before they can be retrieved safely. Native conversion of the authoritative
Vault to OKF is deferred while OKF remains an early draft; it would require a
versioned Vault migration and must preserve crash recovery and strict realm
contracts.
