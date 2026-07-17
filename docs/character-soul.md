# Character SOUL.md

## 1. Purpose

Each RP character has one static identity document at:

```text
<stateDir>/memory-vault/roleplay/characters/<characterId>/SOUL.md
```

The format is inspired by OpenClaw's `SOUL.md` responsibility and section model:
core truths, boundaries, vibe, and continuity. RP Agent adapts that model for
fictional characters and keeps dynamic state out of the file.

`SOUL.md` answers "who is this character?" Current scene and confirmed long-term
memory answer "what is happening and what has happened?" Mixing those concerns
would make the base character drift whenever a scene changes.

## 2. Contract

- Character name remains SQLite metadata for selectors and references.
- All other static character definition belongs in `SOUL.md`, including identity,
  values, voice, behavior, relationship baseline, boundaries, and narration style.
- The document is limited to 8000 Unicode code points.
- Writes normalize CRLF to LF, atomically replace the file, set file mode `0600`,
  and set the character directory to `0700`.
- The file is read when character context is assembled, so direct filesystem edits
  apply on the next RP turn.
- The browser and character HTTP API allow complete-document replacement.
- The Agent receives the document as authoritative context. It may rewrite the
  current character's SOUL only when the separate Character SOUL auto-edit
  permission is enabled and only through the character-bound MCP server.

The default template uses these sections:

1. Core identity
2. Core truths
3. Boundaries
4. Vibe and expression
5. Relationship with the user
6. Continuity

Headings are conventions rather than a parser schema. Users may reorganize the
Markdown freely as long as the document remains within the length limit.

## 3. Legacy migration

The original `characters` table columns remain because database migrations are
append-only. When an existing character has no SOUL file, RP Agent converts its
identity, voice, narrative perspective, behavior, relationship defaults, and
boundaries into Markdown, then writes the resulting file. New character writes no
longer use those legacy columns.

The R1 `<stateDir>/characters/<characterId>/SOUL.md` path remains a migration
mirror. Complete data deletion removes SQLite character rows, canonical Vault
documents, and the legacy mirror directory.

## 4. API

`CharacterProfile` returns:

- `id`
- `name`
- `soulMarkdown`
- `soulCharacterCount`
- `soulMaxCharacters`
- `createdAt`
- `updatedAt`

Create a character with `POST /api/v1/characters` and `{ "name", "soulMarkdown" }`.
Replace its document with `PATCH /api/v1/characters/{id}` and
`{ "soulMarkdown" }`. Over-limit writes return HTTP 400 with code
`CHARACTER_SOUL_INVALID`.

When Agent editing is enabled, an RP session bound to this character receives
`get_current_character_soul` and `update_current_character_soul`. SMS sessions
and RP sessions without a selected character never receive those tools.
