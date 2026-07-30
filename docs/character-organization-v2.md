# Character Organization and Specialist Workbench V2

Status: V2.0 routing and V2.1 character-owned Skill baseline implemented
Audience: product, architecture, implementation, security, and test agents
Last updated: 2026-07-24

## 1. Goal

RP Agent should support a group of characters that remain believable people
while also becoming useful specialists. A character may be good at research,
planning, software work, writing, coordination, or another bounded capability.
Tasks should naturally flow to the right character without loading every Skill,
MCP schema, and permission into every conversation.

The target is not an unbounded society of recursively spawning agents. It is a
small, inspectable organization with:

- one stable private-chat identity per character;
- one bounded, versioned `SKILL.md` per character;
- a trusted background Coordinator for routing and lifecycle control;
- persistent character-to-character channels for visible collaboration;
- evidence-based improvement proposals with explicit evaluation gates;
- strict intersections between declared capability, enabled modules, configured
  services, and granted permissions.

## 2. Product Contract

### 2.1 Character identity and utility stay separate

`SOUL.md`, relationship state, world state, and memories describe who the
character is. A functional profile describes what work the character is willing
and able to take.

Improving a capability must not silently rewrite `SOUL.md`, relationship state,
or private memories. Improving a relationship must not raise a technical skill
level. The two dimensions can influence style and willingness, but they have
different storage, evaluation, and permissions.

### 2.2 One character, two runtime shapes

**Conversation Runtime**

- used by the canonical one-to-one SMS conversation;
- stable prefix: system policy, character SOUL, world core, and stable tool set;
- optimized for personality continuity and KV-cache reuse;
- receives only coordination tools needed to talk to or delegate to peers;
- does not load every specialist Skill or tool schema.

**Specialist Workbench Runtime**

- used only for a routed task;
- stable key: `characterId + characterSkillVersion + modelProfileId`;
- receives the character identity, one task envelope, the compact functional
  profile, and that character's one active `SKILL.md`;
- has explicit model-call, time, output, and delegation limits;
- returns a typed result and evidence record to the Coordinator;
- does not inherit the character's private user-thread transcript.

The current implementation uses the isolated character-channel actor as the
execution foundation. The active Skill is loaded only for
`collaboration_result`; ordinary social/contact exchanges and private SMS do not
pay its token cost. The actor still has no bound MCP or shell tools.

### 2.3 Coordinator is trusted control plane

The Coordinator owns:

- candidate discovery inside the same world;
- deterministic eligibility checks and score calculation;
- concurrency and lifecycle limits;
- creation of task envelopes;
- result delivery and audit records;
- evaluation requests and capability-version activation.

The model may request a capability or explicitly name a character. It does not
write routing scores, grant permissions, activate modules, or promote itself.

## 3. Runtime and Cache Design

### 3.1 Stable private-chat prefix

Private SMS keeps a stable system/tool prefix. Volatile world position,
relationship snapshots, current time, and recent memory remain replaceable
runtime context. Character functional summaries are not injected on every
private-chat turn; the World MCP exposes a compact public directory only when
the model actually needs to choose a collaborator.

### 3.2 Stable character Skill

Dynamic per-task schemas would reduce KV-cache reuse. Workbench tools therefore
must not be assembled from arbitrary task-time lists. Each character instead
owns one coherent, versioned Skill that combines its current specialties.

```text
workbench key
  = character id
  + active Skill version
  + model profile id
  + global module generation
  + permission generation
```

A Skill change invalidates only matching workbench calls. It does not
invalidate unrelated character chats.

There is intentionally no Skill per capability. The fixed capability list is
small routing metadata; `SKILL.md` is the character's own reusable working
method. This keeps task behavior coherent and bounds prompt growth as the
character gains experience.

### 3.3 Bounded task envelope

The workbench receives:

```json
{
  "taskId": "durable id",
  "sourceCharacterId": "requesting character",
  "targetCharacterId": "selected specialist",
  "requiredCapabilityIds": ["research.web"],
  "objective": "bounded task statement",
  "context": "minimum non-private supporting context",
  "expectedResult": "result contract",
  "deadline": "optional instant",
  "delegationDepth": 0
}
```

No hidden prompt, full user transcript, unrelated profile data, or another
character's private memory is copied into the envelope.

## 4. Capability Model

Phase 1 uses a fixed registry:

| Capability ID | Meaning | Typical modules |
|---|---|---|
| `research.web` | live source discovery and page reading | Tavily, Web Reader |
| `research.analysis` | compare evidence and synthesize conclusions | research Skills |
| `software.debug` | diagnose software failures | workspace read, debug Skills |
| `software.implementation` | implement and verify scoped changes | workspace write, shell, coding Skills |
| `planning.schedule` | turn intent into feasible schedules | Schedule MCP |
| `organization.coordination` | split, route, and reconcile work | World State, Subagent |
| `communication.social` | interpersonal communication and mediation | World State, Relationship State |
| `creative.writing` | prose, dialogue, and editorial work | writing Skills |
| `creative.visual` | image interpretation and visual planning | Vision MCP |
| `world.knowledge` | reason about canonical places, events, and people | World State MCP |

Each character capability has:

- level `1..5`;
- assignment role `primary` or `support`;
- whether trusted automatic routing may select it;
- zero or more module bindings;
- short maintainer notes.

Capability source is either `inferred` or `manual`. Inferred entries also retain
a confidence score. Initial inference is conservative: at most one primary and
two support capabilities, with levels limited to `1..3`.

The character functional profile also has:

- public role;
- preferred task boundaries;
- avoided task boundaries;
- maximum concurrent specialist tasks (`1..5`).

Free-form text never grants a capability. Capability IDs come only from the
fixed registry.

By default, the character-bound model derives the public role, task boundaries,
capabilities, and initial Skill from `SOUL.md`. Editing the advanced functional
profile switches the character to manual maintenance. Later SOUL changes do not
silently overwrite a manual profile. Re-enabling automatic maintenance or
choosing re-analysis is an explicit overwrite boundary.

## 5. Routing

### 5.1 Automatic route

When the caller omits a target, it must provide one to three required capability
IDs. The Coordinator considers only other characters in the same world.

Hard eligibility checks:

- every required capability is declared and allows automatic assignment;
- the selected character model is configured;
- the character is not resting or traveling;
- active specialist work is below the character's concurrency limit.

Deterministic score order:

1. capability level;
2. primary versus support responsibility;
3. current availability and remaining capacity;
4. a deliberately small same-world trust/affinity adjustment;
5. stable character ID tie-break.

Competence dominates relationship. A close friend with the wrong capability
must not outrank a suitable specialist.

The route result includes all candidates, eligibility, score components,
warnings, and concise human-readable reasons. This supports UI previews,
debugging, and model-adaptation tests.

### 5.2 Explicit route

An explicitly selected same-world character remains supported for natural
requests such as "ask Mayuri." Capability gaps are reported as warnings rather
than silently rerouting the request. The target can still decline in character.

### 5.3 No keyword authority

Phase 1 does not infer capability from keyword regular expressions. The calling
Agent chooses fixed capability IDs through the MCP schema, or the user chooses
them through the control plane. A later bounded classifier may suggest IDs, but
the trusted registry validates its output.

## 6. Permission Boundary

Declared module bindings are routing metadata, not authority.

```text
effective workbench modules
  = character capability bindings
  ∩ globally installed modules
  ∩ globally enabled modules
  ∩ configured backing services
  ∩ runtime-mode allowlist
  ∩ Agent permissions
  ∩ task-specific approval requirements
```

Examples:

- binding `mcp:tavily-search` cannot use Tavily when the module is disabled or
  its API key is missing;
- binding a coding Skill cannot turn on shell access;
- workspace write remains limited to the configured workspace root;
- no capability may grant user-profile, SOUL, memory, or schedule write access;
- the world actor cannot perform real external work merely because a fictional
  role says it can.

Phase 1 exposes globally enabled bindings for inspection but does not execute
them in character-channel actors.

## 7. Persistence

Schema 30 introduced:

| Table | Purpose |
|---|---|
| `character_function_profiles` | public role, task preferences, avoided work, concurrency limit |
| `character_capabilities` | fixed capability, level, responsibility, auto-route flag, declared module bindings |
| `character_capability_evidence` | immutable task outcome and optional functional/judge scores |

Evidence is append-only and idempotent per task and capability. It is an audit
input, not an automatic promotion command.

Schema 31 adds:

| Storage | Purpose |
|---|---|
| profile inference fields | manual lock, status, SOUL hash, timestamps, bounded failure |
| capability source/confidence | distinguish inferred and manual declarations |
| evidence lesson | attach the reusable lesson selected by reflection |
| `character_skill_versions` | one immutable version history and one active Skill per character |

Existing non-empty schema-30 profiles are migrated as manually maintained, so
an upgrade never lets background inference overwrite previous user settings.
An inference left `pending` by process termination is reset and retried at
startup.

Future durable task tables will separate task lifecycle from the visible
character channel. The channel remains the social/audit projection, while a
task record owns retries, timeout, dependency, result, and cancellation.

## 8. Skill Improvement

Each character maintains one Skill. The role's bound model, not a global
hard-coded persona, writes the initial draft and later reflections.

Implemented lifecycle:

```text
SOUL.md
  -> conservative function inference
  -> initial SKILL.md v1
completed collaboration milestone
  -> role-model reflection over current Skill and bounded task result
  -> static safety checks
  -> activate a new immutable Skill version
  -> visible history and rollback
```

Reflection runs after completed-task counts `1`, `3`, `6`, `10`, then every
fifth completion. It may return no update. Duplicate task IDs cannot create
duplicate versions. A new version must be bounded Markdown and must not contain
permission, policy-bypass, secret, credential, or tool-authority claims.
Rejected output leaves the current version active.

The active Skill is procedural guidance only. It cannot modify `SOUL.md`, grant
MCP/shell/network/workspace access, expose another conversation, or claim an
action occurred. All authority still comes from the trusted module and
permission intersection.

Capability growth is derived from evidence rather than directly written by the
model. The routing level may gain a bounded adjustment only after repeated
successful evidence and later Skill versions; poor repeated outcomes can
temporarily reduce it. The configured base level remains available for audit.

The current baseline auto-activates statically valid reflections. A later
hardening phase should add:

- built-in functional and regression collections per capability;
- LLM-as-judge comparison against the previous version;
- latency and token-cost budgets;
- canary activation and risk-based user approval.

## 9. Character-to-Character Behavior

Collaboration and social life share one persistent pair channel but use separate
episode kinds.

- `social`: voluntary in-character conversation and relationship development;
- `collaboration`: one bounded task request and result;
- `contact`: one direct message and reply.

Social exchanges do not become task evidence. Collaboration evidence does not
automatically imply friendship. Both may settle into scoped world observations
and memories under the existing V1 rules.

V2.1 may allow a target to delegate once to another specialist. The default
maximum delegation depth is `1`; cycles, self-delegation, duplicate tasks, and
fan-out beyond the configured bound are rejected by the Coordinator.

## 10. API and MCP

Phase 1 control-plane API:

- `GET /api/v1/characters/:id/function-profile`
- `PUT /api/v1/characters/:id/function-profile`
- `POST /api/v1/characters/:id/function-profile/infer`
- `PATCH /api/v1/characters/:id/function-profile/automation`
- `GET /api/v1/characters/:id/skill-versions`
- `POST /api/v1/characters/:id/skill-versions/:version/activate`
- `POST /api/v1/character-task-routing/preview`

World MCP changes:

- `list_world_characters` includes only public role and bounded capability
  summaries, never SOUL, private task preferences, module bindings, model
  settings, private chat, or memory;
- `request_character_help.targetCharacterId` becomes optional;
- automatic routing requires `requiredCapabilityIds`;
- tool results report the actual selected character and route reasons.

Existing explicit-target calls remain compatible.

## 11. UI

The character manager's `职责能力` view defaults to the low-configuration path:

- automatic-maintenance state and explicit re-analysis;
- current public role and compact capability/level chips;
- evidence and active-version summary;
- complete Markdown rendering of the selected `SKILL.md`;
- selectable version history and rollback.

The following controls remain under collapsed `高级设置`:

- public role and task boundaries;
- concurrency limit;
- fixed capability rows;
- level, primary/support role, auto-route toggle;
- per-capability module bindings with enabled/disabled status;
- evidence counts and recent outcomes.

The UI never labels a bound module as granted. Runtime status must distinguish
declared, globally enabled, configured, and effective.

Future task UI should provide:

- organization queue;
- route explanation;
- task dependency and ownership;
- visible character-channel transcript;
- result and evaluation evidence;
- cancel, retry, reassign, and rollback controls.

## 12. Delivery Plan

### V2.0: capability and routing foundation

- schema 30 and typed fixed registry;
- profile/capability CRUD;
- deterministic same-world route preview;
- automatic `request_character_help` target selection;
- public capability directory;
- management UI and migration/security tests;
- task-outcome evidence baseline.

### V2.1: character-owned Skill baseline

- SOUL-based automatic function initialization;
- one versioned `SKILL.md` per character;
- collaboration-only Skill loading;
- milestone reflection using the character-bound model;
- static privilege validation, history, export, delete-all, and rollback;
- visible Skill UI with advanced manual override.

### V2.2: durable specialist workbench

- durable task lifecycle;
- minimal bound-tool loading;
- service-configuration and permission intersection;
- timeout, cancellation, retry, and typed results;
- functional and LLM-as-judge Skill promotion gates.

### V2.3: bounded organization

- dependency graph and one-hop delegation;
- load-aware queue;
- explicit hand-off and result reconciliation;
- loop/fan-out controls;
- organization activity UI.

### V2.5: hardened self-improvement

- candidate Skill versions;
- built-in per-capability test collections;
- functional completeness plus LLM-as-judge scoring;
- promotion thresholds, canary, rollback, and audit.

### V3: mature specialization

- evidence-weighted role recommendations;
- user-approved organization templates;
- cost/latency-aware routing;
- richer social collaboration without leaking private user context.

## 13. Acceptance Criteria

V2.0 is complete when:

- existing characters receive a valid default functional profile without data
  loss;
- capability IDs and levels are validated server-side;
- automatic routing selects the highest-scoring eligible same-world specialist
  deterministically;
- explicit-target collaboration still works;
- disabled or unknown modules never become effective through a character
  binding;
- World MCP public directory exposes no private profile or module data;
- collaboration outcomes create idempotent evidence;
- each role has exactly one active, visible, versioned Skill;
- ordinary chat/social calls do not load specialist Skill content;
- manual maintenance prevents silent SOUL-driven overwrite;
- collaboration milestones can update only the executing role's Skill;
- invalid Skill privilege claims cannot replace the active version;
- UI supports desktop and mobile summary, Markdown viewing, advanced editing,
  history, and rollback;
- schema migration, API, MCP, privacy, routing, UI syntax, browser, and full
  regression tests pass.
