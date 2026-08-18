# MCP Agent Modules and Proactive Events

Status: implemented baseline
Last updated: 2026-07-14

This document defines the reusable boundary for adding domain capabilities to
YourChar. Schedule is the first implementation. Memory, external services, and
other future modules should follow the same shape unless they have a documented
reason not to.

## 1. Design rules

1. Pi owns conversation state and decides when a tool is needed.
2. Domain capabilities are exposed by MCP servers, not embedded in prompts or
   implemented as message keyword routers.
3. MCP handlers call application services. They do not contain SQL, model calls,
   or UI logic.
4. The trusted domain layer resolves clocks, timezones, authorization,
   idempotency, and persistence. The model does not calculate authoritative UTC
   instants.
5. Every mutation is schema-validated, policy-checked, idempotent, and audited.
6. Background events resume an existing Pi conversation through a custom system
   message. They are not represented as user-authored chat.

## 2. Runtime topology

```text
User message
    |
Pi AgentSession + model
    |
Pi ToolDefinition (generic MCP adapter)
    |
MCP tools/call over JSON-RPC
    |
Domain MCP server
    |
Application service -> repository -> SQLite
```

Pi 0.80.3 deliberately has no built-in MCP host. YourChar therefore owns a
generic adapter in `src/mcp/pi-adapter.ts`. It performs MCP initialization,
`tools/list`, JSON Schema to TypeBox exposure, `tools/call`, cancellation, and
error/result mapping. The current transport is an official linked in-memory MCP
transport. The protocol boundary is real; replacing it with stdio or Streamable
HTTP must not change Pi or domain tools.

Each Pi session has its own MCP connection. This gives handlers stable
conversation provenance while the underlying `ScheduleService` and SQLite
database remain shared.

## 3. Schedule MCP contract

The `rp-agent-schedule` server exposes:

```text
create_schedule_item
list_schedule_items
update_schedule_item
complete_schedule_item
cancel_schedule_item
snooze_reminder
```

For relative and local-language time, the Agent passes the original phrase in
`timeExpression`:

```json
{
  "kind": "reminder",
  "title": "喝水",
  "timeExpression": "五分钟后",
  "timezone": "Asia/Shanghai"
}
```

The MCP server resolves this against its injected `Clock`. `startAt` remains
available for an already explicit ISO instant. If a model supplies both fields,
`timeExpression` is authoritative and the model-calculated `startAt` is ignored.
Tool call IDs travel in MCP request metadata and become idempotency keys. Audit
records include `transport: "mcp"`, the time source, and the MCP server name.

## 4. Intent and confirmation policy

With a configured model, natural-language schedule requests always enter Pi.
The Agent either asks for a missing field or calls MCP. Keyword parsing is only
an offline fallback when no model is enabled.

- An explicit SMS reminder is created without redundant confirmation.
- Ambiguous time is clarified before mutation.
- RP fictional content cannot mutate real schedules.
- An RP request for a real mutation is blocked by Pi's tool hook and stored as a
  pending confirmation.
- Destructive or non-unique targets require explicit selection/confirmation.

Policy remains outside the MCP transport adapter. The adapter is reusable; the
Pi tool hook is the conversation authorization boundary; the domain service is
the invariant-validation boundary.

## 5. Proactive reminder flow

```text
due occurrence
    |
scheduler claims unique outbox row
    |
sourceSessionId resolves original Pi session
    |
custom `rp-agent/reminder_due` message triggers Agent turn
    |
Agent sees transcript + RP context + trusted due-event payload
    |
assistant reply is persisted in the same transcript
    |
title/body are frozen in outbox
    |
notification sink delivers; retries reuse frozen payload
```

The custom due event is hidden from normal chat rendering and converted to
model context as a system-originated event. Mutating tools are blocked during
this turn. The event payload is treated as data to prevent reminder titles or
notes from injecting instructions.

If the source conversation or model configuration is unavailable, the composer
falls back to a deterministic static body. A sink failure retries the persisted
body and never generates a second Agent turn. Open browser clients poll the
active transcript every three seconds so proactive assistant messages appear
without a manual refresh.

## 6. Adding another MCP module

1. Define a narrow application service and repository boundary.
2. Create `src/mcp/<module>-server.ts` with Zod input schemas and structured
   results.
3. Connect it through `connectMcpServerToPi`; do not write another Pi adapter.
4. Add tool names to the allowed set and mutating tools to the policy set.
5. Propagate Pi tool call IDs for idempotency and add transport-aware audit data.
6. Test the server directly through an MCP `Client` and `tools/call`.
7. Test one scripted Pi turn proving model request, MCP invocation, persistence,
   and final reply.
8. For background behavior, define a typed event and reuse the custom-message
   resume pattern; persist generated output before external delivery.

## 7. Required tests

- MCP discovery exposes the expected JSON Schema.
- Direct MCP calls exercise the real service and repository.
- A scripted Pi model invokes the MCP tool from natural language.
- Policy blocks unauthorized mutations before `tools/call`.
- Replayed tool call IDs do not duplicate effects.
- Background events restore the source transcript and context.
- Notification retries do not produce a second Agent message.
- Model-disabled fallback remains deterministic.
- Provider request traces include each tool-loop call, preserve complete message
  and MCP tool-schema payloads. The Debug store retains only the latest 10 calls;
  the separately enabled JSONL archive retains every subsequent sanitized call.
