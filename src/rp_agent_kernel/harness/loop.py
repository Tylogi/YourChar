from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from .events import AgentEvent, AgentEventSink
from .messages import AgentMessage, AgentToolCall, AgentToolResult


@dataclass(frozen=True)
class TurnTimings:
    context_ms: float = 0
    planner_ms: float = 0
    tool_ms: float = 0


@dataclass
class AgentLoopResult:
    context: Any
    plan: Any
    reply: str
    timings: TurnTimings
    events: list[AgentEvent] = field(default_factory=list)
    scratchpad: dict[str, Any] = field(default_factory=dict)


class AgentTurnHandler(Protocol):
    """Domain adapter consumed by the generic harness loop."""

    def build_context(
        self, session_id: str, request: Any, scratchpad: dict[str, Any]
    ) -> Any:
        ...

    def plan(self, request: Any, scratchpad: dict[str, Any]) -> Any:
        ...

    def tool_calls_from_plan(
        self, plan: Any, scratchpad: dict[str, Any]
    ) -> list[AgentToolCall]:
        ...

    def execute_tool_call(
        self,
        session_id: str,
        request: Any,
        plan: Any,
        tool_call: AgentToolCall,
        scratchpad: dict[str, Any],
    ) -> AgentToolResult:
        ...

    def render(self, request: Any, scratchpad: dict[str, Any]) -> str:
        ...


class AgentHarness:
    """Small Pi-style turn loop for the Python companion kernel.

    The loop owns lifecycle sequencing and events. The domain handler owns
    product-specific context, intent planning, tool execution, and rendering.
    """

    def __init__(self, handler: AgentTurnHandler) -> None:
        self.handler = handler

    def run(
        self,
        *,
        session_id: str,
        request: Any,
        sink: AgentEventSink | None = None,
    ) -> AgentLoopResult:
        events: list[AgentEvent] = []

        def emit(event_type: str, **payload: Any) -> None:
            event = AgentEvent(event_type, payload)
            events.append(event)
            if sink is not None:
                sink(event)

        scratchpad: dict[str, Any] = {
            "messages": [
                AgentMessage(
                    role="user",
                    content=getattr(request, "text", ""),
                    metadata={
                        "sessionId": session_id,
                        "mode": getattr(request, "mode", None),
                        "characterId": getattr(request, "character_id", None),
                    },
                )
            ]
        }

        emit("agent_start", sessionId=session_id)
        emit("turn_start", sessionId=session_id)
        emit("message_start", role="user")
        emit("message_end", role="user")

        context_start = time.perf_counter()
        context = self.handler.build_context(session_id, request, scratchpad)
        context_ms = _elapsed_ms(context_start)
        emit("context_ready", traceId=getattr(context, "trace_id", None))

        planner_start = time.perf_counter()
        plan = self.handler.plan(request, scratchpad)
        planner_ms = _elapsed_ms(planner_start)
        emit(
            "plan_ready",
            operationCount=len(getattr(plan, "operations", []) or []),
        )

        tool_start = time.perf_counter()
        for tool_call in self.handler.tool_calls_from_plan(plan, scratchpad):
            emit(
                "tool_execution_start",
                toolCallId=tool_call.id,
                toolName=tool_call.name,
                arguments=tool_call.arguments,
            )
            result = self.handler.execute_tool_call(
                session_id,
                request,
                plan,
                tool_call,
                scratchpad,
            )
            emit(
                "tool_execution_end",
                toolCallId=result.tool_call_id,
                toolName=result.tool_name,
                isError=result.is_error,
                metadata=result.metadata,
            )
        tool_ms = _elapsed_ms(tool_start)

        reply = self.handler.render(request, scratchpad)
        scratchpad["messages"].append(
            AgentMessage(
                role="assistant",
                content=reply,
                metadata={"sessionId": session_id},
            )
        )
        emit("message_start", role="assistant")
        emit("message_end", role="assistant")
        emit("turn_end", sessionId=session_id)
        emit("agent_end", sessionId=session_id)

        return AgentLoopResult(
            context=context,
            plan=plan,
            reply=reply,
            timings=TurnTimings(
                context_ms=context_ms,
                planner_ms=planner_ms,
                tool_ms=tool_ms,
            ),
            events=events,
            scratchpad=scratchpad,
        )


def _elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000
