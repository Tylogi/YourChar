# Release Gate

## Required local gate

Run:

```bash
npm run release:gate
```

The command stops on the first failure and runs:

1. TypeScript build.
2. All unit and integration tests.
3. CloakBrowser desktop/mobile workflows and screenshot pixel checks.
4. Sensitive-information scanning over tracked and untracked source files.
5. `git diff --check`.

Browser screenshots are written to the ignored `browser-artifacts/` directory.
The scanner checks common credential formats and rejects evaluation JSON that
contains raw `apiKey` or `baseUrl` fields. Runtime state and real credentials in
`.rp-agent/` are ignored and must never be committed.

## Pre-release real-model stage

Run the optional pre-release stage with:

```bash
RP_EVAL_REUSE_CONFIG=1 RP_EVAL_SOURCE_STATE_DIR=.rp-agent npm run release:gate:real
```

It first runs the complete deterministic gate, then adds three isolated
repetitions of the real-model scenario suite. Reports
contain only the model name, configuration source, request count, p50/p95
latency, pass rates, transparent rules, and sanitized replies. They never record
an API key or base URL. If no real configuration is available, the stage must
report unavailable/skipped; it must not be described as a pass.

The real report separates final functional success from native model success.
An exhausted output-guard recovery can satisfy a hard reminder or explicit
memory result only when its audited MCP/Coordinator state is present; it is
reported as `recoveryUsed`, never as native success. The real gate requires all
of the following without repeated sampling beyond the fixed three runs:

- system/data boundaries: 6/6;
- explicit real reminder functional result: 3/3;
- explicit remember plus managed profile functional result: 3/3;
- native model baseline: at least 29/33 scenario-runs.

Any missing hard result or boundary check fails the command even when other
model behavior passes.

The 60-turn SMS/RP stability evaluation is intentionally separate because of
cost and duration:

```bash
RP_EVAL_REUSE_CONFIG=1 npm run eval:real-model:long
```

An evaluator-only correction can be applied to an existing completed long-run
report without another provider call:

```bash
npm run eval:real-model -- --re-evaluate eval-artifacts/<long-report>.json
```

The derived report records zero model requests and must identify whether any
rules other than the intended evaluator rule changed. This path is appropriate
for a proven evaluator false positive, not for prompt, runtime, or model changes.

Re-run both real-model stages whenever the model, sampling settings, system
prompts, context assembly, tool policy, or Pi runtime version changes.
