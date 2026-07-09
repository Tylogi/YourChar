"""Runtime harness primitives for the companion kernel.

The harness package owns agent-loop mechanics: events, internal messages,
tool-call lifecycle, and queue-friendly turn execution. Domain code plugs into
these primitives instead of embedding orchestration directly in the kernel.
"""

from .events import AgentEvent, AgentEventSink
from .loop import AgentHarness, AgentLoopResult, AgentTurnHandler, TurnTimings
from .messages import AgentMessage, AgentToolCall, AgentToolResult

__all__ = [
    "AgentEvent",
    "AgentEventSink",
    "AgentHarness",
    "AgentLoopResult",
    "AgentMessage",
    "AgentToolCall",
    "AgentToolResult",
    "AgentTurnHandler",
    "TurnTimings",
]
