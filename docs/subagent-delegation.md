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
- final output: at most 12,000 Unicode characters;
- model calls: at most 8 per child;
- wall time: at most 90 seconds;
- concurrency: at most 3 children per parent session.

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
