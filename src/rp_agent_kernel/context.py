from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import timedelta

from .models import ContextTraceBlock, FeatureName, MessageRequest
from .storage import Storage
from .timeparse import ensure_tz


@dataclass(frozen=True)
class ContextAssembly:
    blocks: list[ContextTraceBlock]
    trace_id: str | None
    token_estimate: int


class ContextBuilder:
    CONTRACT_VERSION = "kernel-contract-v1"

    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def build(self, session_id: str, request: MessageRequest) -> ContextAssembly:
        now = ensure_tz(request.now, request.timezone)
        flags = self.storage.feature_flags_json()
        blocks: list[ContextTraceBlock] = []

        blocks.append(
            self._block(
                block_id="stable:contract:v1",
                layer="stable",
                name="System contract",
                source="kernel",
                text=(
                    "Headless companion kernel. The same companion can take a practical posture "
                    "for real-world tasks or an immersive posture for roleplay. Shared timeline "
                    "episodes can shape tone and continuity, but only explicit real-world intent "
                    "can create, modify, or delete real calendar, task, and reminder state."
                ),
            )
        )
        enabled_tools = ",".join(sorted(name for name, enabled in flags.items() if enabled))
        blocks.append(
            self._block(
                block_id=f"stable:tools:v1:{hashlib.sha1(enabled_tools.encode()).hexdigest()[:8]}",
                layer="stable",
                name="Tool schema",
                source="feature_flags",
                text=f"Enabled features: {enabled_tools}",
            )
        )
        blocks.append(
            self._block(
                block_id=f"stable:mode:v1:{request.mode}",
                layer="stable",
                name="Mode rules",
                source="mode",
                text=_mode_rules(request.mode),
            )
        )

        if self.storage.is_enabled(FeatureName.companion_persona):
            blocks.append(
                self._block(
                    block_id="semi:companion-persona:v1",
                    layer="semi_stable",
                    name="Companion persona",
                    source="companion_persona",
                    text=(
                        "One continuous companion, not two separate bots. SMS is the practical, "
                        "clear posture; RP is the embodied, scene-aware posture. Avoid exposing "
                        "mode labels unless safety requires a real-world boundary."
                    ),
                )
            )

        if self.storage.is_enabled(FeatureName.shared_timeline):
            episodes = self.storage.list_shared_episodes(
                session_id=session_id,
                character_id=request.character_id if request.mode == "rp" else None,
                limit=6,
            )
            blocks.append(
                self._block(
                    block_id="semi:shared-timeline:v1",
                    layer="semi_stable",
                    name="Shared timeline",
                    source="shared_timeline",
                    text=_format_shared_timeline(episodes),
                )
            )

        if request.mode == "sms" and self.storage.is_enabled(FeatureName.secretary_memory):
            memories = self.storage.recent_memories(mode="sms", session_id=session_id, limit=6)
            blocks.append(
                self._block(
                    block_id="semi:secretary-memory:v1",
                    layer="semi_stable",
                    name="Secretary memory",
                    source="memories.sms",
                    text="\n".join(memory.content for memory in memories) or "No secretary memory.",
                )
            )
        if request.mode == "rp" and self.storage.is_enabled(FeatureName.characters) and request.character_id:
            try:
                character = self.storage.get_character(request.character_id)
                blocks.append(
                    self._block(
                        block_id=f"semi:character:v1:{character.id}",
                        layer="semi_stable",
                        name="Character card",
                        source="characters",
                        text=f"{character.name}\n{character.persona}\n{character.scenario}",
                    )
                )
            except KeyError:
                blocks.append(
                    self._block(
                        block_id=f"semi:character-missing:v1:{request.character_id}",
                        layer="semi_stable",
                        name="Character card missing",
                        source="characters",
                        text=f"Character {request.character_id} was requested but not found.",
                    )
                )
        if request.mode == "rp" and self.storage.is_enabled(FeatureName.rp_memory):
            memories = self.storage.recent_memories(
                mode="rp", session_id=session_id, character_id=request.character_id, limit=6
            )
            memories = _filter_memories_for_context(memories, request)
            blocks.append(
                self._block(
                    block_id="semi:rp-memory:v1",
                    layer="semi_stable",
                    name="RP memory",
                    source="memories.rp",
                    text="\n".join(memory.content for memory in memories) or "No RP memory.",
                )
            )

        blocks.append(
            self._block(
                block_id="dynamic:time",
                layer="dynamic",
                name="Current time",
                source="request",
                text=f"now={now.isoformat()} timezone={request.timezone}",
            )
        )
        include_real_state = _include_real_state(request)
        if include_real_state and self.storage.is_enabled(FeatureName.calendar):
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=7)
            events = self.storage.list_events(start, end)
            blocks.append(
                self._block(
                    block_id="dynamic:calendar:7d",
                    layer="dynamic",
                    name="Upcoming calendar",
                    source="calendar_events",
                    text="\n".join(
                        f"{event.start.isoformat()} {event.title}" for event in events
                    )
                    or "No upcoming events.",
                )
            )
        if include_real_state and self.storage.is_enabled(FeatureName.reminders):
            reminders = self.storage.list_reminders()[:8]
            blocks.append(
                self._block(
                    block_id="dynamic:reminders",
                    layer="dynamic",
                    name="Reminders",
                    source="reminders",
                    text="\n".join(
                        f"{reminder.remind_at.isoformat()} {reminder.title} {reminder.status}"
                        for reminder in reminders
                    )
                    or "No reminders.",
                )
            )
        if self.storage.is_enabled(FeatureName.fts_search):
            search_mode = "rp" if request.mode == "rp" else "sms"
            memory_feature = FeatureName.rp_memory if request.mode == "rp" else FeatureName.secretary_memory
            if self.storage.is_enabled(memory_feature):
                memories = self.storage.search_memories(
                    mode=search_mode,
                    query=request.text[:64],
                    character_id=request.character_id if request.mode == "rp" else None,
                    limit=5,
                )
                memories = _filter_memories_for_context(memories, request)
                blocks.append(
                    self._block(
                        block_id=f"dynamic:memory-search:{search_mode}",
                        layer="dynamic",
                        name="Memory retrieval",
                        source="memory_search",
                        text="\n".join(memory.content for memory in memories) or "No retrieved memories.",
                    )
                )
        recent = self.storage.recent_messages(session_id, limit=8)
        blocks.append(
            self._block(
                block_id="dynamic:recent-messages",
                layer="dynamic",
                name="Recent messages",
                source="messages",
                text="\n".join(f"{item['role']}: {item['content']}" for item in recent) or "No recent messages.",
            )
        )

        token_estimate = sum(block.token_count for block in blocks)
        trace_id = None
        if self.storage.is_enabled(FeatureName.context_trace):
            trace = self.storage.create_context_trace(
                session_id=session_id,
                mode=request.mode,
                character_id=request.character_id,
                blocks=blocks,
                feature_flags=flags,
            )
            trace_id = trace.id
        return ContextAssembly(blocks=blocks, trace_id=trace_id, token_estimate=token_estimate)

    def _block(
        self,
        *,
        block_id: str,
        layer: str,
        name: str,
        source: str,
        text: str,
        truncated: bool = False,
    ) -> ContextTraceBlock:
        return ContextTraceBlock(
            id=block_id,
            layer=layer,
            name=name,
            hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            tokenCount=max(1, len(text) // 4),
            source=source,
            truncated=truncated,
        )


def _mode_rules(mode: str) -> str:
    if mode == "sms":
        return (
            "Reply briefly from the practical posture of the same companion. Use only real-world "
            "memory and explicit real-world intent for tools; shared timeline may shape wording."
        )
    return (
        "Reply with immersive prose from the embodied posture of the same companion. Reality may "
        "softly shape pacing and care; real-world tools require explicit real-world phrasing."
    )


def _include_real_state(request: MessageRequest) -> bool:
    if request.mode == "sms":
        return True
    text = request.text.strip()
    return text.startswith("/real") or any(
        phrase in text for phrase in ("现实日程", "真实日程", "现实提醒", "真实提醒")
    )


def _filter_memories_for_context(memories, request: MessageRequest):
    if request.mode != "rp" or _include_real_state(request):
        return memories
    return [
        memory
        for memory in memories
        if memory.source != "proactive_event" and "out_of_character" not in memory.tags
    ]


def _format_shared_timeline(episodes) -> str:
    if not episodes:
        return "No shared episodes yet."
    lines: list[str] = []
    for episode in episodes:
        tool_scope = "tools=no" if not episode.usable_for_real_world_tools else "tools=yes"
        character = f" character={episode.character_id}" if episode.character_id else ""
        lines.append(
            f"- {episode.occurred_at.isoformat()} [{episode.reality_scope}; {tool_scope}{character}] "
            f"{episode.summary} {episode.character_interpretation}".strip()
        )
    return "\n".join(lines)
