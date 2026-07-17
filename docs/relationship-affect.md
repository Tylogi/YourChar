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

Short-term affect uses valence `[-1, 1]`, arousal `[0, 1]`, control `[0, 1]`, and
up to three finite labels. It decays toward `(0, 0.2, 0.8)` with a six-hour
half-life. Labels clear after 12 hours. Reads calculate decay without repeatedly
writing SQLite, so opening a page does not produce state churn.

## Trusted Update Pipeline

1. A completed private turn is checked by a local, zero-token signal detector.
2. Non-relational turns create a visible skipped job and make no model call.
3. A triggered turn creates a durable `relationship_extraction_jobs` row.
4. The configured default model classifies the turn into one event type, impact,
   summary, and confidence. It cannot submit scores or deltas.
5. Strict parsing rejects malformed, incomplete, or low-confidence output.
6. A trusted policy table maps the validated event to bounded deltas and an
   affect target. Per-axis limits are 2, 4, and 6 for minor, moderate, and major
   events respectively.
7. State and its immutable event ledger entry commit in one SQLite transaction.

Supported event classes are `support`, `reliability`, `vulnerability`,
`shared_success`, `conflict`, `boundary_violation`, `repair`, and `affection`.
The model may choose a class, but cannot invent a new class or bypass the policy
table. The source context-log ID is unique, making reprocessing idempotent.

The Coordinator uses the same owner lease, heartbeat, stale-job recovery, and
explicit retry pattern as Memory Coordinator. Editing or retracting a turn is
blocked while its relationship job is active or after it committed an event.

## Context Placement

When `mcp:relationship-state` is enabled and a character is selected, Context
Planner adds a `relationship` dynamic section to the trusted turn envelope. It
contains qualitative bands and up to three recent causes, not raw numeric scores.
The stable system prefix contains only capability policy, preserving provider
cache reuse as the state changes.

The model is instructed to express the state implicitly and never disclose
metrics, stages, Coordinator mechanics, or the snapshot. Event summaries remain
quoted untrusted data and cannot grant permissions or issue instructions.

Private SMS and RP turns may update state. Group actors read the selected
character's snapshot, but group turns do not enqueue relationship extraction in
this version. This avoids ambiguous simultaneous updates and feedback loops.

## MCP and Control Plane

`Relationship State MCP` is disabled by default and exposes one read-only tool:

- `get_relationship_state`: returns a qualitative snapshot for the session-bound
  character.

There is intentionally no model-facing score, delta, event, reset, or edit tool.
The user control plane is:

- `GET /api/v1/characters/{id}/relationship`
- `POST /api/v1/characters/{id}/relationship/reset`
- `GET /api/v1/relationship-coordinator/status`
- `POST /api/v1/relationship-coordinator/jobs/{id}/retry`

Reset requires the exact character name or ID. The character page shows raw
dimensions, decayed affect, and the event ledger because it is a user-facing
management surface. Reset also invalidates outstanding extractor leases so an
older in-flight result cannot recreate cleared state. Chat does not show meters.

## Storage

Schema 17 adds:

- `character_relationship_states`: one current snapshot per character;
- `relationship_events`: immutable, source-linked update ledger;
- `relationship_extraction_jobs`: durable background work and audit status.

All three use `ON DELETE CASCADE` from `characters`. Operational backup supports
database schema 17, and the normal user-data export includes snapshots, events,
and Coordinator status. Relationship state is SQLite runtime data in this version;
it is not yet projected into the Markdown Memory Vault or OKF exports.

## Test Contract

Automated tests must preserve these invariants:

- disabled module means no extraction, tool, or context section;
- ordinary turns consume zero relationship-extraction tokens;
- injected score/delta fields are ignored and policy limits still apply;
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
- a dedicated low-cost classifier model profile;
- multi-user compound keys.
