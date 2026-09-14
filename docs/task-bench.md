# Temporary Task Bench

## Purpose

The Debug **任务测试台** evaluates one configured model or character Agent on a
user-defined task without allowing ordinary memory, relationship, World, or
conversation history to affect the result. It is separate from built-in feature
tests: feature tests validate fixed product contracts, while the task bench is
for ad hoc tasks, repeated trials, custom acceptance checks, and comparison.

## Target modes

- **Character Agent** copies the selected character's name and `SOUL.md`.
  Character-owned active Skills and the bound meeting preset are optional and
  enabled by default. No character memory, relationship state, World state,
  user profile, or transcript is copied.
- **Generic Agent** creates a neutral task-execution identity. It does not copy
  any selected character context.

Both modes still exercise the normal Agent runtime and its tool protocol. The
selected model replaces the disposable runtime's default model, including tool
continuations. Enabled non-memory modules and current Workspace/shell/network
permissions are inherited. Memory Coordinator, User Profile, and Relationship
State modules, plus every profile/SOUL/Skill/memory write permission, are
forcibly disabled in the disposable runtime.

Deployment capability code is not inherited by default. A trusted capability
must explicitly declare that it is safe to reconstruct from a fresh Task Bench
mount scope; only those active definitions and their module contributions enter
the disposable runtime. Optional LSP navigation uses this seam, allowing a
module-off baseline and module-on variant without exposing the source runtime's
Workspace or provider processes.

## Isolation lifecycle

Every repetition receives a new state directory, SQLite database, conversation,
and Workspace. Fixtures may come from explicitly listed source Workspace paths
or files uploaded directly on the task-bench page. Only those selected files are
copied into the disposable runtime's `uploads/`; no other normal Workspace file
is visible. After the reply, checks, file manifest, and usage evidence have been
collected, the runtime is disposed and the directory is recursively deleted.

Direct uploads never enter the normal Workspace or persistent state. The server
keeps them in memory so the same selection can be reused for repeated and A/B
runs on the current page. Each file is limited to 20 MiB, all pending task-bench
uploads are limited to 80 MiB, and the browser UI allows at most 20 files.
Removing a file or closing the page requests immediate deletion; one-hour expiry
and process shutdown provide server-side cleanup fallbacks.

Completed reports are stored in the local application database and remain
available after a browser refresh or service restart. This includes runs
started through the HTTP API rather than the current browser tab. The task-bench
page loads the newest report automatically, polls for newly completed API runs,
and lets a user reopen prior reports before exporting JSON or Markdown. A
report may contain the task, reference answer, model reply, Judge reasons, and
fixture names, so it is treated as user data and removed by the full user-data
deletion flow.

On the first startup after this storage was introduced, valid JSON exports in
`<stateDir>/workspace/task-bench-results/` are imported once. The original
Workspace files are left unchanged.

## Scoring

Each repetition has two evidence lanes:

1. **Hard checks** verify turn completion, required/forbidden phrases, optional
   JSON syntax, and exact output-file paths. Zero-memory isolation is also a
   non-scored hard gate. A failed hard gate always fails the repetition.
2. **LLM-as-Judge** is optional. The selected Judge receives the task, custom
   rubric, optional reference answer, trusted hard-check/file evidence, and the
   candidate reply. It does not receive the target profile name or model name.

The Judge scores correctness, instruction following, completeness, evidence
quality, and communication quality from 0 to 5. Character mode adds role
fidelity. Output is validated against a strict JSON schema and retried once if
malformed. A requested but failed/skipped Judge leaves the run unscored and the
run cannot pass.

With a Judge, the default score is:

```text
overall = hard checks * 0.40 + Judge * 0.60
```

The Judge weight and pass threshold are configurable. Without a Judge, hard
checks carry 100% of the score. The report keeps the hard-gate result separate
so fluent prose cannot hide a missing file or failed execution.

Repeated trials are independent. The summary reports pass rate, mean hard and
Judge scores, mean and population standard deviation of the combined score,
latency, model/Judge requests, and measured token usage when the provider
reports it.

Each target repetition has a configurable deadline from 1 second through two
hours; the UI offers 5, 15, 30, 60, and 120 minutes and defaults to 30 minutes
for local models. The Judge has a separate deadline up to one hour and defaults
to 10 minutes. A reached deadline is reported as `timed_out`, never as a user
cancellation. A target timeout skips Judge scoring for that repetition, while a
Judge timeout makes the score unavailable without retrying an already expired
deadline.

## HTTP API

Upload a temporary fixture as a binary request body before starting a run:

```text
POST /api/v1/task-bench/uploads?name=interim-report.pdf
Content-Type: application/pdf
```

The response is `{"upload":{"id":"...", ...}}`. Pass that `id` in
`uploadIds`; it remains reusable until removed or expired. Remove it explicitly
with `DELETE /api/v1/task-bench/uploads/{id}`.

`POST /api/v1/task-bench/run` accepts:

```json
{
  "name": "半年报分析",
  "targetMode": "character",
  "characterId": "character-id",
  "modelProfileId": "target-profile-id",
  "judgeModelProfileId": "judge-profile-id",
  "task": "分析附件并给出结论与风险。",
  "rubric": "所有结论必须能由报告期内数据支持。",
  "referenceAnswer": "可选，仅 Judge 可见。",
  "repetitions": 3,
  "timeoutSeconds": 1800,
  "judgeTimeoutSeconds": 600,
  "passThreshold": 70,
  "judgeWeight": 0.6,
  "includeCharacterSkills": true,
  "includeMeetingPreset": true,
  "workspacePaths": [],
  "uploadIds": ["task-upload-id"],
  "assertions": {
    "requiredPhrases": ["主要风险"],
    "forbiddenPhrases": ["保证上涨"],
    "requiredFiles": ["outputs/analysis.md"],
    "responseMustBeJson": false
  }
}
```

The response contains `report` (the complete JSON-safe evaluation report) and
`markdown` (a human-readable export). Each `report.fixtures` entry records
whether it came from `workspace` or `temporary_upload`, plus its name and size.
It never contains API keys, provider base URLs, temporary host paths, upload
IDs, file bytes, or tool payload arguments.

List saved report summaries or retrieve one complete report with:

```text
GET /api/v1/task-bench/reports?limit=50
GET /api/v1/task-bench/reports/{reportId}
```

The list endpoint omits the task, reference answer, candidate replies, and
per-run details. The detail endpoint returns the same `report` and `markdown`
shape as the run endpoint.

For fair A/B comparisons, keep the task, fixtures, target mode, character
context switches, enabled capabilities, Judge profile, Judge weight, pass
threshold, timeout settings, and repetition count constant. Prefer an
independent Judge; the UI marks same-model self-evaluation explicitly.

For an LSP A/B, use repository fixtures that require cross-file semantic
navigation. Run once with `mcp:lsp-navigation` disabled and once enabled; keep
Workspace and shell permissions unchanged. Reports include bounded
`lsp_navigation` action evidence so tool availability is not mistaken for tool
use.
