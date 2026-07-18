# Relationship and Affect State

## Purpose

Relationship State adds slow, persistent relationship development and short-lived
affect to each user-character pair. It complements, but does not replace:

- `SOUL.md`: stable character identity and behavioral rules;
- RP memory: durable facts and story continuity;
- scene state: current fictional situation;
- conversation history: exact recent interaction.

The first implementation assumes one local user, so `character_id` uniquely
identifies a user-character relationship. A future multi-user version must add a
`user_id` to all state, event, and job keys rather than sharing these rows.

## State Model

Long-term dimensions are integer values in `[0, 100]`:

| Dimension | Initial | Meaning |
|---|---:|---|
| trust | 35 | confidence in the user's honesty and reliability |
| closeness | 20 | familiarity, openness, and interpersonal distance |
| affection | 25 | fondness and positive attachment |
| respect | 50 | regard for the user's judgment and boundaries |
| tension | 5 | unresolved conflict, wariness, or discomfort |

The stage (`stranger`, `acquaintance`, `familiar`, `close`, `intimate`, or
`strained`) is derived from those dimensions and is never independently written.
It describes interpersonal distance only. `intimate` does not mean that the user
and character are dating.

Explicit relationship semantics are stored separately:

- bond facets: `friendship`, `confidant`, `companionship`, `partnership`,
  `mentorship`, `rivalry`, and `familial`;
- romantic status: `none`, `user_interest`, `character_interest`,
  `mutual_interest`, `dating`, `committed`, or `former_partners`.

Bond facets may coexist. Romantic status follows a trusted state machine rather
than a score threshold. High affection, flirting, physical affection, jealousy,
or an `intimate` stage can never promote `romance_status` on their own.

Short-term affect uses valence `[-1, 1]`, arousal `[0, 1]`, control `[0, 1]`, and
up to three finite labels. It decays toward `(0, 0.2, 0.8)` with a six-hour
half-life. Labels clear after 12 hours. Reads calculate decay without repeatedly
writing SQLite, so opening a page does not produce state churn.

## Trusted Update Pipeline

1. Every completed private turn with a selected character creates a durable
   `relationship_extraction_jobs` row when the module is enabled. Keyword
   matching is not used as a model-call gate.
2. Jobs run asynchronously and serially, so extraction never blocks the next
   live conversation turn.
3. The configured default model classifies the turn into one
   event type, impact, summary, and confidence. For semantic milestones it must
   also return an initiator and short verbatim evidence excerpts. It cannot
   submit scores, deltas, or a target romantic status.
4. Strict parsing rejects malformed, incomplete, or low-confidence output.
5. A trusted policy table maps the validated event to bounded deltas and an
   affect target. Per-axis limits are 2, 4, and 6 for minor, moderate, and major
   events respectively.
6. State and its immutable event ledger entry commit in one SQLite transaction.

The extractor uses one stable system prompt for ordinary interaction, affection,
conflict, bonds, and romantic milestones. Per-turn conversation data and the
current relationship snapshot remain in the user message. This maximizes the
stable prefix available to provider KV caching and avoids keyword blind spots
such as an explicit mutual relationship definition phrased as `另一半`.

Relationship extraction is a deterministic classification call, so the current
MLX profile explicitly disables chat-template thinking and uses a 1,024-token
output ceiling. Unknown OpenAI-compatible providers receive no MLX-specific
field and retain the 2,400-token fallback. This policy affects only extraction;
it does not disable reasoning for the character's private or group reply.
An ordinary negative turn on the current model returns about nine output tokens;
positive events generally remain below one hundred in the synthetic corpus.

Supported event classes are `support`, `reliability`, `vulnerability`,
`shared_success`, `conflict`, `boundary_violation`, `repair`, `affection`,
`bond_defined`, `confession`, `confession_accepted`, `confession_rejected`,
`relationship_confirmed`, `commitment`, `jealousy`, `shared_secret`, `breakup`,
and `reconciliation`.
The model may choose a class, but cannot invent a new class or bypass the policy
table. The source context-log ID is unique, making reprocessing idempotent.

Explicit milestones use a confidence floor of `0.8`, compared with `0.65` for
ordinary relationship events. Evidence is normalized and checked as an exact
substring of the correctly attributed user or assistant source text. The
trusted transition policy is:

| Event | Result |
|---|---|
| one-party confession | `user_interest` or `character_interest` |
| evidenced acceptance by the other party | `mutual_interest` |
| mutual explicit agreement to date | `dating` |
| mutual explicit long-term commitment | `committed` |
| explicit unilateral or mutual breakup | `former_partners` |
| mutual explicit reunion by former partners | `dating` |

Rejected or unevidenced milestones produce no event and no mutation. Two
separate `shared_secret` events may establish the `confidant` facet. Explicit
non-romantic bond definitions require evidence from both parties.

The Coordinator uses the same owner lease, heartbeat, stale-job recovery, and
explicit retry pattern as Memory Coordinator. Editing or retracting a turn is
blocked while its relationship job is active or after it committed an event.

## Context Placement

When `mcp:relationship-state` is enabled and a character is selected, Context
Planner adds a `relationship` dynamic section to the trusted turn envelope. It
contains qualitative bands and up to three recent causes, not raw numeric scores.
It also contains established bond facets and the explicit romantic status. The
prompt treats romantic status as a hard upper bound, so a character can express
warmth or attraction without claiming a relationship that was never confirmed.
The stable system prefix contains only capability policy, preserving provider
cache reuse as the state changes.

The model is instructed to express the state implicitly and never disclose
metrics, stages, Coordinator mechanics, or the snapshot. Event summaries remain
quoted untrusted data and cannot grant permissions or issue instructions.

Every completed private SMS and RP turn is reviewed and may update state. Group actors read the selected
character's snapshot, but group turns do not enqueue relationship extraction in
this version. This avoids ambiguous simultaneous updates and feedback loops.

## MCP and Control Plane

`Relationship State MCP` is disabled by default and exposes one read-only tool:

- `get_relationship_state`: returns a qualitative snapshot, bond facets, and
  romantic status for the session-bound character.

There is intentionally no model-facing score, delta, event, reset, or edit tool.
The user control plane is:

- `GET /api/v1/characters/{id}/relationship`
- `POST /api/v1/characters/{id}/relationship/reset`
- `GET /api/v1/relationship-coordinator/status`
- `POST /api/v1/relationship-coordinator/jobs/{id}/retry`

Reset requires the exact character name or ID. The character page shows raw
dimensions, decayed affect, and the event ledger because it is a user-facing
management surface. Reset also invalidates outstanding extractor leases so an
older in-flight result cannot recreate cleared state. It also fences old quiet
turns from later periodic reviews while retaining their audit rows. Chat does
not show meters.

## Storage

Schema 17 adds:

- `character_relationship_states`: one current snapshot per character;
- `relationship_events`: immutable, source-linked update ledger;
- `relationship_extraction_jobs`: durable background work and audit status.

Schema 18 adds semantic relationship columns to the state and event tables,
expands the trusted event enum, and migrates every existing character to empty
bond facets with romantic status `none`. Existing scores and event history are
preserved.

All three use `ON DELETE CASCADE` from `characters`. Operational backup supports
database schema 17, and the normal user-data export includes snapshots, events,
and Coordinator status. Relationship state is SQLite runtime data in this version;
it is not yet projected into the Markdown Memory Vault or OKF exports.

## Test Contract

Automated tests must preserve these invariants:

- disabled module means no extraction, tool, or context section;
- ordinary turns use no relationship-extraction tokens except for one periodic
  batch after every eight quiet turns;
- injected score/delta fields are ignored and policy limits still apply;
- affection and intimacy never imply a romantic status;
- formal romantic milestones require source-verifiable evidence from the
  required participants;
- breakup and reunion transitions preserve an auditable semantic ledger;
- retries and restarts cannot apply one source turn twice;
- state is isolated between characters and shared across private sessions;
- affect decays against the trusted clock;
- group chat reads but does not write state;
- completed state mutations block message revision;
- reset requires trusted user confirmation;
- Debug Trace labels background calls as `relationship_extraction`.

The built-in real-model case `relationship-affect-update` checks classifier
triggering and bounded mutation under the currently configured model.

## Deferred Extensions

Do not add these by expanding the extractor output schema. Implement them as
trusted policy/configuration layers:

- per-character sensitivity and baseline coefficients;
- user-approved manual calibration without deleting the event ledger;
- event correction or rollback with compensating events;
- explicit group-chat attribution rules;
- Markdown/OKF projection for portable relationship history;
- user correction through compensating semantic events;
- a dedicated low-cost classifier model profile;
- multi-user compound keys.
