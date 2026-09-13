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
- [x] Fail interrupted non-terminal work closed on startup instead of silently
  replaying it; purge private job bodies from incognito and deletion flows.

### P2b — Background control and continuation

- [x] Add non-blocking start plus status/list/interrupt operations while
  retaining the blocking `delegate_task` compatibility path.
- [x] Keep admitted in-process work independent of parent handle eviction and
  capability remounts.
- [x] Propagate explicit interruption through model, tool, and provider
  transports into one durable cancelled state.
- [x] Persist bounded child Pi transcripts and add parent-scoped follow-up/send
  turns that preserve the stable child identity across restart.
- [ ] Make completion notification/result delivery idempotent across process
  restart.

### P2c — Recovery and side-effect checkpoints

- [ ] Recover leased queued/running work from persistent child checkpoints.
- [ ] Journal tool commits so recovery cannot repeat an external side effect
  without an explicit retry decision.
- [ ] Bound continuation depth, attempts, elapsed time, tokens, result size,
  and capability grants across restarts.

## 6. Verification strategy

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

## 7. Rollout and rollback

- Land every slice as a small commit on a dedicated branch.
- Preserve the old public tool names and module IDs during P1.
- Gate new lifecycle behavior behind defaults that reproduce current behavior.
- Do not migrate durable memory, schedule, or relationship schemas as part of
  capability extraction.
- A slice is rollback-safe when reverting it requires no user-data migration.

## 8. Current progress

- [x] Baseline work isolated on `refactor/agent-runtime-capabilities`.
- [x] P1a session capability lifecycle.
- [x] P1b declarative product contributions.
- [x] P1c profiles, reload, and declarative provider settings.
- [ ] P2 continuable jobs and subagents (P2a complete; P2b background controls
  and continuation implemented, idempotent result delivery and P2c recovery
  remain).
- [ ] P3 general execution.
- [ ] P4 provider and host seams.
- [ ] P5 event-sourced runtime state.
