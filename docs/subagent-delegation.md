# Private-Chat Subagent Delegation

Status: implemented baseline

## Product boundary

Subagents support bounded work inside direct SMS or RP conversations. They are
not roleplay characters and are not part of group-chat participation. A parent
Agent may use `delegate_task` for independent work, research, planning, or
review, then present the returned result in its own character voice.

`mcp:subagent` is disabled by default because every delegation creates extra
model calls. The capability is managed through the existing MCP/Skill page and
uses the current direct character's model profile. The model profile and API
credential are resolved by the trusted runtime; neither is selectable through
tool arguments.

## Runtime topology

```text
Direct Pi AgentSession
  -> delegate_task MCP call
  -> temporary in-process Pi AgentSession
  -> optional read-only child tools
  -> bounded final result
  -> parent MCP tool result
  -> parent Pi AgentSession resumes
```

The child receives no parent transcript, SOUL.md, user profile, memory, scene,
or turn context. The parent must provide a self-contained task and only the
supporting context required to complete it. The child result becomes an
ordinary persisted tool result in the parent Pi transcript.

## Child roles

- `worker`: complete a general bounded task.
- `researcher`: gather and compare evidence and preserve useful URLs.
- `planner`: produce an actionable dependency-aware plan.
- `reviewer`: independently identify correctness and risk findings.

## Permission contract

The child can receive only capabilities already enabled for the application:

- enabled Skill content through the restricted `read` tool;
- Workspace `read`, `read_document`, and `list_workspace`, downgraded to
  read-only even when the parent has read-write access; document conversion
  remains local and network-isolated;
- Tavily Search when both its module and credential are available;
- Web Reader when its module is enabled, with the same public-network and
  untrusted-content boundaries as the parent session;
- Vision MCP when its module and independent vision configuration are available.

The child never receives Workspace write/edit, shell, schedules, memory,
profile, character SOUL, scene mutation, or `delegate_task`. It therefore
cannot increase its permission scope or recursively create another Agent.

`delegate_task` is treated as a metered operation and is blocked while the
runtime composes background reminder messages.

## Budgets and lifecycle

- task: at most 4,000 Unicode characters;
- supporting context: at most 8,000 Unicode characters;
- final output: 64,000 Unicode characters by default, configurable from 1,000 to 200,000;
- per-call model output: 16,384 tokens by default, configurable from 512 to 65,536;
- model calls: 32 work calls by default, configurable from 1 to 64, plus one reserved tool-free finalization call per child;
- hard wall time: 30 minutes by default, configurable from 60 to 3,600 seconds; model or tool activity never extends it;
- concurrency: 4 children per parent session by default, configurable from 1 to 8.

These values are stored in the singleton Subagent runtime settings row. Updates
use a revision compare-and-swap so an older settings page cannot overwrite a
newer edit. Each delegated task freezes all five values once at admission;
later settings changes affect only new tasks. Settings mutation requires an idle
control plane and rebuilds existing session capabilities. The MCP transport
deadline is derived from the handle's task deadline with 30 seconds of grace,
so the child runtime remains the authoritative timeout.

Delegated provider requests disable Pi and Undici's independent five-minute
idle cutoffs with a child-scoped direct transport. The configured hard wall
time and caller cancellation remain authoritative; this does not change the
transport behavior of parent sessions or unrelated application requests.

The current turn gives delegated results their own active-context pool. A
single result can use its configured result limit plus a small MCP envelope;
parallel delegated results share that configured total. Provider context-window
limits can still require compaction even though the full bounded result remains
in the transcript.

Parent cancellation propagates to the child. Child sessions are in-memory and
disposed after the tool finishes; only the MCP result, audit metadata, and
bounded provider Trace are retained. Audits store task length and SHA-256, not
the raw delegated task.

## Observability and testing

Provider requests use the `subagent` Debug Trace kind and a synthetic
`subagent:<parent-session>:<run-id>` session ID. The normal chat execution panel
shows `delegate_task` as a collapsible tool call and exposes the final child
result only when expanded.

Regression tests must preserve:

- default-disabled capability and persisted module toggling;
- parent-to-child-to-parent model ordering;
- absence of parent private context from the child prompt;
- child read-only tool allowlist and no recursive delegation;
- group actors receiving no subagent tool;
- audit redaction, usage details, Trace persistence, cancellation, and limits;
- management-page detail and token-estimate rendering.
