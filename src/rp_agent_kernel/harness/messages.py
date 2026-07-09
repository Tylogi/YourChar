from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class AgentMessage:
    """Provider-neutral message used inside the harness.

    Conversion to a concrete model/provider message happens at the model
    boundary. Runtime-only notifications can stay in this form without being
    blindly sent to the model.
    """

    role: Literal["user", "assistant", "tool", "system", "event"]
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentToolCall:
    """A planned tool call with stable metadata for audit/debug."""

    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentToolResult:
    """Result of one tool call in harness order."""

    tool_call_id: str
    tool_name: str
    content: str
    is_error: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
