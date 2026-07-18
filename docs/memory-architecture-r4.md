# Memory Architecture R4

## Scope

R4 adds deterministic retrieval, bounded dynamic context, resident-memory
checkpoints, and context economics on top of the R3 Vault and lifecycle. The
canonical fact source remains Markdown in `<stateDir>/memory-vault/`.
SQLite/FTS, retrieval statistics, provider-prefix checkpoints, and economics
are derived operational state. They do not replace Vault documents.

The R3 realm and trust contracts remain mandatory: only active confirmed
`reality/global` memory and active confirmed continuity for the selected
character can be retrieved. Pending, rejected, archived, superseded, deleted,
legacy/quarantine, and other-character documents are rejected before scoring.

## Retrieval Contract

`MemoryRetriever` owns recall and scoring. `ContextPlanner` owns section and
token budgets. The Pi Session runtime and its context hook consume their typed
plans; they do not issue ad hoc memory SQL.

Recall uses these deterministic signals:

1. normalized exact key, tag, or content containment;
2. SQLite FTS5/BM25 rank;
3. lexical overlap, including Chinese bigrams and removal of conversational
   retrieval phrases such as `还记得我们的...吗`;
4. core bootstrap eligibility when no relevant query match exists.

The relevance value is the maximum signal:

```text
exact content                         1.00
exact key                             0.95
exact tag                             0.90
FTS match                     0.72 + 0.08 * normalizedBm25
lexical overlap                0.80 * overlap
```

A normal turn is relevant only when relevance is at least `0.24`. With no
relevant candidate, it injects no arbitrary fallback memory. Final score is:

```text
0.60 * relevance + 0.18 * salience + 0.10 * recency + 0.12 * confidence
```

Recency is `1 / (1 + ageDays / 30)`. Scores are rounded before deterministic
ordering. Ties use memory ID ascending. The plan records every candidate's
component values, selection result, exclusion reason, item estimate, and ID.

The new-session bootstrap can select at most three active confirmed core
memories (`salience >= 0.85` or tag `core`). Bootstrap is consumed only by an
actual provider context hook. Preview, aborted preparation, and failed prompt
construction do not consume it. A session does not repeatedly bootstrap.

## Budgets And Deduplication

Default planner budgets are:

| Segment | Default |
| --- | ---: |
| Total dynamic context | 900 tokens |
| All memory sections | 360 tokens |
| Reality memory | 220 tokens / 3 items |
| Current-character RP memory | 220 tokens / 3 items |
| Scene | 220 tokens |
| Bootstrap | 3 items |

The trusted time/snapshot envelope imposes a 320-token minimum on a supplied
total dynamic budget. Below-budget requests are normalized to that floor;
optional memory and scene content are still removed first. The planner never
truncates half a fact. It removes the lowest-scored complete memory, then the
optional scene, until the total fits. Section manifests report actual text
character/token estimates, budget, inclusion, and truncation reason.

Content and key normalization deduplicates selected facts. A fact already
present in the manual profile is excluded. The managed profile block is never
provider input. Reality and RP have separate caps, and RP selection is matched
by both realm and character ID.

Only IDs present in the actual provider request are touched and counted as
hits. Preview is read-only. Management exposes `core`, `hitCount`,
`lastHitAt`, and Vault `lastUsedAt`.

## Snapshot And Resident State

Each hidden `rp-agent/turn_context` v3 session message stores one raw audit
record, but its details split the dynamic plan into two provider segments:

- `volatileContent`: runtime clock, mode, relationship, scene, and turn-local
  inputs such as vision analysis;
- `memoryContent`: query-selected confirmed reality and RP memory.

The provider context hook reconstructs these raw records before every request.
It retains valid historical memory carriers, removes every historical volatile
segment, and emits the newest volatile segment exactly once. A newly selected
memory carrier is emitted immediately before the newest volatile segment. All
runtime carriers are moved before their associated real user message and are
wrapped in a `NOT_USER_AUTHORED` boundary. The real user message is therefore
the final user-role item of the turn; the model must not attribute runtime time,
memory, relationship, scene, or vision metadata to the user. Raw session JSONL
remains unchanged for audit and Debug Trace generation. Time is minute precision
with an explicit IANA timezone and UTC minute.

Provider-facing wrappers are intentionally compact. The stable System owns the
full trust contract, so the volatile carrier contains only one short authorship
warning, current time/mode, bounded relationship continuity, optional scene,
and turn-local inputs. Relationship event summaries are whitespace-normalized,
bounded to 140 characters each, and omit redundant timestamps. The 900-token
dynamic budget remains a ceiling for turns that also need scene, memory, or
vision context, not a target that ordinary private turns should fill.

Memory text may remain in an older provider prefix to preserve useful cache
reuse. A resident table records the memory ID and a digest of all
injection-relevant fields, not `updatedAt`. Before every real plan, and when
loading or compacting a session, the runtime replaces that table from valid v3
memory-carrier details that remain in `AgentSession.messages`. For repeated IDs,
the newest surviving version wins. Historical v2 mixed snapshots are not
resident carriers; after an upgrade they are removed and relevant memory is
eligible for normal retrieval again.

- If a matching ID/version survives in the recent tail, the planner does not
  duplicate it.
- If compaction removes its snapshot, resident state becomes empty and a
  relevant/core fact can be injected again.
- An Obsidian body-only or frontmatter-only change produces a new content
  digest. The next provider request removes every old-version carrier and may
  inject the new version.
- Correction, forget, archive, and module disable remove stale memory carriers
  before the next provider call.

Compaction resets resident state before running so a failure can cause at most
one duplicate, never permanent omission. Successful compaction then rebuilds
from the actual remaining tail. The 40-turn regression reaches a stable request
shape of at most 25 messages and below 30,000 estimated input tokens; the latest
request contains a resident core fact at most once.

The cache boundary is deliberate: the stable System and valid historical memory
carrier can remain a common prefix. The prior volatile snapshot is not reused,
and the newest volatile snapshot sits immediately before the newest real user
message. This gives up exact whole-request prefix equality in exchange for
bounded, current time/relationship/scene context and unambiguous user-message
attribution.

## Cache And Token Economics

Each provider request records a canonical payload measurement:

- System hash and canonical tool-schema hash;
- message count and estimated input, stable, dynamic, memory, and tool tokens;
- selected memory IDs, planner budget, and truncation flag;
- exact longest common prefix message count and estimated token count against
  the previous comparable request;
- prefix reuse ratio and an explicit cache-break reason;
- provider-reported actual input/output/cache-read/cache-write usage.

Messages are hashed in provider order. Tools are sorted by stable tool name
before hashing. The prefix numerator is LCP message tokens plus tool tokens only
when tool schemas match. The denominator is the same complete estimated-input
token basis, including tools. A system, tools, model, module, permission, or
capability change records a cache break rather than presenting an incomparable
request as reuse.

Estimates are local heuristics and always carry `estimated` names. Actual usage
is separate. If the provider does not report a usable usage group, every actual
field is `null` and the UI displays `unknown`. Once a group is reported, an
actual cache read/write value of zero remains numeric zero. Extractor job token
estimates remain in Coordinator jobs and are not mixed into chat economics.

Full provider payload traces remain capped at 10. Embedded binary data URLs are
replaced with MIME/encoded-size placeholders before trace persistence and API
delivery; the actual provider request is unchanged. Lightweight economics remain
capped at 100 and omit query text, profile/SOUL/scene/memory bodies, candidate
keys/tags, credentials, and tool arguments. They retain hashes, IDs, scores,
budgets, and reasons. Session delete and delete-all clear checkpoints and
economics. Logical export includes the resident/bootstrap checkpoint state;
normal Vault backup/restore remains covered by the R2 operational contract.

## API And UI

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/context-plan/preview` | Read-only full plan for mode/session/character/query/budgets |
| GET | `/api/v1/memory-retrieval/preview` | Read-only retrieval plans and selected IDs |
| GET | `/api/debug/context-economics?limit=100` | Recent lightweight provider economics |
| GET | `/_test/.../context-plan` | Deterministic virtual-clock plan control |
| GET | `/_test/.../context-economics` | Deterministic economics control |

Preview accepts the budget names in the table plus `bootstrap=0|1`. It never
touches memory, records a hit, or consumes bootstrap.

Memory Management includes a query preview, core/use/hit metadata, source and
lifecycle controls, and a filtered path for ambiguous forget jobs. Debug has
bounded Provider Trace and Context Economics tabs. Economics expands into the
section manifest and retrieval candidates; candidate bodies remain collapsed
out of the metrics record and memory IDs link back to management.

## Invalidation And Tuning

Vault reads automatically synchronize safe external Obsidian edits before
planning. Confirm, correct, forget, archive, external sync, module toggle,
capability rebuild, restart, and compaction all flow through current Vault/index
state; no in-memory memory-body cache is authoritative.

Tune defaults in `src/context/planner.ts`, scoring and Chinese normalization in
`src/context/memory-retriever.ts`, and retention in
`src/context/economics-repository.ts`. Use preview APIs before changing
thresholds or budgets. Any scoring change must retain no-match-zero, realm,
status, character, deterministic-tie, and whole-item budget tests.

## Current Limits

- Token estimates use a deterministic character-based heuristic, not each
  provider's exact tokenizer.
- FTS5 has limited native Chinese tokenization; bigram overlap handles common
  phrasing but is not semantic embedding retrieval.
- Bootstrap completion and resident sets are local SQLite state. They survive
  restart and backup but are not coordinated across multiple writer processes.
- Cache usage depends on provider support. The app can prove canonical prefix
  stability but cannot infer billable cache hits when usage is absent.
- Pi transcripts still grow between compactions. The bound is enforced by Pi
  compaction and verified at provider-request shape, not by deleting canonical
  conversation history.
