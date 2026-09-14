# Agent Runtime Modernization Plan

Status: active

## 1. Objective

Turn the current Pi-backed companion runtime into a composable Agent runtime
without weakening the product capabilities that distinguish YourChar:

- durable character memory and provenance;
- relationship, World, scene, and life state;
- real reminder delivery with quiet hours, retry, and acknowledgement;
- normal, secret, and incognito isolation;
- deterministic domain validation and least-privilege tools.

This is an incremental refactor. Replacing Pi or adopting DeepSeek Harness is
not a prerequisite, and the product must remain runnable at every milestone.

## 2. Architecture principles

1. **Composition over central branching.** Runtime capabilities register through
   typed seams instead of adding conditionals to `PiSessionRuntime`.
2. **Policy stays trusted.** A plugin may expose only the scope and services the
   host grants it; module enablement never implies a new permission.
3. **Lifecycle is explicit.** Every mounted capability has an identity, owned
   resources, deterministic ordering, and reversible cleanup.
4. **Model-visible state is reconstructable.** New context and durable behavior
   must have an auditable source and deterministic replay semantics.
5. **Migration is behavior-preserving.** Existing contract tests remain the
   compatibility oracle while infrastructure moves behind new interfaces.

## 3. Priority roadmap

| Priority | Milestone | Deliverable | Exit criteria |
| --- | --- | --- | --- |
| P0 | Baseline and measurement | Freeze safety/product invariants and define a same-model task suite | Existing release gate passes; benchmark records model, permissions, tools, latency, tokens, and pass rate |
| P1 | Capability kernel | Typed session capability registry, deterministic mount/rollback/cleanup, module contributions, and built-in migration | A new trusted capability can be added without editing `PiSessionRuntime`; duplicate IDs/tools fail closed |
| P2 | Continuable jobs and subagents | Durable child identity, background execution, status/list/send/interrupt, bounded continuation, recovery | Child work survives handle eviction/restart and preserves least privilege and audit redaction |
| P3 | General execution | Persistent terminal/jobs, result spill, goals/plans/todos, workflow fan-out, optional code orchestration and LSP | Long-running work is cancellable/resumable and large output does not consume active context unboundedly |
| P4 | Provider and host seams | Native provider adapters, credential references/rotation, headless API, typed SDK, optional ACP | Provider-specific behavior no longer depends on one OpenAI-compatible route; automation does not require the Web UI |
| P5 | Event-sourced runtime state | Typed append-only runtime events, projections, migrations, replay, and checkpoint policy | Everything model-visible and every lifecycle transition can be reconstructed and version-migrated |

## 4. P1 implementation slices

### P1a — Session capability lifecycle

- Introduce `SessionCapabilityRegistry` and a narrow per-session mount context.
- Give every capability a stable ID and deterministic order.
- Reject duplicate capability IDs and duplicate tool names.
- Roll back already-mounted capabilities when a later mount fails.
- Close mounts exactly once when a handle is rebuilt, deleted, or disposed.
- Move built-in MCP bridge construction out of `PiSessionRuntime`.
- Accept deployment-trusted additional capabilities through the Kernel options.

### P1b — Declarative product contributions

- Let a capability contribute its module descriptor, detail Markdown, bounded
  context status, generic enable setting, and module UI card.
- Replace the hard-coded MCP array and context-status branches in
  `AgentModuleCatalog` with registered contributions.
- Validate contribution ownership: one capability ID owns one module/settings
  namespace and cannot shadow another capability.

### P1c — Profiles and reload

- [x] Add named runtime profiles composed from built-ins and trusted packages.
- [x] Persist a resolved, inspectable configuration snapshot without executable
  code or credentials.
- [x] Implement trusted-host install/uninstall/reload by replacing preloaded
  packages at an idle boundary, with validation and rollback before handle
  invalidation.
- [x] Add declared provider-specific settings schemas, module-scoped mount
  values, revision-safe persistence, and an optional host-rendered detail slot.
- [x] Keep third-party code inactive by default and require an explicit trust
  flag, reviewed artifact SHA-256, and profile selection before activation.

## 5. P2 design boundary

The current `delegate_task` contract remains available during migration. The
new job layer should add a durable control plane around it rather than widening
the existing child's permissions:

```text
parent session
  -> durable job record + child session identity
  -> queued/running/idle/completed/failed/cancelled
  -> optional follow-up messages and bounded continuation
  -> result reference returned to the parent
```

Required invariants:

- no implicit parent transcript, SOUL, profile, memory, or secret inheritance;
- capability grants are an explicit subset of the parent grant;
- no recursive delegation until depth and budget policies exist;
- cancellation propagates to model, tools, and provider transport;
- raw delegated prompts remain out of ordinary audit records;
- restart recovery never repeats a committed external side effect silently.

### P2a — Durable identity and lifecycle ledger

- [x] Persist a stable job ID and child-session ID before delegated model work.
- [x] Record queued/running/completed/failed/cancelled transitions with frozen
  budgets and explicit read-only grants.
- [x] Add parent-session-scoped list/status/result tools and host GET endpoints
  without exposing task/context bodies in list or audit projections.
- [x] Stage interrupted non-terminal work without silently replaying ambiguous
  effects; purge private job bodies from incognito and deletion flows.

### P2b — Background control and continuation

- [x] Add non-blocking start plus status/list/interrupt operations while
  retaining the blocking `delegate_task` compatibility path.
- [x] Keep admitted in-process work independent of parent handle eviction and
  capability remounts.
- [x] Propagate explicit interruption through model, tool, and provider
  transports into one durable cancelled state.
- [x] Persist bounded child Pi transcripts and add parent-scoped follow-up/send
  turns that preserve the stable child identity across restart.
- [x] Make completion notification/result delivery idempotent across process
  restart.

### P2c — Recovery and side-effect checkpoints

- [x] Persist one fenced run ledger per initial/follow-up turn, including
  attempt ownership, bounded transcript checkpoints, and cumulative model,
  tool, token, elapsed-time, and result-size accounting.
- [x] Recover expired leased work from persistent child checkpoints without
  resetting its frozen budgets or three-attempt ceiling.
- [x] Write-ahead journal every admitted tool call, store only its argument
  digest plus a bounded private result, and classify external or metered calls
  as requiring an explicit replay decision.
- [x] Reconcile committed tool results during recovery and expose an explicit
  decision path for ambiguous external calls; never silently repeat them.
- [x] Keep continuation depth, run attempts, elapsed time, tokens, result size,
  and capability grants durably bounded across process restarts.

## 6. P3 implementation slices

### P3a — Durable background shell and result spill

- [x] Add host-owned background shell jobs whose process lifecycle is
  independent of a conversation handle.
- [x] Freeze the admitted Workspace/network grant, bound concurrency, runtime,
  attempts, and captured output, and retain commands only as private execution
  material with public hash/length projections.
- [x] Store stdout/stderr in bounded SQLite chunks and expose only explicit,
  cursor-based pages to the Agent and local HTTP control plane.
- [x] Add same-session start/list/get/interrupt tools plus trusted local
  start/interrupt/retry and output endpoints.
- [x] Fence deletion and permission changes while a process is active; keep
  secret scope isolation and remove all durable artifacts with their owner.
- [x] On shutdown/restart, terminate or stage non-terminal commands as `idle`;
  never replay a shell command until the trusted local control plane explicitly
  retries it, and never widen its original grant.

### P3b — General goals, plans, and todos

- [x] Add session-scoped durable goals with explicit success criteria, status,
  priority, dependencies, and bounded notes.
- [x] Expose plan/todo mutation tools without allowing model-visible state to
  bypass normal/secret/incognito ownership.
- [x] Record progress as typed transitions so a restarted turn can reconstruct
  what remains without replaying completed work.

The projection uses optimistic goal/todo revisions. Every accepted mutation
updates the projection and appends exactly one typed transition in the same
SQLite transaction. Dependency edges are same-session and acyclic; completion
is rejected while a dependency or todo remains unfinished. Terminal work is
immutable, hidden from the default active list, and retained for explicit
history/reconstruction until its owning conversation is deleted.

### P3c — Workflow fan-out and orchestration

- [x] Add a bounded DAG executor over existing Subagent and execution-job
  primitives, with dependency validation and per-workflow concurrency budgets.
- [x] Propagate cancellation, deadlines, and least-privilege grants through all
  descendants; make aggregation consume references rather than full outputs.
- [x] Require explicit replay decisions for nodes with ambiguous external
  effects and make workflow completion idempotent across restart.

Workflows are planned before they are started, are limited to 16 acyclic nodes
and four concurrent descendants, and freeze a grant ceiling for every node.
Shell nodes default to no Workspace or network access; Subagent module/Skill
access is opt-in. A stable admission key joins every node to exactly one durable
child job across the crash window between child creation and attachment.

The workflow projection stores private commands and delegated prompts only in
its execution rows. DAG aggregation and model-visible tools carry bounded child
references, hashes, lifecycle state, and output sizes—not result bodies. On
restart, completed children reconcile idempotently, safe Subagent checkpoints
retain their existing automatic recovery policy, and shell or ambiguous
Subagent effects enter `decision_required`. Only the trusted local control
plane can record retry, skip, or cancel decisions before orchestration resumes.

### P3d — Optional code intelligence

- [x] Define a deployment-trusted, default-off LSP capability package behind an
  explicit module, runtime profile trust, and Workspace read permission.
- [x] Scope each language server to its owning read-only Workspace, expose only
  definition/reference/implementation/hover queries, bound all inputs/results,
  and keep server processes inside the capability lifecycle.
- [x] Preserve the blocking `bash` compatibility path and allow only explicitly
  approved capability definitions to be recreated inside the isolated Task
  Bench runtime.
- [x] Run same-model Task Bench A/B trials on cross-file repository tasks and
  record whether LSP materially improves pass rate, tokens, or latency.
- [x] Keep a broader model-generated Code Mode SDK out of this milestone: the
  paired trial showed no pass-rate gain and higher latency/request cost, so the
  conditional benefit bar was not met.

The 2026-09-14 paired run used the same
`DeepSeek-V4-Flash-0731-MXFP4-MLX` model, three cross-file tasks, and three
repetitions per variant. All 18 runs completed and both variants passed 9/9.
The model used LSP in 4/9 variant runs; LSP reduced reported input tokens from
26,408 to 14,238 but increased average duration from 37,507 ms to 44,016 ms and
model requests from 27 to 37. This supports retaining the bounded LSP as an
explicitly selected, default-off capability, not promoting a broader Code Mode.

## 7. P4 implementation slices

### P4a — Provider adapter registry

- [x] Add a deployment-trusted adapter registry with stable IDs, duplicate
  rejection, exact selection, safe public descriptors, and no fallback for an
  unknown provider.
- [x] Route interactive sessions, Creator, background jobs, diagnostics,
  feature evaluation, and Task Bench through the same registry.
- [x] Preserve the existing OpenAI-compatible behavior as the built-in adapter
  and allow synchronous or asynchronous Pi-native provider registration.
- [x] Carry explicitly injected adapters into incognito and disposable
  evaluation kernels without serializing executable code or credentials.

### P4b — First-party native providers and settings

- [x] Add first-party native Pi adapters in priority order, beginning with the
  APIs whose tool use, thinking, streaming, or cache semantics differ from the
  OpenAI-compatible route.
- [x] Give adapters declarative configuration fields and validation; expose a
  provider selector without leaking credentials or executable definitions.
- [x] Move request-payload, reasoning/thinking, usage, timeout, retry, and
  discovery behavior behind provider-owned hooks; retain
  `openai_compatible` for local and compatible endpoints.
- [x] Run same-task, same-model compatibility tests where a model is available
  through both native and compatible transports.

### P4c — Credential references and rotation

- [x] Replace profile-embedded API keys with opaque credential references and
  a host-owned credential store; migrate existing secrets without returning
  plaintext through APIs, logs, traces, exports, or reports.
- [x] Support atomic create/rotate/revoke operations, profile reference checks,
  last-known-good rollback, and explicit missing/revoked states.
- [x] Keep normal, secret, incognito, Task Bench, and background request paths
  scoped to the selected reference and prevent runtime credential reuse across
  profiles.

### P4d — Headless API and typed SDK

- [ ] Define a versioned authenticated loopback/headless API for sessions,
  streaming turns, jobs, goals, workflows, files, and lifecycle control without
  requiring the Web UI or browser cookie bootstrap.
- [ ] Generate or hand-maintain a typed TypeScript SDK with cancellation,
  idempotency, pagination, event schemas, and stable error types.
- [ ] Add contract tests that run the same workflow through Kernel, HTTP, and
  SDK surfaces and verify identical ownership and permission enforcement.

### P4e — Optional ACP bridge

- [ ] Evaluate ACP only as a thin host adapter over the typed API/SDK; do not
  make ACP the source of truth for sessions, permissions, or durable jobs.
- [ ] Implement it only if interoperability tests demonstrate value beyond the
  headless API, with explicit capability mapping and cancellation semantics.

## 8. Verification strategy

Each slice must run, at minimum:

1. TypeScript build.
2. Focused unit and integration tests for the changed seam.
3. Existing module, permission, secret/incognito, subagent, and mode-contract
   suites affected by capability mounting.
4. Sensitive-information scan.
5. Full release gate before merging a milestone.

For DSH comparisons, use the Task Bench with the same model, context window,
task fixtures, tool permissions, timeout, and repetition count. Architectural
feature counts must not be reported as task-success improvements.

## 9. Rollout and rollback

- Land every slice as a small commit on a dedicated branch.
- Preserve the old public tool names and module IDs during P1.
- Gate new lifecycle behavior behind defaults that reproduce current behavior.
- Do not migrate durable memory, schedule, or relationship schemas as part of
  capability extraction.
- A slice is rollback-safe when reverting it requires no user-data migration.

## 10. Current progress

- [x] Baseline work isolated on `refactor/agent-runtime-capabilities`.
- [x] P1a session capability lifecycle.
- [x] P1b declarative product contributions.
- [x] P1c profiles, reload, and declarative provider settings.
- [x] P2 continuable jobs and subagents, including fenced checkpoint recovery,
  committed-result reconciliation, and explicit replay decisions.
- [x] P3a durable background shell jobs and bounded result spill.
- [x] P3b durable session goals, plans, todos, and typed progress transitions.
- [x] P3c bounded durable workflow DAGs, cancellation, aggregation references,
  and explicit replay decisions.
- [x] P3d optional code intelligence: real TypeScript provider, reproducible
  same-model A/B evidence, and a default-off/no-Code-Mode rollout decision.
- [x] P3 general execution.
- [x] P4a provider adapter registry, exact fail-closed selection, and complete
  Kernel/evaluation routing.
- [x] P4b first-party Anthropic Messages, Google Generative AI, and OpenAI
  Responses adapters; declarative settings; provider-owned request policy; and
  same-model protocol compatibility coverage.
- [x] P4c host-owned model credential references, legacy-key migration,
  verified CAS rotation/revocation/rollback, fail-closed profile ownership, and
  scoped incognito/evaluation resolution without secret-file copies.
- [ ] P4 provider and host seams.
- [ ] P5 event-sourced runtime state.
