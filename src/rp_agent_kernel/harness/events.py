from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class AgentEvent:
    """Stable internal lifecycle event emitted by the agent harness."""

    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "createdAt": self.created_at.isoformat(),
            **self.payload,
        }


AgentEventSink = Callable[[AgentEvent], None]
