from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..harness import AgentHarness, AgentToolCall, AgentToolResult
from ..models import MessageRequest
from ..storage import Storage
from .context import ContextAssembly, ContextBuilder
from .planner import Plan, Planner
from .renderer import Renderer
from .tools import ExecutionResult, ToolExecutor


@dataclass(frozen=True)
class PreparedTurn:
    context: ContextAssembly
    execution: ExecutionResult
    fallback_reply: str
    planner_ms: float
    context_ms: float
    tool_ms: float
    harness_events: list[dict[str, Any]] = field(default_factory=list)


class CompanionAgent:
    """Product-domain adapter around the generic agent harness."""

    def __init__(
        self,
        *,
        storage: Storage,
        planner: Planner | None = None,
        context_builder: ContextBuilder | None = None,
        executor: ToolExecutor | None = None,
        renderer: Renderer | None = None,
    ) -> None:
        self.storage = storage
        self.planner = planner or Planner()
        self.context_builder = context_builder or ContextBuilder(storage)
        self.executor = executor or ToolExecutor(storage)
        self.renderer = renderer or Renderer()
        self.harness = AgentHarness(_CompanionTurnHandler(self))

    def prepare_message(self, session_id: str, request: MessageRequest) -> PreparedTurn:
        result = self.harness.run(session_id=session_id, request=request)
        return PreparedTurn(
            context=result.context,
            execution=result.scratchpad["execution"],
            fallback_reply=result.reply,
            planner_ms=result.timings.planner_ms,
            context_ms=result.timings.context_ms,
            tool_ms=result.timings.tool_ms,
            harness_events=[event.to_dict() for event in result.events],
        )


class _CompanionTurnHandler:
    def __init__(self, agent: CompanionAgent) -> None:
        self.agent = agent

    def build_context(
        self, session_id: str, request: MessageRequest, scratchpad: dict[str, Any]
    ) -> ContextAssembly:
        context = self.agent.context_builder.build(session_id, request)
        scratchpad["context"] = context
        return context

    def plan(self, request: MessageRequest, scratchpad: dict[str, Any]) -> Plan:
        plan = self.agent.planner.plan(request)
        scratchpad["plan"] = plan
        scratchpad["execution"] = ExecutionResult()
        return plan

    def tool_calls_from_plan(
        self, plan: Plan, scratchpad: dict[str, Any]
    ) -> list[AgentToolCall]:
        calls: list[AgentToolCall] = []
        for index, operation in enumerate(plan.operations):
            if operation.op_type == "noop":
                continue
            calls.append(
                AgentToolCall(
                    id=f"tool_{index}_{operation.op_type}",
                    name=operation.op_type,
                    arguments=operation.payload,
                    metadata={
                        "feature": operation.feature,
                        "requiresConfirmation": operation.requires_confirmation,
                        "reason": operation.reason,
                        "operationIndex": index,
                    },
                )
            )
        return calls

    def execute_tool_call(
        self,
        session_id: str,
        request: MessageRequest,
        plan: Plan,
        tool_call: AgentToolCall,
        scratchpad: dict[str, Any],
    ) -> AgentToolResult:
        operation_index = int(tool_call.metadata.get("operationIndex", 0))
        operation = plan.operations[operation_index]
        single_plan = Plan(
            operations=[operation],
            parsed_time=plan.parsed_time,
            now=plan.now,
        )
        partial = self.agent.executor.execute(session_id, request, single_plan)
        execution: ExecutionResult = scratchpad["execution"]
        execution.actions.extend(partial.actions)
        execution.confirmations.extend(partial.confirmations)
        for key, value in partial.artifacts.items():
            if isinstance(value, list):
                execution.artifacts.setdefault(key, []).extend(value)
            else:
                execution.artifacts[key] = value
        action = partial.actions[-1] if partial.actions else None
        return AgentToolResult(
            tool_call_id=tool_call.id,
            tool_name=tool_call.name,
            content=action.status if action else "completed",
            is_error=bool(action and action.status in {"failed", "feature_disabled"}),
            metadata=action.model_dump(mode="json", by_alias=True) if action else {},
        )

    def render(self, request: MessageRequest, scratchpad: dict[str, Any]) -> str:
        execution: ExecutionResult = scratchpad["execution"]
        session_id = scratchpad["messages"][0].metadata.get("sessionId")
        return self.agent.renderer.render(
            request,
            execution,
            storage=self.agent.storage,
            session_id=session_id,
        )
