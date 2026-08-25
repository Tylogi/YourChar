# Character-owned Skills and collaboration

Status: implemented
Last updated: 2026-08-21

## Product model

YourChar treats a character as an identity plus a collection of concrete,
versioned Skills. There is no separate fixed-capability taxonomy, inferred duty
profile, automatic-duty switch, or single character workbench Skill.

Each character has:

- a public collaboration introduction;
- a small list of public traits;
- a maximum concurrent-task limit;
- zero or more character-owned Skill packages in each conversation space.

The introduction and traits help another character decide whom to ask. They do
not grant authority. A Skill describes how its owner performs a particular kind
of work; it also does not grant authority.

## Character-owned Skills

A package has public routing metadata and a private instruction body:

- public: ID, name, description, tags, active version, execution count and
  aggregate quality;
- owner-only: Skill Markdown, version history, evaluations and pending
  improvement proposals.

Normal and secret packages are stored and selected independently. A normal
agent cannot discover or read a secret package. A task receives at most three
explicitly selected Skill bodies, all owned by the target character and all
from the task's conversation space.

The direct conversation with a character may use that character's active
Skills. Social/contact exchanges between characters do not receive Skill
bodies. A delegated collaboration receives only the selected packages.

## Routing and collaboration

Automatic routing is Skill-only. The caller supplies one to three public Skill
IDs; the Coordinator considers other characters in the same world and checks:

- ownership and active version of every requested Skill;
- configured model availability;
- current availability and concurrency;
- prior results for the selected Skill versions;
- a small relationship adjustment, never large enough to replace competence.

An explicit target may be asked without naming a Skill. This preserves natural
requests such as “ask Mayuri”. The target may decline. If the caller explicitly
names a Skill, that Skill must belong to the target.

The public directory exposes collaboration introduction, traits and bounded
Skill metadata. It never exposes Skill Markdown, SOUL, private memories,
private chats, model configuration, credentials or tool permissions.

## Execution and improvement

The target runs the task in the isolated character-channel actor. The result is
returned through the persistent collaboration channel and later reported to
the source character.

For each selected Skill, the Coordinator records the exact version, outcome,
optional score and bounded result summary. When auto-improvement is enabled,
the character may propose a revised immutable version. A proposal is never
activated silently; approval through the trusted local control plane is
required.

When an explicitly selected character completes useful work without a matching
Skill, it may draft a new disabled Skill from that experience. The user reviews
its name, description, tags and Markdown before enabling it. This is how a
character's specialization can grow without a global capability vocabulary.

```text
task result
  -> evaluation for the exact selected Skill version
  -> bounded reflection
  -> pending improvement proposal
  -> explicit approval
  -> new active version
```

Duplicate task IDs cannot create duplicate evaluations, proposals or versions.
Changing one package does not invalidate unrelated character conversations or
other packages.

## Permission boundary

Skills are instructions, not permissions. Text in a Skill can never enable a
tool, network, shell, workspace write, memory write, schedule write or access
to another conversation.

The effective authority remains the intersection enforced by trusted runtime
code:

```text
runtime allowlist
  ∩ globally enabled modules
  ∩ configured backing services
  ∩ Agent permissions
  ∩ task-specific approval
```

The current character-channel actor deliberately has no shell or general MCP
tool access. Per-character tool permission switches, if added later, must be a
separate trusted policy layer and must not be derived from Skill Markdown,
tags, introduction or traits.

## Persistence and migration

Schema 41 introduced:

- `character_owned_skill_packages`;
- `character_owned_skill_versions`;
- `character_owned_skill_evaluations`;
- `character_owned_skill_proposals`.

Schema 42 introduces `character_collaboration_profiles` and removes the old
duty/capability/single-Skill tables. During the one-time migration:

- the former public-role text becomes the collaboration introduction;
- the former concurrency limit is retained;
- an active legacy single Skill becomes one owned compatibility package, but
  only when that character and space do not already contain owned packages;
- fixed capability rows, evidence and legacy Skill history are then removed.

Migration is transactional and idempotent. Existing multi-Skill packages,
versions, evaluations and proposals are preserved.

## HTTP API

Collaboration profile:

- `GET /api/v1/characters/:id/collaboration-profile`
- `PATCH /api/v1/characters/:id/collaboration-profile`

Owned Skills:

- `GET|POST /api/v1/characters/:id/owned-skills`
- `PATCH /api/v1/characters/:id/owned-skills/:skillId`
- `GET|POST /api/v1/characters/:id/owned-skills/:skillId/versions`
- `POST /api/v1/characters/:id/owned-skills/:skillId/versions/:versionId/activate`
- `GET /api/v1/characters/:id/owned-skills/:skillId/review`
- `POST /api/v1/characters/:id/owned-skills/:skillId/proposals/:proposalId/approve`
- `POST /api/v1/characters/:id/owned-skills/:skillId/proposals/:proposalId/reject`

Routing preview:

- `POST /api/v1/character-task-routing/preview`

All mutations use the local control-plane guard. Secret-space requests must
also carry and pass the existing owner/space scope checks.

World MCP exposes compact public Skill metadata and accepts
`requiredSkillIds`. Only the selected target receives the selected bodies.

## UI

The character manager's `协作与技能` page contains:

- editable collaboration introduction, traits and concurrency;
- owned Skill cards with status and execution quality;
- creation/editing of Skill metadata and Markdown;
- immutable version history;
- evaluation summaries;
- explicit review and activation of improvements.

The old inferred-duty controls, fixed capability checkboxes, module bindings,
automatic-management switch and single-Skill history are intentionally absent.
