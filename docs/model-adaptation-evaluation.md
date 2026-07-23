# Model Adaptation Evaluation

## Purpose

Model adaptation is evaluated on two independent evidence lanes:

1. **Functional completeness** uses deterministic assertions over tool calls,
   persisted state, coordinator output, and the visible turn status.
2. **Reply quality** uses an explicitly selected LLM Judge with a fixed absolute
   rubric over the user-visible response.

The Judge never decides whether a reminder, memory, relationship update, World
event, file mutation, or MCP call really succeeded. A fluent response cannot
turn a failed functional assertion into a pass.

## Isolated target-model execution

Each built-in case runs in a temporary `CompanionKernel` state directory. The
selected target profile replaces both the sandbox default model and the test
character/World bindings. This means the same target model is exercised for:

- the interactive private or World response;
- tool selection and continuation;
- memory, relationship, and post-turn analysis;
- World planning/analysis used by the case;
- subagent and proactive-message decisions created inside the sandbox.

The selected character contributes its name, SOUL, and confirmed memories, but
all test writes stay in the temporary directory. External dependencies such as
Tavily and Vision retain their configured isolated adapters.

Preflight rules are tagged separately from functional rules. A disabled module,
missing permission, missing external Key, or unavailable vision path blocks the
case and lowers execution coverage; it is not inserted into the deterministic
functional-rule denominator.

## Functional score

For each runnable case:

```text
case functional score = passed functional assertions / all functional assertions * 100
```

The report functional score is the unweighted mean of runnable case scores, so
a case with more implementation assertions does not dominate the suite. The
report separately exposes:

- passed and selected case counts;
- blocked case count and blocker evidence;
- execution coverage (`runnable / selected`).

A report with low execution coverage must not be interpreted as broad model
compatibility, even when its score on the few runnable cases is high.

## LLM-as-Judge protocol

The Judge receives the case goal, user input, bounded character SOUL reference,
case-specific quality criteria, and the actual user-visible quality sample. For
proactive and cross-character cases, the quality sample is the delivered
message, not the earlier trigger response.

The Judge assigns 0-5 points on five dimensions:

| Dimension | Meaning |
|---|---|
| `instruction_following` | Satisfies the visible request and case goal |
| `role_fidelity` | Preserves private-character voice or World narrative contract |
| `coherence` | Clear, self-consistent, and logically connected |
| `naturalness` | Natural and specific rather than robotic or mechanism-facing |
| `contextual_fit` | Fits the time, scene, and supplied context without key fabrication |

Anchors are fixed: `0` unusable/severe violation, `1` severe defects, `2`
material defects, `3` acceptable, `4` good, and `5` excellent. The five scores
are averaged and normalized to 100.

Judge output must match a strict JSON schema containing per-dimension reasons,
a concise summary, flags, and confidence. The call uses temperature zero and the
background no-thinking policy. Invalid JSON is retried once. A failed or skipped
Judge remains `quality unavailable`; deterministic evidence remains valid.

Test data is delimited as untrusted content in the Judge prompt. This reduces,
but cannot eliminate, prompt-injection and self-preference bias. Use one strong,
independent Judge profile for every target in a comparison. Do not compare
reports scored by materially different Judges as if they shared one scale.

## Aggregate score and labels

When both lanes are available:

```text
overall = functional * 0.70 + quality * 0.30
```

When no reply-quality score is available, the UI falls back to the functional
score and marks quality as unavailable. Compatibility labels are:

| Overall | Label |
|---:|---|
| 90-100 | highly adapted |
| 80-89.9 | good |
| 65-79.9 | usable |
| 50-64.9 | limited |
| below 50 | poor |

These labels are diagnostics, not a release gate by themselves. Hard reminder,
memory, safety-boundary, and data-isolation requirements still need explicit
zero-tolerance gates.

## API and Debug UI

`POST /api/v1/feature-tests/{caseId}/run` accepts:

```json
{
  "characterId": "character-id",
  "modelProfileId": "target-profile-id",
  "judgeModelProfileId": "judge-profile-id"
}
```

The response contains `result`, `functional`, and optional `quality` objects.
The Debug **功能测试** page runs selected cases sequentially, displays each
assertion and Judge reason, and keeps the latest ten report summaries for the
current page lifetime. JSON export is explicit and contains model/profile names,
test inputs, sanitized replies, scores, and evidence. It never includes an API
Key or Base URL.

For fair comparisons, hold the character, test selection, enabled modules,
permissions, external services, Judge profile, and target sampling settings
constant. Record blocked cases rather than silently dropping them.
