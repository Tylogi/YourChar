# Legacy Group Chat Contract

Status: superseded and retired by World Conversation Mode
Last updated: 2026-07-20

This file remains only as a stable link for older development notes. Persistent
SMS/RP group chat is no longer a product feature and must not be used as the
basis for new work.

The replacement contract is
[`world-conversation-mode.md`](./world-conversation-mode.md).

## Retirement Decision

Ad hoc groups duplicated role identity, conversation history, participation
policy, and world continuity without a canonical event model. Standalone RP
sessions also split one character across multiple histories and made proactive
delivery ambiguous. The product now exposes:

- one canonical SMS private thread per character;
- one shared third-person timeline per world;
- a world-level Director model;
- each selected character's own actor model and SOUL.md;
- a world-level post-turn Analyzer for events, runtime, observations, and
  character-to-character relationships.

## Upgrade Behavior

Migration 26 deletes all rows rooted at `group_chats`; membership, turns,
messages, and decisions are removed by foreign-key cascade. Legacy standalone RP
sessions are purged by the session runtime during startup. Neither source is
migrated or merged into World timelines.

Confirmed character memory remains character-owned and is not rewritten merely
because its original source conversation was retired.

## Compatibility Boundary

Some legacy group repository, service, and HTTP code may remain temporarily to
avoid a high-risk unrelated deletion. It is unreachable from the visible UI,
must not create new records in supported workflows, and may be removed in a
later cleanup after export/test compatibility is audited.

Release tests must assert:

- no group/RP option appears in the new-conversation dialog;
- no legacy group record survives schema-26 migration;
- the sidebar contains only Worlds and canonical Characters sections;
- batch management ignores World timelines;
- all new multi-character behavior uses the World pipeline.
