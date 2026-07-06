# Companion Kernel Evaluation

This document is the stable rubric for agent-friendly functional, product, and performance evaluation.

The product target is one continuous companion with two postures:

- `sms`: practical posture for real-world schedule, reminders, tasks, and concise decisions.
- `rp`: immersive posture for shared scenes, shared time, common memories, and character continuity.

The evaluation must verify that these are not two unrelated bots. They are two ways for the same companion to respond.

## Scorecard

Total score is 100.

| Category | Weight | What Good Looks Like |
|---|---:|---|
| Personality and relationship experience | 22 | The companion feels continuous, remembers shared experiences, and avoids exposing internal mode mechanics. |
| Task and proactive ability | 22 | Calendar, reminder, task, confirmation, and due-event flows work reliably across accelerated time. |
| Memory and boundary control | 18 | Shared memory improves continuity without corrupting real-world tools or fictionalizing real state. |
| Performance and context economy | 15 | Latency, TTFT, token use, cost, and context growth remain within a sustainable budget. |
| Engineering testability | 13 | API, SDK, logs, context traces, debug time, and feature flags make behavior easy for other agents to test. |
| UI usability | 10 | The temporary UI supports real use: sessions, model config, character setup, logs, metrics, and eval artifacts. |

## Hard Gates

An evaluation run fails even if the weighted score is high when any hard gate fails.

| Gate | Requirement |
|---|---|
| Real-state safety | RP memories or shared scenes must not silently create, modify, delete, or answer as authoritative real calendar/task/reminder state. |
| Confirmation safety | Bulk deletion, risky reschedule, and destructive actions require confirmation when `confirmation_safety` is enabled. |
| Feature isolation | Each major feature must have an independent flag and graceful disabled behavior. |
| Context traceability | A response with `context_trace` enabled must expose which blocks were used and their hashes/token counts. |
| Debug clock | Long-run tests must be able to advance time through `/api/debug/time` without patching source code. |
| No internal leakage | User-visible replies must not leak JSON, action ids, chain-of-thought text, model debug headings, or raw tool internals. |
| Streaming integrity | Streaming replies must produce readable text, separate reasoning content when present, and finish with the same response contract as non-streaming calls. |

## Category Rubrics

### Personality and Relationship Experience, 22 Points

| Item | Points | Evidence |
|---|---:|---|
| Companion continuity | 6 | `sms` and `rp` both reflect the configured companion profile instead of sounding like unrelated products. |
| Shared timeline feeling | 5 | RP events become shared lived memories that can subtly shape later practical and immersive replies. |
| Immersion quality | 4 | RP replies preserve character voice, scene continuity, pacing, and emotional texture without meta explanations. |
| Practical warmth | 4 | SMS replies stay concise but still feel like the same companion, not a sterile task bot. |
| Mode invisibility | 3 | User-facing copy avoids exposing `sms`, `rp`, tool, or kernel labels unless safety requires a clear boundary. |

### Task and Proactive Ability, 22 Points

| Item | Points | Evidence |
|---|---:|---|
| Calendar and schedule semantics | 5 | Create, query, update, delete, conflict, and upcoming/today distinctions work with Chinese time expressions. |
| Reminder flow | 5 | Create, due event, ack, retry, postpone, cancel, and restart recovery are testable. |
| Task flow | 4 | Task creation, due/overdue detection, status updates, and task reminders work consistently. |
| Proactive integration | 4 | Due reminders/tasks produce messages that fit the companion posture and write appropriate memory. |
| Tool loop readiness | 2 | Practical posture can support planner/tool/renderer loops without requiring end-to-end model authority. |
| Failure handling | 2 | Tool or model failure returns actionable fallback behavior instead of silent failure. |

### Memory and Boundary Control, 18 Points

| Item | Points | Evidence |
|---|---:|---|
| Long-term memory quality | 5 | User preferences, relationship facts, and high-value episodes are retained and retrievable. |
| Shared reality boundary | 4 | Real facts may influence RP pacing as read-only context but do not become fictional commitments. |
| Pollution prevention | 4 | Fictional plans do not affect real schedule judgment; real state is not overwritten by scene text. |
| Memory selection | 3 | Context uses structured memory, retrieval, importance, and recency instead of raw unbounded chat history. |
| User control | 2 | Users and test agents can inspect, disable, or clear relevant memory features. |

### Performance and Context Economy, 15 Points

The goal is sustainable long-run companionship. High quality must not rely on endlessly appending chat history.

| Item | Points | Evidence |
|---|---:|---|
| Latency | 3 | `latencyMs` and complete response time stay within scenario budgets. |
| TTFT and streaming | 2 | First visible token arrives quickly; UI exposes live streaming state and final metrics. |
| Generation throughput | 2 | `generationTokensPerSecond` and prefill rate are visible when the provider reports usable data. |
| Context window health | 3 | `contextUsageRatio` and token growth stay below thresholds during long sessions. |
| Token cost | 2 | Evaluations estimate per-turn and long-run input/output token cost when usage or estimates are available. |
| Compression and retention | 2 | Low-value history can be summarized or omitted while critical memory remains available. |
| Regression budget | 1 | Performance regressions have explicit acceptance thresholds. |

Suggested thresholds:

| Scenario | Target |
|---|---|
| SMS, 10 turns | `contextUsageRatio < 0.10`, complete response under 2 seconds without external-model network delay. |
| RP, 20 turns | `contextUsageRatio < 0.25`, key shared memories retained. |
| Mixed, 50 turns | `contextUsageRatio < 0.45`, old low-value history summarized or dropped. |
| Long run, 100 turns | Experience depends on structured memory, shared timeline, summaries, retrieval, and recent messages, not full chat replay. |

Recommended context health score:

```text
context_health =
  100
  - context_usage_penalty
  - per_turn_growth_penalty
  - critical_memory_loss_penalty
  - excessive_compression_penalty
  - high_cost_penalty
```

Every message response should be inspected for:

- `metrics.latencyMs`
- `metrics.prefillMs`
- `metrics.prefillTokens`
- `metrics.prefillTokensPerSecond`
- `metrics.generatedTokens`
- `metrics.generationTokensPerSecond`
- `metrics.tokenEstimate`
- `metrics.contextWindowTokens`
- `metrics.contextUsageRatio`
- external model `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` when available

Cost estimates must record the model price assumption used by the evaluator. If price is unknown, report tokens and mark cost as `unknown`, not zero.

### Engineering Testability, 13 Points

| Item | Points | Evidence |
|---|---:|---|
| API contract | 3 | HTTP, Python SDK, TypeScript SDK, and streaming endpoints return consistent structures. |
| Debug time and deterministic eval | 3 | `/api/debug/time` and `/api/eval/run` support repeatable accelerated tests. |
| Logs and traces | 3 | Model-call logs and context traces are inspectable and redact API secrets. |
| Feature flags | 2 | All major features can be toggled independently with graceful behavior. |
| Restart consistency | 2 | SQLite persistence survives service restart for sessions, tasks, reminders, profile, and debug settings. |

### UI Usability, 10 Points

| Item | Points | Evidence |
|---|---:|---|
| Session workflow | 2 | Create, switch, clone, clear, search, and export sessions are usable. |
| Model setup | 2 | OpenAI-compatible config supports base URL, key, model list, manual model, context window, and persistence. |
| Character setup | 2 | Character cards can be uploaded/parsed or edited manually. |
| Debug panels | 2 | Logs, context trace, metrics, feature flags, and eval artifacts are visible without blocking chat. |
| Long-run operator ergonomics | 2 | UI helps evaluate latency, token cost, context usage, and memory quality across many turns. |

## Standard Evaluation Scenarios

Each release should run at least these scenarios.

1. Practical short run: create a calendar event, reminder, task, query today/upcoming, and verify concise replies.
2. Immersive short run: create a character, run multiple RP turns, verify voice, scene continuity, shared timeline write, and no real-tool pollution.
3. Cross-posture continuity: create RP shared experience, switch to practical posture, verify subtle continuity without treating fictional details as real schedule.
4. Proactive accelerated time: create reminders/tasks, advance `/api/debug/time`, poll events, ack/retry deliveries, verify posture-aware message and memory write.
5. Feature-disable matrix: disable each major feature, call related CRUD and message flows, verify graceful `feature_disabled` actions or HTTP 403 where appropriate.
6. Context economy long run: run 20, 50, and optionally 100 mixed turns, record token growth, context usage, latency, memory retention, and cost.
7. Streaming/model diagnostics: use `/messages/stream`, verify readable deltas, final response contract, separated reasoning content, logs, metrics, and secret redaction.
8. Restart persistence: restart service or reopen storage, verify sessions, reminders, profile, model config, debug time, and pending deliveries.

## Five-Round Subagent Iteration Protocol

Use two roles:

- Evaluator: scores only. It must not modify files.
- Modifier: proposes or implements bounded changes. It must not grade its own work.

Each round:

1. Evaluator runs the standard scenarios that fit the current time budget.
2. Evaluator reports category scores, hard-gate results, evidence, and the highest-value failing issue.
3. Modifier proposes the smallest change expected to raise the weighted score or fix a hard gate.
4. Main agent accepts only changes with a clear expected score improvement and bounded risk.
5. Main agent runs verification.
6. Evaluator re-scores. If the total score does not improve and no hard gate was fixed, revert or reject the change.

Round report format:

```text
Round N
Total: X/100
Hard gates: pass/fail list
Scores:
- Personality and relationship experience: X/22
- Task and proactive ability: X/22
- Memory and boundary control: X/18
- Performance and context economy: X/15
- Engineering testability: X/13
- UI usability: X/10
Evidence:
- ...
Accepted change:
- ...
Rejected change:
- ...
Next highest-value issue:
- ...
```

## Acceptance Rules

- Accept a change when it increases total score, fixes a hard gate, or improves a high-weight category without reducing another category.
- Reject a change when it only improves demo text, hides failures, worsens safety, or increases context/token cost without quality gain.
- Prefer deterministic improvements before prompt-only improvements.
- Prefer structured memory, traces, and metrics over opaque long prompts.
- Do not use raw chain-of-thought as a user-visible or log-visible quality signal.
