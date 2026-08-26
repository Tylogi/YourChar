# Character-owned Skills and collaboration

Status: implemented
Last updated: 2026-08-26

## Product model

YourChar treats a character as an identity plus a collection of concrete,
versioned Skills. There is no separate fixed-capability taxonomy, inferred duty
profile, automatic-duty switch, or single character workbench Skill.

Each character has:

- a public collaboration introduction;
- a small list of public traits;
- a maximum concurrent-task limit;
- zero or more character-owned Skill packages in each conversation space.

A character may also have private Pi-compatible Agent Skill packages. These are
an extension layer, not collaboration/routing metadata, and are stored and
enabled separately from character-owned workflows.

The introduction and traits help another character decide whom to ask. They do
not grant authority. A Skill describes how its owner performs a particular kind
of work; it also does not grant authority.

## Two Skill layers

The product uses “Skill” for two related but non-interchangeable objects:

| Layer | Used for | Shape | Review and activation |
|---|---|---|---|
| Character-owned workflow | A character's specialization, task routing, evaluation, and self-improvement | Versioned Markdown plus name, description, and tags | Character output is always an inactive draft/proposal; only the local user activates a version |
| Agent Skill package | Pi procedural guidance available during model work | One direct `SKILL.md` plus optional verified resource files | Shared packages use global space switches; private packages are installed and enabled for exactly one character and one space |

Neither layer adds tools or permissions. “Owned” in the first row means the
workflow belongs to the character's workbench; “private” in the second means a
package is excluded from every other character and conversation space.

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

Draft packages and draft versions do not enter task routing or active prompt
context. They remain visible in the owner's review workbench until the user
activates a version.

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

## Character self-management MCP

The persisted `characterSkillManageEnabled` Agent permission defaults off. When
the user enables it, a character-bound MCP is attached to non-incognito
character sessions. It can list/read only that character's workflows in the
current `normal` or `secret` space, create a new inactive workflow draft, and
create an inactive `character_created` draft version. The server hard-codes the
owner, space, creator/source, and `activate: false`; none are model arguments.

The same MCP can search metadata for shared Skills enabled in the current space
and all private packages installed for that character and space. Private search
results include enabled and integrity state, so the character can maintain or
try to re-enable its own collection; only enabled, verified packages enter
model Skill context, and enabling an integrity-failed package is rejected. The
MCP can also toggle an installed private package and request a remote
private-package review. A remote URL must occur verbatim in the current user
message. The role receives only review ID, name, description, digest, file
count, and expiry; complete `SKILL.md`, source provenance, manifest, and paths
stay out of model tool results and audits.

The pending package remains in a short-lived private quarantine. The character
manager shows the trusted local user its source, resolved commit when
applicable, archive and manifest digests, complete manifest, and complete
`SKILL.md`. Confirmation is a local-control-plane action bound again to
character, space, stage ID, and digest. The MCP deliberately has no
confirmation, activation, global install, permission-edit, update, or uninstall
tool.

Installed private packages preserve all reviewed resource files under their
scoped package root. Only enabled, manifest-verified packages are loaded. Their
resources can be read through the ordinary bounded Skill `read` tool, but
installation never executes package code, hooks, scripts, or binaries.

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

The management permission authorizes only the fixed character MCP surface. It
does not imply shell network permission, Workspace access, global module
control, or local confirmation. Turning it off removes management tools but
does not silently disable already enabled private Agent Skills or deactivate
active owned workflows.

The current character-channel actor deliberately has no shell or general MCP
tool access. Per-character tool permission switches, if added later, must be a
separate trusted policy layer and must not be derived from Skill Markdown,
tags, introduction or traits.

## Conversation and child-runtime boundaries

Character-owned workflows, private Agent Skill rows, installed bytes, review
stages, mutations, and audits are keyed by both character and conversation
space. Normal-space code cannot list or read secret-space objects. Secret audit
actions carry the character as secret owner. A private Agent Skill may share a
name across characters or spaces, but it may not collide with a shared Agent
Skill; both installation orders reject the collision.

Incognito is normal-space only. It receives a frozen tmpfs snapshot of the
selected character's effective normal workflows and enabled Agent Skill
packages/resources, while the package service, installer, reflection worker,
and character-management MCP are absent. It cannot stage, confirm, toggle, or
activate Skills, and all snapshot changes are discarded.

Generic delegated subagents receive no character-management MCP or local
control-plane path. They may use effective enabled Agent Skills and read their
resources in the parent character/space scope, read-only. Character-owned
workflow bodies are not automatically injected into the generic subagent.
Delegation therefore cannot broaden authority or cross ownership boundaries.

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

Schema 47 adds `character_agent_skill_packages`. The primary key is
`(character_id, conversation_space, name)`; package provenance, manifest,
digests, enablement, and timestamps live in SQLite, while reviewed package
bytes live under a character-ID hash and space below
`<stateDir>/character-agent-skills/`. Integrity is recalculated against the
stored manifest before a package is exposed. Export includes scoped package
metadata and verified `SKILL.md`; complete user-data deletion removes package
rows and the owned package tree. Operational backup and restore preserve the
complete package resource tree and verify its manifest declaration; JSON export
does not replace that resource-preserving backup.

Review stages are intentionally process-local and expire after ten minutes, so
they do not survive restart. A character may hold at most four pending reviews
and twelve installed private packages in one space. The current lifecycle has
no in-place update, overwrite, or individual uninstall; an existing name is
rejected and the supported reversible operation is enable/disable.

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

Private Agent Skill packages:

- `GET /api/v1/characters/:id/skill-packages`
- `GET /api/v1/characters/:id/skill-packages/:name`
- `POST /api/v1/characters/:id/skill-packages/:name/review`
- `PATCH /api/v1/characters/:id/skill-packages/:name`
- `GET /api/v1/characters/:id/skill-package-stages`
- `GET /api/v1/characters/:id/skill-package-stages/:reviewId`
- `POST /api/v1/characters/:id/skill-package-stages/:reviewId/review`
- `POST /api/v1/characters/:id/skill-package-stages/:reviewId/confirm`
- `POST /api/v1/characters/:id/skill-package-stages/:reviewId/cancel`

Routing preview:

- `POST /api/v1/character-task-routing/preview`

All mutations use the local control-plane guard. Full package/stage review reads
use the same guard because they contain source URLs, manifests, and Markdown;
ordinary GET inventory is redacted. Secret-space requests must also carry and
pass the existing owner/space scope checks.

World MCP exposes compact public Skill metadata and accepts
`requiredSkillIds`. Only the selected target receives the selected bodies.

## UI

The character manager's `协作与技能` page contains:

- editable collaboration introduction, traits and concurrency;
- owned Skill cards with status and execution quality;
- creation/editing of Skill metadata and Markdown;
- immutable version history;
- evaluation summaries;
- explicit review and activation of improvements;
- installed private Agent Skill summaries and integrity state;
- full local review of pending source, digest, manifest, and `SKILL.md` before
  confirmation;
- enable/disable controls for the selected character and space.

The old inferred-duty controls, fixed capability checkboxes, module bindings,
automatic-management switch and single-Skill history are intentionally absent.
